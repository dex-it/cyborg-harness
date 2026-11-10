import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg-harness/contracts';
import { memoryStore as memory } from '../../testing/src/memory.ts';
import { SectionStore } from '../src/config.ts';
import { toDisposable } from '../src/disposable.ts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { describeEntry, entryLevel, pluginStatuses } from '../src/status.ts';
import { startCancel } from './fixtures/cancel.ts';
import { waitFor } from './wait-for.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

function kernel(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>) {
  return load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => {
      const mod = table[entry];
      if (!mod) throw new Error(`нет модуля ${entry}`);
      return mod;
    }),
    ...options,
  });
}

const kinds = (k: { journal: readonly { pluginId?: string | undefined; kind: string }[] }) => k.journal.map((e) => `${e.pluginId ?? '-'}:${e.kind}`);

test('активация по графу, вызов чужого контракта через ядро, снятие в обратном порядке', async () => {
  const events: string[] = [];
  const k = await kernel(
    {
      files: {
        activate(ctx) {
          events.push('files:up');
          ctx.contracts.provide('test.files', '1.0', { root: '/w', read: async (p: string) => `data:${p}` });
          return toDisposable(() => events.push('files:down'));
        },
      },
      sessions: {
        async activate(ctx) {
          const api = ctx.contracts.get('test.files', 1)!;
          events.push(`sessions:${api.root ?? ''}:${(await api.read?.('a')) ?? ''}`);
          ctx.subscriptions.add(toDisposable(() => events.push('sessions:down')));
        },
      },
    },
    {
      enabled: ['sessions', 'files'],
      manifests: [manifest('sessions', { requires: { 'test.files': '^1' } }), manifest('files', { provides: { 'test.files': '1.0' } })],
      hosts: { one: ['files'], two: ['sessions'] },
    },
  );
  assert.deepEqual(k.active, ['files', 'sessions']);
  assert.deepEqual([k.hostOf('files'), k.hostOf('sessions')], ['one', 'two']);
  await k.unload();
  assert.deepEqual(events, ['files:up', 'sessions:/w:data:a', 'sessions:down', 'files:down']);
});

test('журнал: невалидный, выключенный, не найденный, отказ графа, сбой и пропуск зависимого', async () => {
  const k = await kernel(
    { files: { activate() { throw new Error('диск недоступен'); } }, sessions: { activate() {} } },
    {
      enabled: ['files', 'sessions', 'ghost', 'broken', 'lonely'],
      manifests: [
        { id: 'broken' },
        manifest('extra'),
        manifest('files', { provides: { 'test.files': '1.0' } }),
        manifest('sessions', { requires: { 'test.files': '^1' } }),
        manifest('lonely', { requires: { 'test.nobody': '^1' } }),
      ],
    },
  );
  assert.deepEqual(kinds(k), ['broken:invalid', 'extra:disabled', 'ghost:not-found', 'lonely:rejected', 'files:failed', 'sessions:skipped']);
  assert.deepEqual(k.active, []);
  await k.unload();
});

test('сбой активации снимает уже отданное плагином', async () => {
  const k = await kernel(
    {
      files: {
        activate(ctx) {
          ctx.contracts.provide('test.files', '1.0', {});
          throw new Error('после provide');
        },
      },
      tree: { activate() {} },
    },
    {
      enabled: ['files', 'tree'],
      manifests: [manifest('files', { provides: { 'test.files': '1.0' } }), manifest('tree', { optional: { 'test.files': '^1' } })],
    },
  );
  assert.deepEqual(k.active, ['tree']);
  assert.equal(k.contracts.get('tree', 'test.files', 1), undefined);
  await k.unload();
});

test('команды: запуск из ядра и из другого плагина, необъявленная команда отклоняется', async () => {
  const k = await kernel(
    {
      lock: { activate: (ctx) => void ctx.commands.register('lock.now', (reason) => `locked:${String(reason)}`) },
      menu: {
        activate(ctx) {
          assert.throws(() => ctx.commands.register('lock.now', () => 0), { code: 'NotDeclared' });
          ctx.commands.register('menu.press', () => ctx.commands.run('lock.now', 'menu'));
        },
      },
    },
    { enabled: ['lock', 'menu'], manifests: [manifest('lock', { commands: { 'lock.now': { args: ['string'], callers: 'plugins' } } }), manifest('menu', { commands: ['menu.press'] })] },
  );
  assert.equal(await k.run('lock.now', 'idle'), 'locked:idle');
  assert.equal(await k.run('menu.press'), 'locked:menu');
  await assert.rejects(k.run('lock.nope'), { code: 'CommandNotFound' });
  await k.unload();
});

test('функция в результате контракта - NotCloneable у вызывающего', async () => {
  let error: unknown;
  const k = await kernel(
    {
      clock: {
        activate(ctx) {
          ctx.contracts.provide('test.clock', '1.0', { tick: async () => () => 0 });
        },
      },
      user: {
        async activate(ctx) {
          await ctx.contracts.get('test.clock', 1)!.tick().catch((e: unknown) => {
            error = e;
          });
        },
      },
    },
    {
      enabled: ['clock', 'user'],
      manifests: [manifest('clock', { provides: { 'test.clock': '1.0' } }), manifest('user', { requires: { 'test.clock': '^1' } })],
    },
  );
  assert.equal((error as { code: string }).code, 'NotCloneable');
  await k.unload();
});

test('битый манифест невключённого плагина - disabled, а не invalid', async () => {
  const k = await kernel({}, { enabled: [], manifests: [{ id: 'old', version: 'latest' }] });
  assert.deepEqual(k.journal, [{ pluginId: 'old', kind: 'disabled' }]);
});

test('манифест с полем новой версии API - в журнале причина версия, а не поле', async () => {
  const k = await kernel({}, { enabled: ['next', 'typo'], manifests: [manifest('next', { engines: { cyborg: '^1.3' }, layout: {} }), manifest('typo', { keybinding: [] })] });
  assert.deepEqual(k.journal, [
    { pluginId: 'next', kind: 'invalid', errors: [`engines.cyborg: нужен API Cyborg ^1.3, есть ${PLUGIN_API_VERSION}`] },
    { pluginId: 'typo', kind: 'invalid', errors: ['keybinding: незнакомое поле манифеста'] },
  ]);
});

test('хуки: граф до кода, журнал по ходу, лог с id плагина, снятие в журнале', async () => {
  const seen: string[] = [];
  const k = await kernel(
    {
      a: {
        activate(ctx) {
          ctx.log('привет');
        },
      },
    },
    {
      enabled: ['a'],
      manifests: [manifest('a')],
      onGraph: async (g) => void seen.push(`graph:${g.order.join()}`),
      onJournal: (e) => void seen.push(`journal:${e.kind}`),
      onLog: (id, message) => void seen.push(`log:${id}:${message}`),
    },
  );
  await k.unload();
  assert.deepEqual(seen, ['graph:a', 'log:a:привет', 'journal:activated', 'journal:deactivated']);
});

test('безопасный режим не запускает хосты', async () => {
  let spawned = false;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['a'],
    manifests: [manifest('a')],
    safeMode: true,
    spawnHost: () => {
      spawned = true;
      throw new Error('не должен');
    },
  });
  assert.equal(spawned, false);
  assert.deepEqual(k.journal, [{ pluginId: 'a', kind: 'safe-mode' }]);
});

test('откат версии плагина: раздел config новее манифеста - плагин не активируется, данные целы', async () => {
  const { docs, store } = memory({ user: { 'pin-lock': { $version: 3, minutes: 5 } } });
  const k = await kernel(
    { 'pin-lock': { config: { migrate: (_, d) => d }, activate() {} } },
    { enabled: ['pin-lock'], manifests: [manifest('pin-lock', { config: { version: 2 } })], config: await SectionStore.open(store, ['user', 'workspace']) },
  );
  assert.deepEqual(k.active, []);
  assert.deepEqual(k.journal, [{ pluginId: 'pin-lock', kind: 'config', result: { status: 'newer', layer: 'user', found: 3, expected: 2 } }]);
  assert.deepEqual(docs.get('user'), { 'pin-lock': { $version: 3, minutes: 5 } });
  await k.unload();
});

test('миграция config идёт в хосте, ядро записывает итог; set плагина доходит до слоя', async () => {
  const { docs, store } = memory({ user: { 'pin-lock': { idle: 5 } } });
  let seen: unknown;
  const k = await kernel(
    {
      'pin-lock': {
        config: { defaults: { sound: false }, migrate: (_, d) => ({ minutes: d.idle }) },
        activate(ctx) {
          seen = ctx.config?.get();
          ctx.commands.register('pin-lock.mute', () => ctx.config!.set('workspace', { sound: false, minutes: 1 }));
        },
      },
    },
    {
      enabled: ['pin-lock'],
      manifests: [manifest('pin-lock', { config: { version: 2 }, commands: ['pin-lock.mute'] })],
      config: await SectionStore.open(store, ['user', 'workspace']),
    },
  );
  assert.deepEqual(seen, { sound: false, minutes: 5 });
  assert.deepEqual(docs.get('user'), { 'pin-lock': { $version: 2, minutes: 5 } });
  assert.deepEqual(await k.run('pin-lock.mute'), { sound: false, minutes: 1 });
  assert.deepEqual(docs.get('workspace'), { 'pin-lock': { $version: 2, sound: false, minutes: 1 } });
  await k.unload();
});

test('хост упал без виновника: журнал называет задетых через consumes, хост поднимается, после лимита брошен', async () => {
  const handles = new Map<string, HostHandle>();
  const spawn = inlineHosts(async (entry) => ({
    activate(ctx) {
      if (entry === 'editor') ctx.contracts.provide('test.tab', '1.0', { kind: 'редактор' });
    },
  }));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['editor', 'tabs'],
    manifests: [manifest('editor', { provides: { 'test.tab': '1.0' } }), manifest('tabs', { consumes: { 'test.tab': '^1' } })],
    hosts: { one: ['editor'], two: ['tabs'] },
    watchdog: { strikes: 2 },
    spawnHost: (id) => {
      const handle = spawn(id);
      handles.set(id, handle);
      return handle;
    },
  });
  handles.get('one')!.kill();
  await k.idle();
  handles.get('one')!.kill();
  await k.idle();
  const host = k.journal.filter((e) => e.pluginId === undefined).map((e) => (e.kind === 'host-down' ? `${e.kind}:${e.culprits.join()}:${e.affects.join()}` : e.kind));
  assert.deepEqual(host, ['host-down::tabs', 'host-restart', 'host-down::tabs', 'host-abandoned']);
  assert.deepEqual(k.active, ['tabs']);
  await k.unload();
});

test('«Включить снова»: не поднявшийся плагин и потребитель следом, затем выключенный сторожем', async () => {
  const handles = new Map<string, HostHandle>();
  let broken = true;
  const spawn = inlineHosts(async (entry) =>
    entry === 'flaky'
      ? {
          activate(ctx) {
            if (broken) throw new Error('нет диска');
            ctx.contracts.provide('test.flaky', '1.0', {});
            ctx.commands.register('flaky.hang', () => new Promise(() => {}));
          },
        }
      : { activate: () => {} },
  );
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['flaky', 'user'],
    manifests: [manifest('flaky', { provides: { 'test.flaky': '1.0' }, commands: ['flaky.hang'] }), manifest('user', { requires: { 'test.flaky': '^1' } })],
    hosts: { one: ['flaky'], two: ['user'] },
    watchdog: { strikes: 1 },
    spawnHost: (id) => {
      const handle = spawn(id);
      handles.set(id, handle);
      return handle;
    },
  });
  assert.deepEqual(k.active, []);
  broken = false;
  await k.enable('flaky');
  assert.deepEqual(k.active, ['flaky', 'user']);

  void k.run('flaky.hang').catch(() => {});
  await new Promise((r) => setImmediate(r));
  handles.get('one')!.kill();
  await k.idle();
  assert.equal(k.journal.at(-1)?.kind, 'switched-off');
  assert.deepEqual(k.active, ['user']);
  await k.enable('flaky');
  assert.deepEqual(k.active, ['user', 'flaky']);
  await assert.rejects(k.enable('nobody'), /не загружается/);
  assert.deepEqual(
    k.manifests.map((m) => m.id),
    ['flaky', 'user'],
  );
  await k.unload();
});

test('пространство поставки: отказ стороннему поставщику идёт в журнал, без bundled проверки нет', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const table = { claude: noop, rogue: noop, sessions: noop };
  const options = {
    enabled: Object.keys(table),
    manifests: [manifest('claude', { provides: { 'cyborg.agent': '1.0' } }), manifest('rogue', { provides: { 'cyborg.agent': '1.0' } }), manifest('sessions', { requires: { 'cyborg.agent': '^1' } })],
    reservedPrefixes: ['cyborg.'],
  };
  const k = await kernel(table, { ...options, bundled: ['claude', 'sessions'] });
  assert.deepEqual(k.active, ['claude', 'sessions']);
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'rejected'),
    [{ pluginId: 'rogue', kind: 'rejected', reasons: [{ kind: 'reserved', what: 'provides', name: 'cyborg.agent', prefix: 'cyborg.' }] }],
  );
  await k.unload();
  const open = await kernel(table, options);
  assert.deepEqual(open.active, ['claude', 'rogue']);
  await open.unload();
});

// K-04: группы рендера - origin и процесс рендера на группу; граница доверия видов - группа, поэтому сторонний не делит её ни с кем.
test('группы рендера: ui.group - рекомендация, plugins.uiGroups её перекрывает, без группы - id плагина, без ui группы нет', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const view = (group?: string) => ({ ui: { views: { main: './ui.js' }, ...(group !== undefined && { group }) } });
  const ids = ['a', 'b', 'c', 'd', 'e', 'logic'];
  const k = await kernel(Object.fromEntries(ids.map((id) => [id, noop])), {
    enabled: ids,
    manifests: [manifest('a', view('panels')), manifest('b', view('panels')), manifest('c', view('panels')), manifest('d', view()), manifest('e', view('panels')), manifest('logic')],
    bundled: ids,
    uiGroups: { solo: ['c'], tools: ['d', 'e'] },
  });
  assert.deepEqual(
    ids.map((id) => [id, k.groupOf(id)]),
    [
      ['a', 'panels'],
      ['b', 'panels'],
      ['c', 'solo'],
      ['d', 'tools'],
      ['e', 'tools'],
      ['logic', undefined],
    ],
  );
  assert.equal(k.groupOf('nobody'), undefined);
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'group-isolated'),
    [],
  );
  await k.unload();
  const plain = await kernel({ a: noop, b: noop }, { enabled: ['a', 'b'], manifests: [manifest('a', view()), manifest('b', view())], bundled: ['a', 'b'] });
  assert.deepEqual([plain.groupOf('a'), plain.groupOf('b')], ['a', 'b'], 'без группы - своя, по id плагина');
  await plain.unload();
});

test('группы рендера: сторонний всегда один в своей группе, запись group-isolated только если ему было с кем делить', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const view = (group?: string) => ({ ui: { views: { main: './ui.js' }, ...(group !== undefined && { group }) } });
  const ids = ['files', 'tree', 'x', 'y', 'z', 'w'];
  const k = await kernel(Object.fromEntries(ids.map((id) => [id, noop])), {
    enabled: ids,
    // x просит группу tools из конфига пользователя, y - из своего манифеста, z называет id плагина поставки, а не группу, w просит группу, где он один: делить обоим нечего.
    manifests: [manifest('files', view('panels')), manifest('tree', view('panels')), manifest('x', view()), manifest('y', view('panels')), manifest('z', view('files')), manifest('w', view('mine'))],
    bundled: ['files', 'tree'],
    uiGroups: { panels: ['x'] },
  });
  assert.deepEqual(
    ids.map((id) => [id, k.groupOf(id)]),
    [
      ['files', 'panels'],
      ['tree', 'panels'],
      ['x', 'solo_x'],
      ['y', 'solo_y'],
      ['z', 'solo_z'],
      ['w', 'solo_w'],
    ],
  );
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'group-isolated'),
    [
      { pluginId: 'x', kind: 'group-isolated', group: 'panels', renderGroup: 'x', reason: 'third-party' },
      { pluginId: 'y', kind: 'group-isolated', group: 'panels', renderGroup: 'y', reason: 'third-party' },
    ],
  );
  assert.equal(pluginStatuses(k.journal.filter((e) => e.kind === 'group-isolated')).length, 0, 'запись о группе состояния плагину не даёт');
  const entry = k.journal.find((e) => e.kind === 'group-isolated');
  assert.ok(entry);
  assert.match(describeEntry(entry), /сторонний плагин не делит группу рендера: группа panels не действует, работает в своей x/);
  assert.equal(entryLevel(entry), 'warn');
  await k.unload();

  const open = await kernel({ x: noop, y: noop }, { enabled: ['x', 'y'], manifests: [manifest('x', view('shared')), manifest('y', view('shared'))] });
  assert.deepEqual([open.groupOf('x'), open.groupOf('y')], ['solo_x', 'solo_y'], 'без bundled все сторонние');
  assert.equal(open.journal.filter((e) => e.kind === 'group-isolated').length, 2);
  await open.unload();
});

test('группы рендера: origin стороннего в своём пространстве имён - группа поставки с тем же именем его хранилище не делит, ни в одной загрузке, ни в следующей', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const view = (group?: string) => ({ ui: { views: { main: './ui.js' }, ...(group !== undefined && { group }) } });
  // Загрузка 1: alice и bob (поставка) в группе tp2, имя пришло от человека или манифеста; загрузка 2: человек включил сторонний плагин с id tp2.
  const first = await kernel({ alice: noop, bob: noop }, { enabled: ['alice', 'bob'], manifests: [manifest('alice', view('tp2')), manifest('bob', view('tp2'))], bundled: ['alice', 'bob'] });
  const second = await kernel({ tp2: noop, alice: noop }, { enabled: ['tp2', 'alice'], manifests: [manifest('tp2', view()), manifest('alice', view('tp2'))], bundled: ['alice'] });
  const before = new Set(['alice', 'bob'].map((id) => first.groupOf(id)));
  assert.deepEqual([...before], ['tp2']);
  assert.ok(!before.has(second.groupOf('tp2')), `сторонний tp2 получил группу ${String(second.groupOf('tp2'))}, где в прошлой загрузке жила поставка`);
  assert.notEqual(second.groupOf('tp2'), second.groupOf('alice'), 'и в одной загрузке они не делят origin');
  assert.equal(second.groupOf('alice'), 'tp2', 'плагин поставки садится в группу, как просил: отказывать ему незачем');
  assert.deepEqual(
    second.journal.filter((e) => e.kind === 'group-isolated'),
    [],
  );
  // В обратную сторону то же: что оставил сторонний tp2, не читают виды поставки в группе tp2.
  const alone = await kernel({ tp2: noop }, { enabled: ['tp2'], manifests: [manifest('tp2', view())] });
  assert.notEqual(alone.groupOf('tp2'), first.groupOf('alice'));
  // Группа не может быть записана как id плагина: пространства имён не пересекаются по синтаксису.
  assert.match(alone.groupOf('tp2') ?? '', /^[a-z]+_/, 'сторонний одиночка помечен знаком, которого нет в id плагина и имени группы');
  for (const k of [first, second, alone]) await k.unload();
});

test('хосты: из поставки - по группам, сторонний всегда один в своём хосте', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const ids = ['a', 'b', 'x', 'y', 'z', 'w'];
  const k = await kernel(Object.fromEntries(ids.map((id) => [id, noop])), {
    enabled: ids,
    manifests: ids.map((id) => manifest(id)),
    bundled: ['a', 'b', 'w'],
    hosts: { ui: ['a', 'x'], solo: ['y'], z: ['w'] },
  });
  assert.deepEqual(
    ids.map((id) => [id, k.hostOf(id)]),
    [
      ['a', 'ui'],
      ['b', 'builtin'],
      ['x', 'x'],
      ['y', 'solo'],
      ['z', 'z~2'],
      ['w', 'z'],
    ],
  );
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'host-isolated'),
    [{ pluginId: 'x', kind: 'host-isolated', group: 'ui', hostId: 'x' }],
  );
  assert.equal(pluginStatuses(k.journal.filter((e) => e.kind === 'host-isolated')).length, 0, 'запись о хосте состояния плагину не даёт');
  await k.unload();

  const unknown = await kernel({ p: noop, q: noop }, { enabled: ['p', 'q'], manifests: [manifest('p'), manifest('q')] });
  assert.deepEqual([unknown.hostOf('p'), unknown.hostOf('q')], ['p', 'q'], 'без bundled все сторонние');
  await unknown.unload();
});

test('журнал: загруженный сторонний плагин получает запись third-party, плагин поставки, выключенный и загрузка без bundled - нет', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const ids = ['a', 'x', 'y'];
  const k = await kernel(Object.fromEntries(ids.map((id) => [id, noop])), {
    enabled: ['a', 'x'],
    manifests: ids.map((id) => manifest(id)),
    bundled: ['a'],
  });
  const entries = k.journal.filter((e) => e.kind === 'third-party');
  assert.deepEqual(entries, [{ pluginId: 'x', kind: 'third-party' }], 'y не включён и не загружается, a из поставки');
  assert.equal(entryLevel(entries[0]!), 'warn');
  assert.match(describeEntry(entries[0]!), /сторонний плагин: код не из поставки/);
  assert.equal(pluginStatuses(k.journal).find((s) => s.id === 'x')?.state, 'active', 'запись состояния плагину не меняет');
  await k.unload();

  const unknown = await kernel({ p: noop }, { enabled: ['p'], manifests: [manifest('p')] });
  assert.equal(unknown.journal.filter((e) => e.kind === 'third-party').length, 0, 'без bundled поставку не от чего отличить: записей нет');
  await unknown.unload();
});

test('хосты: host own у плагина поставки - свой хост без группы; в группе с соседом - хост группы и предупреждение host-own-grouped', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const ids = ['solo', 'grouped', 'mate', 'alone', 'guest', 'rogue'];
  const own = { host: 'own' };
  const k = await kernel(Object.fromEntries(ids.map((id) => [id, noop])), {
    enabled: ids,
    manifests: [manifest('solo', own), manifest('grouped', own), manifest('mate'), manifest('alone', own), manifest('guest', own), manifest('rogue')],
    bundled: ['solo', 'grouped', 'mate', 'alone', 'guest'],
    hosts: { ui: ['grouped', 'mate'], one: ['alone'], mixed: ['guest', 'rogue'] },
  });
  assert.deepEqual(
    ids.map((id) => [id, k.hostOf(id)]),
    [
      ['solo', 'solo'],
      ['grouped', 'ui'],
      ['mate', 'ui'],
      ['alone', 'one'],
      ['guest', 'mixed'],
      ['rogue', 'rogue'],
    ],
  );
  const warnings = k.journal.filter((e) => e.kind === 'host-own-grouped');
  assert.deepEqual(warnings, [{ pluginId: 'grouped', kind: 'host-own-grouped', group: 'ui', neighbours: ['mate'] }], 'одному в группе и соседу стороннего, ушедшего в свой хост, предупреждать не о чем');
  assert.equal(entryLevel(warnings[0]!), 'warn');
  assert.equal(pluginStatuses(k.journal).find((s) => s.id === 'grouped')?.state, 'active');
  await k.unload();
});

test('схема раздела из манифеста: значение не по схеме - отказ плагину, правка извне не по схеме - значение прежнее', async () => {
  const { docs, store } = memory({ user: { timer: { $version: 1, minutes: 'пять' } } });
  const schema = { type: 'object', properties: { minutes: { type: 'integer', minimum: 1 } }, additionalProperties: false };
  const files: Record<string, unknown> = { './config.schema.json': schema, './broken.json': { type: 'date' } };
  const read = (_m: unknown, file: string) => {
    if (!(file in files)) throw new Error('нет файла');
    return files[file];
  };
  const seen: unknown[] = [];
  const timer: PluginModule = {
    config: { defaults: { minutes: 10 } },
    activate(ctx) {
      seen.push(ctx.config?.get());
      ctx.config?.onChange((v) => seen.push(v));
    },
  };
  const options = (schemaFile: string) => ({
    enabled: ['timer'],
    manifests: [manifest('timer', { config: { version: 1, schema: schemaFile } })],
    schema: read,
  });
  const config = await SectionStore.open(store, ['user', 'workspace']);
  const refused = await kernel({ timer }, { ...options('./config.schema.json'), config });
  assert.deepEqual(refused.active, []);
  assert.deepEqual(refused.journal, [{ pluginId: 'timer', kind: 'config', result: { status: 'invalid', errors: ['/minutes: ожидается integer, получено string'] } }]);
  await refused.unload();

  const broken: [string, string][] = [['./broken.json', './broken.json: #/type: ожидается тип из object, array, string, number, integer, boolean, null или их список'], ['./none.json', './none.json: нет файла']];
  for (const [file, error] of broken) {
    const k = await kernel({ timer }, { ...options(file), config });
    assert.deepEqual(k.journal, [{ pluginId: 'timer', kind: 'config', result: { status: 'invalid', errors: [error] } }]);
    await k.unload();
  }

  docs.set('user', { timer: { $version: 1, minutes: 5 } });
  await config.reload();
  const k = await kernel({ timer }, { ...options('./config.schema.json'), config });
  assert.deepEqual(k.active, ['timer']);
  docs.set('user', { timer: { $version: 1, minutes: 0 } });
  await k.reloadSections('config', await config.reload());
  docs.set('user', { timer: { $version: 1, minutes: 7 } });
  await k.reloadSections('config', await config.reload());
  assert.deepEqual(seen, [{ minutes: 5 }, { minutes: 7 }]);
  assert.deepEqual(kinds(k).slice(-1), ['timer:config']);
  assert.deepEqual(k.journal.at(-1), { pluginId: 'timer', kind: 'config', result: { status: 'invalid', errors: ['/minutes: ожидается >= 1'] } });
  await k.unload();
});

// Отмена запросов между плагинами (K-09): стенд - core/test/fixtures/cancel.ts.
// Пауза - только для проверки «ничего не произошло»; то, что должно произойти, ждётся по условию (`waitFor`), а не срокам в 60 мс.
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('отмена вызова контракта: поставщик получает сигнал, вызывающий - Cancelled, вызовы без сигнала целы', async () => {
  const { kernel, api, log } = await startCancel();
  const abort = new AbortController();
  const call = api.slow('a', abort.signal);
  await waitFor('поставщик начал вызов a', () => log.length >= 1);
  assert.deepEqual(log, ['a:start']);
  abort.abort();
  await assert.rejects(call, { code: 'Cancelled' });
  await waitFor('поставщик получил отмену вызова a', () => log.length >= 2);
  assert.deepEqual(log, ['a:start', 'a:abort:Cancelled']);
  const plain = api.slow('b');
  plain.catch(() => undefined);
  await waitFor('поставщик начал вызов b', () => log.length >= 3);
  assert.deepEqual(log.slice(2), ['b:start']);
  await kernel.unload();
});

test('отмена: уже отменённый сигнал - вызов до поставщика не доходит; отмена после ответа и двойная безвредны', async () => {
  const { kernel, api, log, held } = await startCancel();
  await assert.rejects(api.slow('x', AbortSignal.abort()), { code: 'Cancelled' });
  await pause();
  assert.deepEqual(log, []);

  held.slowMs = 10;
  const abort = new AbortController();
  assert.equal(await api.slow('fast', abort.signal), 'fast');
  await waitFor('поставщик записал завершение fast', () => log.length >= 2);
  abort.abort();
  abort.abort();
  await pause();
  assert.deepEqual(log, ['fast:start', 'fast:done']);
  assert.equal(await api.slow('again'), 'again');
  await kernel.unload();
});

test('callTimeout отменяет вызов у поставщика, а не только отпускает вызывающего', async () => {
  const { kernel, api, log } = await startCancel({ callTimeout: 80 });
  const never = new AbortController();
  await assert.rejects(api.slow('t', never.signal), { code: 'Timeout' });
  await waitFor('поставщик получил отмену по сроку', () => log.length >= 2);
  assert.deepEqual(log, ['t:start', 't:abort:Timeout']);
  await kernel.unload();
});

test('отмена команды: commands.run с сигналом доводит его до обработчика, аргументы проверяются без сигнала', async () => {
  const { kernel, ctx, log } = await startCancel();
  const abort = new AbortController();
  const run = ctx.commands.run('provider.slow', 'one', abort.signal);
  await waitFor('обработчик получил команду one с сигналом', () => log.length >= 1);
  assert.deepEqual(log, ['cmd:one:signal']);
  abort.abort();
  await assert.rejects(run, { code: 'Cancelled' });
  await waitFor('обработчик получил отмену команды one', () => log.length >= 2);
  assert.deepEqual(log, ['cmd:one:signal', 'cmd:abort:Cancelled']);
  const app = new AbortController();
  const fromApp = kernel.run('provider.slow', 'two', app.signal);
  await waitFor('обработчик получил команду two', () => log.length >= 3);
  app.abort();
  await assert.rejects(fromApp, { code: 'Cancelled' });
  await assert.rejects(ctx.commands.run('provider.slow', 'one', 'extra'), { code: 'Invalid' });
  await kernel.unload();
});

// K-03: упорядоченный снимок раскладки по манифестам, до запуска кода плагинов.
const quiet: PluginModule = { activate() {} };
const view = (module: string, area?: string, order?: number, title?: string) => ({ module, ...(area && { area }), ...(order !== undefined && { order }), ...(title && { title }) });
const layoutOf = (k: { layout: readonly { pluginId: string; kind: string; name: string }[] }) => k.layout.map((e) => `${e.pluginId}/${e.name}`);

test('раскладка: по order, при равенстве по id плагина, затем по имени; не зависит от порядка манифестов', async () => {
  const set = [
    manifest('zeta', { ui: { views: { main: view('./z.js', 'main', 100) } } }),
    manifest('alpha', { ui: { views: { b: view('./b.js', 'sidebar', 200), a: view('./a.js', 'sidebar', 200) } } }),
    manifest('beta', { ui: { views: { main: view('./m.js', 'main', 100) } }, documents: { note: { area: 'main', order: 50 } } }),
    manifest('late', { ui: { views: { tail: view('./t.js', 'toolbar', 900) } } }),
  ];
  const expected = ['beta/note', 'beta/main', 'zeta/main', 'alpha/a', 'alpha/b', 'late/tail'];
  const forward = await kernel({ zeta: quiet, alpha: quiet, beta: quiet, late: quiet }, { enabled: ['zeta', 'alpha', 'beta', 'late'], manifests: set });
  const backward = await kernel({ zeta: quiet, alpha: quiet, beta: quiet, late: quiet }, { enabled: ['late', 'beta', 'alpha', 'zeta'], manifests: [...set].reverse() });
  assert.deepEqual(layoutOf(forward), expected);
  assert.deepEqual(forward.layout, backward.layout, 'снимок детерминирован');
  assert.deepEqual(forward.layout[0], { pluginId: 'beta', kind: 'document', name: 'note', area: 'main', order: 50 });
  assert.deepEqual(forward.layout[2], { pluginId: 'zeta', kind: 'view', name: 'main', area: 'main', order: 100 });
  await forward.unload();
  await backward.unload();
});

test('раскладка: вид без размещения - боковая колонка и order 1000, документ - основная область и после вида того же плагина; заголовок доходит до снимка', async () => {
  const k = await kernel(
    { a: quiet, b: quiet },
    {
      enabled: ['a', 'b'],
      manifests: [manifest('a', { ui: { views: { plain: './p.js' } } }), manifest('b', { ui: { views: { tree: view('./t.js', undefined, undefined, 'Файлы') } }, documents: { doc: {} } })],
    },
  );
  assert.deepEqual(k.layout, [
    { pluginId: 'a', kind: 'view', name: 'plain', area: 'sidebar', order: 1000 },
    { pluginId: 'b', kind: 'view', name: 'tree', area: 'sidebar', order: 1000, title: 'Файлы' },
    { pluginId: 'b', kind: 'document', name: 'doc', area: 'main', order: 1000 },
  ]);
  await k.unload();
});

test('раскладка: невключённые, выключенные и плагины вне графа помечены, а не пропадают', async () => {
  const ui = { views: { main: view('./m.js', 'main', 100) } };
  const k = await kernel(
    { on: quiet, user: quiet, orphan: quiet },
    {
      enabled: ['on', 'user', 'orphan'],
      manifests: [
        manifest('on', { ui }),
        manifest('user', { ui }),
        manifest('orphan', { ui, requires: { 'none.here': '^1' } }),
        manifest('off', { ui }),
      ],
    },
  );
  const marks = () => Object.fromEntries(k.layout.map((e) => [e.pluginId, e.mark ?? 'ok']));
  assert.deepEqual(marks(), { on: 'ok', orphan: 'out-of-graph', user: 'ok', off: 'not-enabled' });
  await k.disable('user');
  assert.deepEqual(marks(), { on: 'ok', orphan: 'out-of-graph', user: 'disabled', off: 'not-enabled' });
  await k.enable('user');
  assert.equal(marks().user, 'ok');
  assert.deepEqual(layoutOf(k), ['off/main', 'on/main', 'orphan/main', 'user/main'], 'помеченные стоят на своём месте по order и id');
  await k.unload();
});

test('раскладка: плагин без видов и документов в снимок не попадает, манифест с ошибкой - тоже', async () => {
  const k = await kernel({ bare: quiet, bad: quiet }, { enabled: ['bare', 'bad'], manifests: [manifest('bare'), manifest('bad', { ui: { views: { x: view('./x.js', 'cellar') } } })] });
  assert.deepEqual(k.layout, []);
  await k.unload();
});

// Склеенные записи пишутся по таймеру, уже после снятия зависимого: последней записью зависимого оказывается не unloaded.
async function enableAfterLateEntry(t: TestContext, lateKind: string, call: (ctx: PluginContext) => Promise<unknown>, providerFields: Record<string, unknown> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let editor: PluginContext | undefined;
  const k = await kernel(
    {
      files: { activate: (ctx) => void ctx.contracts.provide('test.files', '1.0', { read: async () => 'data' }) },
      editor: { activate: (ctx) => void (editor = ctx) },
    },
    {
      enabled: ['files', 'editor'],
      manifests: [manifest('files', { provides: { 'test.files': { version: '1.0', ...providerFields } } }), manifest('editor', { requires: { 'test.files': '^1' } })],
    },
  );
  assert.ok(editor);
  await call(editor);
  await k.disable('files');
  assert.deepEqual(k.active, []);
  t.mock.timers.tick(5500);
  const of = (kind: string) => k.journal.findLastIndex((e) => e.pluginId === 'editor' && e.kind === kind);
  assert.ok(of(lateKind) > of('unloaded'), `${lateKind} должна лечь после unloaded зависимого: ${kinds(k).join(' ')}`);
  await k.enable('files');
  assert.deepEqual(k.active, ['files', 'editor']);
  await k.unload();
}

test('enable поставщика поднимает зависимого, если после его снятия в журнал легла склеенная denied (FR-CH-1007)', async (t) => {
  await enableAfterLateEntry(t, 'denied', async (ctx) => {
    for (let i = 0; i < 3; i++) await ctx.os.fs.readText('/etc/hostname').catch(() => undefined);
  });
});

test('enable поставщика поднимает зависимого, если после его снятия легла запись вызова устаревшего члена', async (t) => {
  await enableAfterLateEntry(
    t,
    'deprecated-call',
    async (ctx) => {
      const files = ctx.contracts.get('test.files', 1);
      for (let i = 0; i < 3; i++) await files?.read?.('a');
    },
    { deprecated: ['read'] },
  );
});

test('enable поставщика поднимает зависимого, если перезагрузка раздела, шедшая при disable, отказала после его снятия', async () => {
  const { store } = memory({});
  const config = await SectionStore.open(store, ['user', 'workspace']);
  const section = { config: { version: 1 } };
  const k = await kernel(
    { files: { activate: (ctx) => void ctx.contracts.provide('test.files', '1.0', {}) }, editor: { activate: () => {} } },
    { enabled: ['files', 'editor'], manifests: [manifest('files', { ...section, provides: { 'test.files': '1.0' } }), manifest('editor', { ...section, requires: { 'test.files': '^1' } })], config },
  );
  void k.reloadSections('config', ['files', 'editor']);
  await k.disable('files');
  const of = (kind: string) => k.journal.findLastIndex((e) => e.pluginId === 'editor' && e.kind === kind);
  assert.ok(of('config') < of('unloaded'), `после снятия плагина запись о перезагрузке его раздела не пишется: ${kinds(k).join(' ')}`);
  await k.enable('files');
  assert.deepEqual(k.active, ['files', 'editor']);
  await k.unload();
});
