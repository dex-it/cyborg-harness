import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UiContext } from '@cyborg-harness/contracts';
import { inlineHosts, load, openWorkspace, PLUGIN_API_VERSION, type Kernel, type Workspace } from '@cyborg-harness/core';
import legacyPrefs from '../plugins/legacy-prefs/index.ts';
import manifest from '../plugins/legacy-prefs/manifest.json' with { type: 'json' };
import { IMPORTED, readLegacyPrefs, VIEW_MEMORY_MAX } from '../plugins/legacy-prefs/prefs-map.ts';
import { syncLegacyPrefs } from '../plugins/legacy-prefs/ui/prefs.ts';

// PL-06: ключи localStorage окна Cyborg (ai-cyborg e4beb72) -> память видов (`ctx.state`). Значения вымышленные, формы - как их пишет `prefs.ts` окна:
// 10 ключей и 3 семейства (`cyborg.extensions.<флаг>`, `cyborg.search.<флаг>`, `cyborg.tasks.labels:<id>`).
const DUMP: Record<string, string> = {
  'cyborg.fontSize': '16',
  'cyborg.notifications': 'off',
  'cyborg.tasks.assigned': '0',
  'cyborg.tasks.sort': 'created',
  'cyborg.mrs.filter': 'review',
  'cyborg.mrs.sort': 'number',
  'cyborg.search.mode': 'content',
  'cyborg.extensions.tab': 'installed',
  'cyborg.extensions.view': 'project',
  'cyborg.extensions.size': '812,604',
  'cyborg.search.regex': '1',
  'cyborg.search.caseSensitive': '0',
  'cyborg.search.wholeWord': '1',
  'cyborg.extensions.regex': '0',
  'cyborg.extensions.caseSensitive': '1',
  'cyborg.tasks.labels:p-cyborg': '[["bug","+"],["wip","-"]]',
  'cyborg.tasks.labels:p-core': '[["infra","+"]]',
};

const EXPECTED = {
  terminal: { fontSize: 16 },
  notifications: { enabled: false },
  tasks: { assigned: false, sort: 'created', labels: { 'p-cyborg': [['bug', '+'], ['wip', '-']], 'p-core': [['infra', '+']] } },
  mrs: { filter: 'review', sort: 'number' },
  search: { mode: 'content', regex: true, caseSensitive: false, wholeWord: true },
  extensions: { tab: 'installed', view: 'project', size: { width: 812, height: 604 }, regex: false, caseSensitive: true },
};

test('readLegacyPrefs: 10 ключей и 3 семейства раскладываются по видам, значения сверены с исходными', () => {
  const { views, skipped } = readLegacyPrefs(DUMP);
  assert.deepEqual(skipped, []);
  assert.deepEqual(views, EXPECTED);
  // Каждый исходный ключ дал значение: число полей вида (метки считаются по проектам) равно числу ключей.
  const fields = Object.values(views).reduce((n, v) => n + Object.entries(v).reduce((m, [k, x]) => m + (k === 'labels' ? Object.keys(x as object).length : 1), 0), 0);
  assert.equal(fields, Object.keys(DUMP).length);
});

test('readLegacyPrefs: нечитаемое названо в skipped и не попадает в память, чужие ключи молча игнорируются, не-объект даёт пусто', () => {
  const { views, skipped } = readLegacyPrefs({
    'cyborg.fontSize': '99',
    'cyborg.tasks.assigned': 'да',
    'cyborg.search.mode': '',
    'cyborg.search.fuzzy': '1',
    'cyborg.extensions.size': 'широко',
    'cyborg.tasks.labels:p1': '{"не": "список"}',
    'cyborg.tasks.labels:': '[]',
    'cyborg.будущий.ключ': 'x',
    'cyborg.mrs.sort': 5,
    'cyborg.extensions.tab': 'mcp',
    'cyborg.notifications': 'что-то иное',
    'cyborg.extensions.regex': '1',
    'monaco.theme': 'dark',
  });
  assert.deepEqual(views, { extensions: { tab: 'mcp', regex: true }, notifications: { enabled: true } });
  assert.deepEqual(skipped.map((s) => s.key), [
    'cyborg.extensions.size',
    'cyborg.fontSize',
    'cyborg.mrs.sort',
    'cyborg.search.fuzzy',
    'cyborg.search.mode',
    'cyborg.tasks.assigned',
    'cyborg.tasks.labels:',
    'cyborg.tasks.labels:p1',
    'cyborg.будущий.ключ',
  ]);
  assert.deepEqual(readLegacyPrefs(null), { views: {}, skipped: [] });
  assert.deepEqual(readLegacyPrefs({ 'cyborg.extensions.size': '' }), { views: {}, skipped: [] }, 'пустой размер - сброс окна, переносить нечего');
});

test('readLegacyPrefs: фильтры меток сверх памяти вида не пропадают молча - названы в skipped, остальное перенесено', () => {
  const dump: Record<string, string> = { 'cyborg.tasks.sort': 'updated' };
  const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => [`метка-${String(i).padStart(4, '0')}-${'x'.repeat(30)}`, '+']));
  for (const id of ['a', 'b', 'c']) dump[`cyborg.tasks.labels:${id}`] = big;
  const { views, skipped } = readLegacyPrefs(dump);
  assert.ok(new TextEncoder().encode(JSON.stringify(views.tasks)).length < VIEW_MEMORY_MAX);
  assert.deepEqual(Object.keys((views.tasks as { labels: object }).labels), ['a', 'b']);
  assert.deepEqual(skipped, [{ key: 'cyborg.tasks.labels:c', reason: 'память вида больше 64 КБ' }]);
  assert.equal((views.tasks as { sort: string }).sort, 'updated');
});

// ---- плагин на ядре: главная часть, виды, state воркспейса в файле ----

interface Rig {
  readonly root: string;
  readonly k: Kernel;
  ws: Workspace;
  /** Вид как его видит `ctx`: память и команды идут в ядро, канал - из `onViewMessage`. */
  view(name: string): { ctx: Pick<UiContext, 'view' | 'commands' | 'state' | 'channel'>; push(message: unknown): void; writes: unknown[] };
}

async function startRig(root: string): Promise<Rig> {
  const opened = await openWorkspace({ file: path.join(root, 'w.cyborg.json'), userFile: path.join(root, 'user', 'cyborg.json'), stateDir: path.join(root, 'state') });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  const listeners = new Map<string, (message: unknown) => void>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => legacyPrefs),
    enabled: ['legacy-prefs'],
    manifests: [manifest],
    config: ws.config,
    state: ws.state,
    onViewMessage: (_plugin, view, message) => listeners.get(view)?.(message),
  });
  const rig: Rig = {
    root,
    k,
    ws,
    view(name) {
      const writes: unknown[] = [];
      const ctx = {
        view: name,
        commands: { run: (command: string, ...args: unknown[]) => k.runOwn('legacy-prefs', command, ...args) },
        state: {
          get value() {
            return k.viewState('legacy-prefs', name);
          },
          set: (value: unknown) => (writes.push(value), k.setViewState('legacy-prefs', name, value)),
        },
        channel: { post: () => Promise.resolve(), onMessage: (fn: (message: unknown) => void) => (listeners.set(name, fn), { dispose: () => void listeners.delete(name) }) },
      };
      return { ctx, push: (m) => listeners.get(name)?.(m), writes };
    },
  };
  return rig;
}

async function stop(rig: Rig): Promise<void> {
  await rig.k.unload();
  rig.ws.close();
}

const stateDoc = async (rig: Rig): Promise<Record<string, unknown>> => JSON.parse(await readFile(rig.ws.stateFile, 'utf8')) as Record<string, unknown>;

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pl06-prefs-')));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('перенос в память видов: вид забирает своё при открытии, значения в state воркспейса равны исходным, повтор ничего не пишет', async () => {
  await withRoot(async (root) => {
    const rig = await startRig(root);
    const reply = (await rig.k.run('legacy-prefs.import', DUMP)) as { views: string[]; skipped: unknown[] };
    assert.deepEqual(reply.views.toSorted(), Object.keys(EXPECTED).toSorted());
    assert.deepEqual(reply.skipped, []);

    for (const name of Object.keys(EXPECTED)) {
      const view = rig.view(name);
      const sync = syncLegacyPrefs(view.ctx);
      await sync.done;
      sync.subscription.dispose();
      assert.deepEqual(view.writes, [{ ...EXPECTED[name as keyof typeof EXPECTED], [IMPORTED]: true }], `вид ${name}`);
    }
    await rig.k.idle();
    const views = (await stateDoc(rig)).$views as Record<string, unknown>;
    for (const [name, expected] of Object.entries(EXPECTED)) assert.deepEqual(views[`legacy-prefs/${name}`], { ...expected, [IMPORTED]: true });

    // Старое окно отдало те же ключи ещё раз (например, при следующем запуске): метка стоит, память видов не меняется и не пишется.
    const before = await readFile(rig.ws.stateFile, 'utf8');
    await rig.k.run('legacy-prefs.import', DUMP);
    for (const name of Object.keys(EXPECTED)) {
      const view = rig.view(name);
      const sync = syncLegacyPrefs(view.ctx);
      await sync.done;
      sync.subscription.dispose();
      assert.deepEqual(view.writes, [], `вид ${name} записал память при повторном переносе`);
    }
    assert.equal(await readFile(rig.ws.stateFile, 'utf8'), before);
    await stop(rig);

    // Новый запуск: память видов пережила перезапуск ядра и воркспейса.
    const second = await startRig(root);
    assert.deepEqual(second.k.viewState('legacy-prefs', 'tasks'), { ...EXPECTED.tasks, [IMPORTED]: true });
    await stop(second);
  });
});

test('перенос в память видов: открытый вид получает толчок канала, правка человека после переноса переживает повторную отдачу, значение человека до переноса сильнее', async () => {
  await withRoot(async (root) => {
    const rig = await startRig(root);
    const mrs = rig.view('mrs');
    const open = syncLegacyPrefs(mrs.ctx);
    await open.done;
    assert.deepEqual(mrs.writes, [], 'переносить нечего: команда pending пуста');
    // Человек уже выбрал сортировку в новом окне, потом пришёл перенос: его выбор сильнее, недостающее добирается.
    await mrs.ctx.state.set({ sort: 'updated' });
    mrs.writes.length = 0;
    await rig.k.run('legacy-prefs.import', DUMP);
    await rig.k.idle();
    await waitForWrite(mrs.writes);
    assert.deepEqual(rig.k.viewState('legacy-prefs', 'mrs'), { sort: 'updated', filter: 'review', [IMPORTED]: true });

    await mrs.ctx.state.set({ ...(rig.k.viewState('legacy-prefs', 'mrs') as object), filter: 'all' });
    await rig.k.run('legacy-prefs.import', DUMP);
    await rig.k.idle();
    const again = syncLegacyPrefs(rig.view('mrs').ctx);
    await again.done;
    assert.equal((rig.k.viewState('legacy-prefs', 'mrs') as { filter: string }).filter, 'all', 'повторная отдача затёрла выбор человека');
    open.subscription.dispose();
    again.subscription.dispose();
    await stop(rig);
  });
});

const waitForWrite = async (writes: unknown[]): Promise<void> => {
  for (let i = 0; i < 100 && writes.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(writes.length > 0, 'толчок канала не дошёл до вида');
};
