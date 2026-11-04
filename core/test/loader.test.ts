import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { toDisposable } from '../src/disposable.ts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

function kernel(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>) {
  return load({
    apiVersion: '1.0.0',
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

const kinds = (k: { journal: readonly { pluginId?: string; kind: string }[] }) => k.journal.map((e) => `${e.pluginId ?? '-'}:${e.kind}`);

test('активация по графу, вызов чужого контракта через ядро, снятие в обратном порядке', async () => {
  const events: string[] = [];
  const k = await kernel(
    {
      files: {
        activate(ctx) {
          events.push('files:up');
          ctx.contracts.provide('cyborg.files', '1.0', { root: '/w', read: async (p: string) => `data:${p}` });
          return toDisposable(() => events.push('files:down'));
        },
      },
      sessions: {
        async activate(ctx) {
          const api = ctx.contracts.get<{ root: string; read(p: string): Promise<string> }>('cyborg.files')!;
          events.push(`sessions:${api.root}:${await api.read('a')}`);
          ctx.subscriptions.add(toDisposable(() => events.push('sessions:down')));
        },
      },
    },
    {
      enabled: ['sessions', 'files'],
      manifests: [manifest('sessions', { requires: { 'cyborg.files': '^1' } }), manifest('files', { provides: { 'cyborg.files': '1.0' } })],
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
        manifest('files', { provides: { 'cyborg.files': '1.0' } }),
        manifest('sessions', { requires: { 'cyborg.files': '^1' } }),
        manifest('lonely', { requires: { 'cyborg.nobody': '^1' } }),
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
          ctx.contracts.provide('cyborg.files', '1.0', {});
          throw new Error('после provide');
        },
      },
      tree: { activate() {} },
    },
    {
      enabled: ['files', 'tree'],
      manifests: [manifest('files', { provides: { 'cyborg.files': '1.0' } }), manifest('tree', { optional: { 'cyborg.files': '^1' } })],
    },
  );
  assert.deepEqual(k.active, ['tree']);
  assert.equal(k.contracts.get('tree', 'cyborg.files'), undefined);
  await k.unload();
});

test('команды: запуск из ядра и из другого плагина, необъявленная команда отклоняется', async () => {
  const k = await kernel(
    {
      lock: { activate: (ctx) => void ctx.commands.register('lock.now', (reason: string) => `locked:${reason}`) },
      menu: {
        activate(ctx) {
          assert.throws(() => ctx.commands.register('lock.now', () => 0), { code: 'NotDeclared' });
          ctx.commands.register('menu.press', () => ctx.commands.run('lock.now', 'menu'));
        },
      },
    },
    { enabled: ['lock', 'menu'], manifests: [manifest('lock', { commands: ['lock.now'] }), manifest('menu', { commands: ['menu.press'] })] },
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
      clock: { activate: (ctx) => void ctx.contracts.provide('cyborg.clock', '1.0', { tick: async () => () => 0 }) },
      user: {
        async activate(ctx) {
          await ctx.contracts.get<{ tick(): Promise<unknown> }>('cyborg.clock')!.tick().catch((e) => (error = e));
        },
      },
    },
    {
      enabled: ['clock', 'user'],
      manifests: [manifest('clock', { provides: { 'cyborg.clock': '1.0' } }), manifest('user', { requires: { 'cyborg.clock': '^1' } })],
    },
  );
  assert.equal((error as { code: string }).code, 'NotCloneable');
  await k.unload();
});

test('битый манифест невключённого плагина - disabled, а не invalid', async () => {
  const k = await kernel({}, { enabled: [], manifests: [{ id: 'old', version: 'latest' }] });
  assert.deepEqual(k.journal, [{ pluginId: 'old', kind: 'disabled' }]);
});

test('хуки: граф до кода, журнал по ходу, лог с id плагина, снятие в журнале', async () => {
  const seen: string[] = [];
  const k = await kernel(
    { a: { activate: (ctx) => ctx.log('привет') } },
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
    apiVersion: '1.0.0',
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
    activate: (ctx) => void (entry === 'editor' && ctx.contracts.provide('cyborg.tab', '1.0', { kind: 'редактор' })),
  }));
  const k = await load({
    apiVersion: '1.0.0',
    enabled: ['editor', 'tabs'],
    manifests: [manifest('editor', { provides: { 'cyborg.tab': '1.0' } }), manifest('tabs', { consumes: { 'cyborg.tab': '^1' } })],
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
  const host = k.journal.filter((e) => e.pluginId === undefined).map((e) => (e.kind === 'host-down' ? `${e.kind}:${e.culprits}:${e.affects}` : e.kind));
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
            ctx.contracts.provide('demo.flaky', '1.0', {});
            ctx.commands.register('flaky.hang', () => new Promise(() => {}));
          },
        }
      : { activate: () => {} },
  );
  const k = await load({
    apiVersion: '1.0.0',
    enabled: ['flaky', 'user'],
    manifests: [manifest('flaky', { provides: { 'demo.flaky': '1.0' }, commands: ['flaky.hang'] }), manifest('user', { requires: { 'demo.flaky': '^1' } })],
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
  await k.revive('flaky');
  assert.deepEqual(k.active, ['flaky', 'user']);

  void k.run('flaky.hang').catch(() => {});
  await new Promise((r) => setImmediate(r));
  handles.get('one')!.kill();
  await k.idle();
  assert.equal(k.journal.at(-1)?.kind, 'switched-off');
  assert.deepEqual(k.active, ['user']);
  await k.revive('flaky');
  assert.deepEqual(k.active, ['user', 'flaky']);
  await assert.rejects(k.revive('nobody'), /не загружается/);
  assert.deepEqual(
    k.manifests.map((m) => m.id),
    ['flaky', 'user'],
  );
  await k.unload();
});
