import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { keyOfInput, normalizeKey, resolveKey } from '../src/keys.ts';
import { load, type JournalEntry, type LoadOptions } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import type { OsEnvironment } from '../src/os-gateway.ts';
import type { PluginModule } from '../src/plugin.ts';
import { pluginStatuses } from '../src/status.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { waitFor } from './wait-for.ts';
import { WINDOW_OWNER } from '../src/window-layer.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import type { Subscription } from '@cyborg-harness/contracts';

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'test.feed': { 1: { onEvent(listener: () => void): Subscription } };
    'test.owner': { 1: { ping(): string } };
  }
}

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

function kernel(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>) {
  const spawned: string[] = [];
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  return {
    spawned,
    start: () =>
      load({
        apiVersion: PLUGIN_API_VERSION,
        spawnHost: (id) => {
          spawned.push(id);
          return base(id);
        },
        ...options,
      }),
  };
}

const lines = (journal: readonly JournalEntry[], from = 0) =>
  journal.slice(from).map((e) => (e.kind === 'unloaded' ? `${e.pluginId}:unloaded:${e.by}` : `${e.pluginId ?? '-'}:${e.kind}`));

const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

const files: PluginModule = { activate: (ctx) => ctx.contracts.provide('test.files', '1.0', { read: (p: string) => p }) };
const idle: PluginModule = { activate: () => undefined };

test('ST-1005/3, ST-1005/4: disable: требующие выгружаются вместе с поставщиком, необязательный остаётся; enable поднимает их в порядке графа', async () => {
  let changes = 0;
  const { start, spawned } = kernel(
    {
      files,
      editor: idle,
      preview: idle,
      tabs: {
        activate(ctx) {
          ctx.contracts.onChange('test.files', () => changes++);
          return undefined;
        },
      },
    },
    {
      enabled: ['files', 'editor', 'preview', 'tabs'],
      manifests: [
        manifest('files', { provides: { 'test.files': '1.0' } }),
        manifest('editor', { requires: { 'test.files': '^1' }, provides: { 'test.tab': '1.0' } }),
        manifest('preview', { requires: { 'test.tab': '^1' } }),
        manifest('tabs', { optional: { 'test.files': '^1' } }),
      ],
      hosts: { f: ['files'], ui: ['editor', 'preview', 'tabs'] },
      bundled: ['files', 'editor', 'preview', 'tabs'],
    },
  );
  const k = await start();
  const mark = k.journal.length;
  await k.disable('files');
  assert.deepEqual(lines(k.journal, mark), ['preview:unloaded:files', 'editor:unloaded:files', 'files:unloaded:files']);
  assert.deepEqual(k.active, ['tabs']);
  await settle();
  assert.equal(changes, 1);

  const states = pluginStatuses(k.journal).map((s) => `${s.id}:${s.state}:${s.revivable ? 'R' : '-'}`);
  assert.deepEqual(states, ['files:stopped:R', 'editor:stopped:-', 'preview:stopped:-', 'tabs:active:-']);

  await k.enable('files');
  assert.deepEqual(k.active, ['tabs', 'files', 'editor', 'preview']);
  await settle();
  assert.equal(changes, 2);
  assert.deepEqual(spawned, ['f', 'ui', 'f'], 'хост files погашен пустым и поднят заново, ui жил всё время');
  await k.unload();
});

test('ST-1005/5: disable: выключенного человеком enable соседа не поднимает', async () => {
  const { start } = kernel({ files, reader: idle }, {
    enabled: ['files', 'reader'],
    manifests: [manifest('files', { provides: { 'test.files': '1.0' } }), manifest('reader', { requires: { 'test.files': '^1' } })],
  });
  const k = await start();
  await k.disable('files');
  await k.enable('reader');
  assert.deepEqual(k.active, []);
  assert.equal(k.journal.at(-1)?.kind, 'skipped');
  await k.enable('files');
  assert.deepEqual(k.active, ['files', 'reader']);
  await assert.rejects(k.disable('nobody'), { code: 'Unavailable' });
  await k.unload();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function closedServer(url: string): Promise<boolean> {
  return waitFor(`сервер ${url} закрыт`, () =>
    fetch(url, { method: 'POST' }).then(
      () => false,
      () => true,
    ),
  );
}

const DROPS = { disable: 'выгрузка', crash: 'падение хоста', abandon: 'падение хоста сверх лимита', throw: 'сорванная активация' } as const;

for (const how of ['disable', 'crash', 'abandon', 'throw'] as const) {
  test(`ST-1005/1: ${DROPS[how]} снимает контракт, команду, подписку, сочетание, наблюдение, сервер, диалог, программу с потомками и запрос`, { skip: process.platform === 'win32' && 'группы процессов - POSIX' }, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-drop-')));
    const pidFile = path.join(root, 'pids');
    const watchers: { closed: boolean }[] = [];
    const watch = (() => {
      const w = Object.assign(new EventEmitter(), { closed: false, close: () => void (w.closed = true) });
      watchers.push(w);
      return w as unknown as FSWatcher;
    }) as unknown as NonNullable<OsEnvironment['watch']>;
    const signals: AbortSignal[] = [];
    const hanging = ((_url: URL, init: RequestInit) =>
      new Promise((_, reject) => {
        const signal = init.signal!;
        signals.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      })) as unknown as typeof fetch;
    const handles = new Map<string, HostHandle>();
    const listeners = new Set<() => void>();
    let activations = 0;
    let url = '';
    const table: Record<string, PluginModule> = {
      feed: {
        activate(ctx) {
          ctx.contracts.provide('test.feed', '1.0', {
            onEvent(listener: () => void) {
              listeners.add(listener);
              return { dispose: () => void listeners.delete(listener) };
            },
          });
          ctx.commands.register('feed.count', () => listeners.size);
          return undefined;
        },
      },
      reader: idle,
      owner: {
        async activate(ctx) {
          if (activations++ > 0) return undefined;
          ctx.contracts.provide('test.owner', '1.0', { ping: () => 'pong' });
          ctx.commands.register('owner.cmd', () => 'cmd');
          await ctx.contracts.get('test.feed', 1)!.onEvent(() => undefined);
          await ctx.keys.register({ key: 'ctrl+shift+9', command: 'owner.cmd' });
          await ctx.os.fs.watch(root, () => undefined);
          url = (await ctx.os.serve!.http(() => ({ status: 204 }))).url;
          void ctx.dialogs.show({ kind: 'ask', title: 'Вопрос', buttons: [{ id: 'yes', label: 'Да' }] }).catch(() => undefined);
          void ctx.os.process!.run('/bin/sh', ['-c', `sleep 30 & echo "$$ $!" > ${pidFile}; wait`]).catch(() => undefined);
          void ctx.os.net!.fetch('https://api.example.com/').catch(() => undefined);
          await waitFor('pid программы и потомка', async () => /^\d+ \d+\n$/.test(await readFile(pidFile, 'utf8').catch(() => '')));
          if (how === 'throw') throw new Error('сбой активации');
          return undefined;
        },
      },
    };
    const ids = ['feed', 'owner', 'reader'];
    const base = inlineHosts(async (entry) => table[entry]!);
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ids,
      manifests: [
        manifest('feed', { provides: { 'test.feed': '1.0' }, commands: ['feed.count'] }),
        manifest('owner', {
          provides: { 'test.owner': '1.0' },
          optional: { 'test.feed': '^1' },
          commands: ['owner.cmd'],
          permissions: { 'fs.read': [root], serve: true, net: ['api.example.com'], process: [{ program: '/bin/sh', args: ['-c'] }] },
        }),
        manifest('reader', { optional: { 'test.owner': '^1' } }),
      ],
      bundled: ids,
      hosts: { f: ['feed'], own: ['owner'], r: ['reader'] },
      os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), watch, fetch: hanging },
      ...(how === 'abandon' && { watchdog: { strikes: 1 } }),
      spawnHost: (id) => {
        const handle = base(id);
        handles.set(id, handle);
        return handle;
      },
    });
    const pids = (await readFile(pidFile, 'utf8')).trim().split(' ').map(Number);
    try {
      if (how !== 'throw') {
        assert.ok(k.contracts.get('reader', 'test.owner', 1));
        assert.equal(await k.run('owner.cmd'), 'cmd');
        assert.equal(await k.run('feed.count'), 1);
        assert.equal(k.keybinding('Ctrl+Shift+9')?.pluginId, 'owner');
        assert.ok(k.window.dialog);
        assert.deepEqual(watchers.map((w) => w.closed), [false]);
        assert.equal(signals[0]?.aborted, false);
      }
      if (how === 'disable') {
        await k.disable('owner');
      } else if (how === 'crash') {
        handles.get('own')!.kill();
        await k.idle();
        assert.ok(k.journal.some((e) => e.kind === 'host-restart' && e.hostId === 'own'), 'хост поднят заново');
        assert.ok(k.active.includes('owner'), 'плагин вернулся без регистраций');
      } else if (how === 'abandon') {
        handles.get('own')!.kill();
        await k.idle();
        assert.equal(k.journal.at(-1)?.kind, 'host-abandoned');
        assert.equal(k.active.includes('owner'), false);
      } else {
        assert.equal(k.journal.find((e) => e.pluginId === 'owner' && e.kind === 'failed')?.kind, 'failed');
      }
      await settle();
      assert.equal(k.contracts.get('reader', 'test.owner', 1), undefined, 'контракт');
      await assert.rejects(k.run('owner.cmd'), { code: 'CommandNotFound' }, 'команда');
      assert.equal(await k.run('feed.count'), 0, 'подписка у поставщика');
      assert.equal(k.keybindings.some((b) => b.pluginId === 'owner'), false, 'сочетание');
      assert.deepEqual(watchers.map((w) => w.closed), [true], 'наблюдение');
      assert.ok(await closedServer(url), 'сервер');
      assert.equal(k.window.dialog, undefined, 'диалог');
      await waitFor('программа и её потомок завершены', () => pids.every((pid) => !alive(pid)));
      assert.equal(signals.length, 1);
      assert.ok(signals[0]?.aborted, 'запрос оборван');
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await k.unload();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('run: команда плагина, который сейчас поднимает enable, ждёт его активации', async () => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let slow = false;
  const { start } = kernel(
    {
      tool: {
        async activate(ctx) {
          if (slow) await gate;
          ctx.commands.register('tool.go', () => 'готово');
          return undefined;
        },
      },
    },
    { enabled: ['tool'], manifests: [manifest('tool', { commands: ['tool.go'] })] },
  );
  const k = await start();
  await k.disable('tool');
  slow = true;
  const enabled = k.enable('tool');
  await settle();
  const ran = k.run('tool.go');
  open();
  assert.equal(await ran, 'готово');
  await enabled;
  await k.unload();
});

test('сочетания клавиш: запись, платформа, нажатие', () => {
  assert.equal(normalizeKey('shift+cmdorctrl+k'), 'CmdOrCtrl+Shift+K');
  assert.equal(normalizeKey('Control+Option+Up'), 'Ctrl+Alt+Up');
  assert.equal(normalizeKey('F5'), 'F5');
  assert.equal(normalizeKey('K'), undefined, 'одиночная буква перехватила бы набор текста');
  assert.equal(normalizeKey('Ctrl+Ctrl+K'), undefined);
  assert.equal(normalizeKey('Hyper+K'), undefined);
  assert.equal(resolveKey('CmdOrCtrl+Shift+K', 'linux'), 'Ctrl+Shift+K');
  assert.equal(resolveKey('CmdOrCtrl+Shift+K', 'darwin'), 'Shift+Meta+K');
  assert.equal(keyOfInput({ key: 'K', control: true, alt: false, shift: true, meta: false }), 'Ctrl+Shift+K');
  assert.equal(keyOfInput({ key: '!', code: 'Digit1', control: true, alt: false, shift: true, meta: false }), 'Ctrl+Shift+1');
  assert.equal(keyOfInput({ key: 'Control', control: true, alt: false, shift: false, meta: false }), undefined);
});

test('манифест: сочетание - на свою команду без обязательных аргументов', () => {
  const problem = (fields: Record<string, unknown>) => {
    const r = parseManifest(manifest('pad', { commands: { 'pad.open': {}, 'pad.say': { args: ['string'] } }, ...fields }));
    return r.ok ? '' : r.errors.join('\n');
  };
  const ok = parseManifest(manifest('pad', { commands: { 'pad.open': {} }, keybindings: [{ key: 'ctrl+shift+o', command: 'pad.open' }] }));
  assert.deepEqual(ok.ok && ok.manifest.keybindings, [{ key: 'Ctrl+Shift+O', command: 'pad.open' }]);
  assert.match(problem({ keybindings: [{ key: 'O', command: 'pad.open' }] }), /не разобрано/);
  assert.match(problem({ keybindings: [{ key: 'F2', command: 'other.open' }] }), /не объявлена/);
  assert.match(problem({ keybindings: [{ key: 'F2', command: 'pad.say' }] }), /обязательные аргументы/);
  assert.match(problem({ keybindings: [{ key: 'F2', command: 'pad.open' }, { key: 'f2', command: 'pad.open' }] }), /повторяется/);
});

test('ST-2002/4: plugins.keybindings: выбор пользователя перекрывает манифесты, null отдаёт сочетание окну, неверное - в журнал', async () => {
  const pad = (id: string): PluginModule => ({ activate: (ctx) => ctx.commands.register(`${id}.go`, () => id) });
  const keyed = (id: string, key: string) => manifest(id, { commands: [`${id}.go`, `${id}.alt`], keybindings: [{ key, command: `${id}.go` }] });
  const { start } = kernel(
    { alpha: pad('alpha'), zeta: pad('zeta') },
    {
      enabled: ['alpha', 'zeta'],
      manifests: [keyed('alpha', 'Ctrl+K'), keyed('zeta', 'Ctrl+K'), keyed('beta', 'F5')],
      platform: 'linux',
      keybindings: [
        { key: 'cmdorctrl+k', command: 'zeta.go' },
        { key: 'F5', command: null },
        { key: 'F6', command: 'alpha.alt' },
        { key: 'K', command: 'alpha.go' },
        { key: 'F7', command: 'nobody.go' },
      ],
    },
  );
  const k = await start();
  assert.deepEqual(
    k.keybindings.filter((b) => b.pluginId !== WINDOW_OWNER).map((b) => [b.key, b.command, b.user ?? false, b.shadowed.map((x) => x.command)]),
    [
      ['F6', 'alpha.alt', true, ['cyborg.window.focus-next']],
      ['Ctrl+K', 'zeta.go', true, ['alpha.go']],
    ],
  );
  assert.equal(k.keybinding('F5'), undefined, 'освобождённое сочетание осталось у плагина');
  assert.deepEqual(
    k.journal.flatMap((e) => (e.kind === 'key-ignored' ? [`${e.key}:${e.reason}`] : [])),
    ['K:сочетание не разобрано', 'F7:команды нет ни у одного плагина'],
  );
  await k.unload();
});

test('ST-2002/4: конфликт сочетаний: встроенный побеждает сторонний, между равными - первый по id; нажатие идёт активному владельцу', async () => {
  const pad = (id: string): PluginModule => ({ activate: (ctx) => ctx.commands.register(`${id}.go`, () => id) });
  const keyed = (id: string, key: string) => manifest(id, { commands: [`${id}.go`], keybindings: [{ key, command: `${id}.go` }] });
  const { start } = kernel(
    { zeta: pad('zeta'), alpha: pad('alpha'), mallory: pad('mallory') },
    {
      enabled: ['zeta', 'alpha', 'mallory'],
      manifests: [keyed('mallory', 'CmdOrCtrl+K'), keyed('zeta', 'Ctrl+K'), keyed('alpha', 'CmdOrCtrl+K')],
      bundled: ['zeta', 'alpha'],
      platform: 'linux',
    },
  );
  const k = await start();
  const conflicts = k.journal.flatMap((e) => (e.kind === 'key-conflict' ? [`${e.pluginId}->${e.winner}`] : []));
  assert.deepEqual(conflicts, ['zeta->alpha', 'mallory->alpha']);
  assert.deepEqual(k.keybindings.filter((b) => b.pluginId !== WINDOW_OWNER), [{ key: 'Ctrl+K', command: 'alpha.go', pluginId: 'alpha', shadowed: [{ pluginId: 'zeta', command: 'zeta.go' }, { pluginId: 'mallory', command: 'mallory.go' }] }]);
  assert.equal(k.keybinding('Ctrl+K')?.command, 'alpha.go');
  assert.deepEqual(
    pluginStatuses(k.journal).map((s) => s.state),
    ['active', 'active', 'active'],
    'конфликт сочетаний плагин не выключает',
  );
  await k.disable('alpha');
  assert.equal(k.keybinding('Ctrl+K'), undefined, 'выгруженный владелец нажатие не получает');
  await k.unload();
});
