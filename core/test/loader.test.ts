import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { toDisposable } from '../src/disposable.ts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { entryLevel, pluginStatuses } from '../src/status.ts';

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

function memory(initial: Record<string, Record<string, unknown>> = {}) {
  const docs = new Map(Object.entries(initial));
  const store: LayerStore = { load: async (l) => docs.get(l), save: async (l, d) => void docs.set(l, d) };
  return { docs, store };
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
