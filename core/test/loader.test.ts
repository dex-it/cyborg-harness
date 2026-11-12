import { test, type TestContext } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg-harness/contracts';
import { memoryStore as memory } from '../../testing/src/memory.ts';
import { SectionStore } from '../src/config.ts';
import { toDisposable } from '../src/disposable.ts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import type { Port } from '../src/rpc.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { describeEntry, entryLevel, pluginStatuses } from '../src/status.ts';
import { startCancel } from './fixtures/cancel.ts';
import './fixtures/contracts.ts';
import { MENU_OWNER } from '../src/window-layer.ts';
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

test('ST-1002/7, ST-2001/1: активация по графу, вызов чужого контракта через ядро, снятие в обратном порядке', async () => {
  const events: string[] = [];
  const received: unknown[][] = [];
  let answer: unknown;
  let seen: string[] = [];
  const k = await kernel(
    {
      files: {
        activate(ctx) {
          events.push('files:up');
          ctx.contracts.provide('test.files', '1.0', { root: '/w', read: (...args: unknown[]) => { received.push(args); return `data:${String(args[0])}`; } });
          return toDisposable(() => events.push('files:down'));
        },
      },
      sessions: {
        async activate(ctx) {
          const api = ctx.contracts.get('test.files', 1)!;
          answer = api.read?.('a');
          seen = Object.keys(api).sort();
          events.push(`sessions:${api.root ?? ''}:${String(await answer)}`);
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
  assert.ok(answer instanceof Promise, 'синхронный член поставщика у потребителя - обещание');
  assert.deepEqual(received, [['a']], 'поставщик получает только аргументы, без имени вызывающего');
  assert.deepEqual(seen, ['read', 'root'], 'у потребителя только члены контракта, без имени поставщика');
  await k.unload();
  assert.deepEqual(events, ['files:up', 'sessions:/w:data:a', 'sessions:down', 'files:down']);
});

test('ST-1001/1, ST-1002/1, ST-1004/1, ST-3001/7, ST-5002/6, ST-6001/7: журнал: невалидный, выключенный, не найденный, отказ графа, сбой и пропуск зависимого', async () => {
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

test('ST-6001/7: плагины поставки с ошибкой манифеста, чужим engines.cyborg и без поставщика requires: не загружены, причина каждого в журнале и статусе, остальные работают', async () => {
  const activated: string[] = [];
  const k = await kernel(
    {
      typo: { activate: () => void activated.push('typo') },
      next: { activate: () => void activated.push('next') },
      lonely: { activate: () => void activated.push('lonely') },
      fine: {
        activate(ctx) {
          activated.push('fine');
          ctx.commands.register('fine.ping', () => 'fine');
        },
      },
    },
    {
      enabled: ['typo', 'next', 'lonely', 'fine'],
      manifests: [manifest('typo', { version: 'latest' }), manifest('next', { engines: { cyborg: '^2' } }), manifest('lonely', { requires: { 'test.nobody': '^1' } }), manifest('fine', { commands: ['fine.ping'] })],
    },
  );
  assert.deepEqual(activated, ['fine']);
  assert.deepEqual(k.active, ['fine']);
  assert.equal(await k.run('fine.ping'), 'fine');
  const statuses = pluginStatuses(k.journal);
  const reason = (id: string) => {
    const st = statuses.find((s) => s.id === id)!;
    return `${st.state}: ${describeEntry(st.cause!)}`;
  };
  assert.match(reason('typo'), /^stopped: .*version: ожидается версия x\.y\.z, получено "latest"/);
  assert.equal(reason('next'), `stopped: нужен API Cyborg ^2, есть ${PLUGIN_API_VERSION}`);
  assert.equal(reason('lonely'), 'stopped: нет поставщика test.nobody ^1');
  assert.equal(statuses.find((s) => s.id === 'fine')?.state, 'active');
  await k.unload();
});

test('ST-1001/1: манифест без engines.cyborg и с version не x.y.z - одна запись invalid со всеми ошибками, код плагина не запущен', async () => {
  const imported: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['old', 'fine'],
    manifests: [{ id: 'old', version: 'latest' }, manifest('fine')],
    spawnHost: inlineHosts(async (entry) => {
      imported.push(entry);
      return { activate: () => undefined };
    }),
  });
  assert.deepEqual(
    k.journal.filter((e) => e.pluginId === 'old'),
    [{ pluginId: 'old', kind: 'invalid', errors: ['version: ожидается версия x.y.z, получено "latest"', 'engines.cyborg: ожидается диапазон, получено ничего'] }],
  );
  assert.deepEqual(imported, ['fine']);
  assert.deepEqual(k.active, ['fine']);
  await k.unload();
});

test('ST-3001/7: права в манифесте: неизвестное право и неверная форма - запись invalid с ошибкой каждого, код плагина не запущен, плагина нет среди активных', async () => {
  const imported: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['typo', 'fine'],
    manifests: [manifest('typo', { permissions: { 'fs.reed': ['$workspace'], net: 'jira.company.com' } }), manifest('fine')],
    spawnHost: inlineHosts(async (entry) => {
      imported.push(entry);
      return { activate: () => undefined };
    }),
  });
  const entries = k.journal.filter((e) => e.pluginId === 'typo');
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.ok(entry?.kind === 'invalid');
  assert.match(entry.errors.join('\n'), /fs\.reed/);
  assert.match(entry.errors.join('\n'), /net/);
  assert.deepEqual(imported, ['fine']);
  assert.deepEqual(k.active, ['fine']);
  await k.unload();
});

test('ST-1001/2: манифест с id cyborg.window - invalid с причиной, остальные плагины загружены', async () => {
  const noop: PluginModule = { activate: () => undefined };
  const k = await kernel({ 'cyborg.window': noop, a: noop, b: noop }, { enabled: ['a', 'cyborg.window', 'b'], manifests: [manifest('a'), manifest('cyborg.window'), manifest('b')] });
  const entries = k.journal.filter((e) => e.pluginId === 'cyborg.window');
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.ok(entry?.kind === 'invalid');
  assert.match(entry.errors.join(), /id: "cyborg\.window" занято командами окна/);
  assert.deepEqual(k.active, ['a', 'b']);
  await k.unload();
});

test('ST-1002/1: requires на контракт, которого никто не даёт: плагин не загружен, причина называет контракт, независимые активны', async () => {
  const activated: string[] = [];
  const module = (id: string): PluginModule => ({ activate: () => void activated.push(id) });
  const k = await kernel(
    { lonely: module('lonely'), solo: module('solo'), other: module('other') },
    { enabled: ['lonely', 'solo', 'other'], manifests: [manifest('lonely', { requires: { 'test.nobody': '^1' } }), manifest('solo'), manifest('other')] },
  );
  assert.deepEqual(
    k.journal.filter((e) => e.pluginId === 'lonely'),
    [{ pluginId: 'lonely', kind: 'rejected', reasons: [{ kind: 'missing', contract: 'test.nobody', range: '^1' }] }],
  );
  assert.match(describeEntry(k.journal.find((e) => e.pluginId === 'lonely')!), /test\.nobody/);
  assert.deepEqual(activated, ['solo', 'other']);
  assert.deepEqual(k.active, ['solo', 'other']);
  await k.unload();
});

test('ST-1003/1: исключение в activate одного из двух плагинов общего хоста - failed с хостом и ошибкой, сосед по хосту и другой хост живы', async () => {
  const k = await kernel(
    {
      bad: {
        activate() {
          throw new Error('диск недоступен');
        },
      },
      mate: { activate: (ctx) => void ctx.commands.register('mate.ping', () => 'mate') },
      far: { activate: (ctx) => void ctx.commands.register('far.ping', () => 'far') },
    },
    {
      enabled: ['bad', 'mate', 'far'],
      manifests: [manifest('bad'), manifest('mate', { commands: ['mate.ping'] }), manifest('far', { commands: ['far.ping'] })],
      bundled: ['bad', 'mate', 'far'],
      hosts: { shared: ['bad', 'mate'], other: ['far'] },
    },
  );
  const failed = k.journal.filter((e) => e.kind === 'failed');
  assert.equal(failed.length, 1);
  const [fail] = failed;
  assert.ok(fail?.kind === 'failed');
  assert.deepEqual([fail.pluginId, fail.hostId], ['bad', 'shared']);
  assert.match(fail.error, /диск недоступен/);
  assert.deepEqual(k.active, ['mate', 'far']);
  assert.equal(k.hostOf('mate'), 'shared');
  assert.equal(await k.run('mate.ping'), 'mate');
  assert.equal(await k.run('far.ping'), 'far');
  assert.equal(k.journal.some((e) => e.kind === 'host-down' || e.kind === 'host-restart'), false, 'хост не перезапускался');
  await k.unload();
});

test('ST-1004/1, ST-5002/6: сбой активации снимает уже отданное плагином', async () => {
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

test('ST-5002/6: плагин зовёт член ctx, которого в ядре нет: отказывает только он, причина в журнале и в статусе, сосед по общему хосту работает', async () => {
  interface Removed {
    readonly removed: { member(): void };
  }
  const k = await kernel(
    {
      bad: {
        activate(ctx) {
          (ctx as unknown as Removed).removed.member();
        },
      },
      late: {
        activate(ctx) {
          ctx.commands.register('late.go', () => (ctx as unknown as Removed).removed.member());
        },
      },
      mate: { activate: (ctx) => void ctx.commands.register('mate.ping', () => 'mate') },
    },
    {
      enabled: ['bad', 'late', 'mate'],
      manifests: [manifest('bad'), manifest('late', { commands: ['late.go'] }), manifest('mate', { commands: ['mate.ping'] })],
      bundled: ['bad', 'late', 'mate'],
      hosts: { shared: ['bad', 'late', 'mate'] },
    },
  );
  const failed = k.journal.find((e) => e.pluginId === 'bad');
  assert.ok(failed?.kind === 'failed', JSON.stringify(failed));
  assert.equal(failed.hostId, 'shared');
  assert.match(failed.error, /member/);
  assert.match(describeEntry(failed), /^не поднялся в хосте shared: .*member/);
  assert.equal(pluginStatuses(k.journal).find((st) => st.id === 'bad')?.state, 'stopped');
  assert.deepEqual(k.active, ['late', 'mate']);
  await assert.rejects(k.run('late.go'), /member/);
  assert.deepEqual(k.active, ['late', 'mate']);
  assert.equal(await k.run('mate.ping'), 'mate');
  assert.equal(k.journal.some((e) => e.kind === 'host-down' || e.kind === 'host-restart'), false, 'общий хост не падал');
  await k.unload();
});

test('ST-2002/1: команды: запуск из ядра и из другого плагина, необъявленная команда отклоняется', async () => {
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

test('ST-2001/5: функция в результате контракта - NotCloneable у вызывающего', async () => {
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

test('ST-1001/1: битый манифест невключённого плагина - disabled, а не invalid', async () => {
  const k = await kernel({}, { enabled: [], manifests: [{ id: 'old', version: 'latest' }] });
  assert.deepEqual(k.journal, [{ pluginId: 'old', kind: 'disabled' }]);
});

test('ST-5001/2: манифест с полем новой версии API - в журнале причина версия, а не поле', async () => {
  const k = await kernel({}, { enabled: ['next', 'typo'], manifests: [manifest('next', { engines: { cyborg: '^1.3' }, layout: {} }), manifest('typo', { keybinding: [] })] });
  assert.deepEqual(k.journal, [
    { pluginId: 'next', kind: 'invalid', errors: [`engines.cyborg: нужен API Cyborg ^1.3, есть ${PLUGIN_API_VERSION}`] },
    { pluginId: 'typo', kind: 'invalid', errors: ['keybinding: незнакомое поле манифеста'] },
  ]);
});

test('ST-5001/2: ядро сменило мажорную версию API на 2: плагин под ^1.0 не загружен и код его не выполнялся, причина с диапазоном и версией в журнале и в статусе, requires-потребитель снят каскадом, optional-потребитель и сосед работают', async () => {
  const activated: string[] = [];
  const module = (id: string): PluginModule => ({ activate: () => void activated.push(id) });
  const v2 = { engines: { cyborg: '^2' } };
  const k = await load({
    apiVersion: '2.0.0',
    enabled: ['old', 'needs', 'wants', 'next'],
    manifests: [
      manifest('old', { engines: { cyborg: '^1.0' }, provides: { 'test.files': '1.0' } }),
      manifest('needs', { ...v2, requires: { 'test.files': '^1' } }),
      manifest('wants', { ...v2, optional: { 'test.files': '^1' } }),
      manifest('next', v2),
    ],
    spawnHost: inlineHosts(async (entry) => module(entry)),
  });
  assert.deepEqual(activated, ['wants', 'next']);
  assert.deepEqual(k.active, ['wants', 'next']);
  const old = k.journal.find((e) => e.pluginId === 'old')!;
  assert.deepEqual(old, { pluginId: 'old', kind: 'rejected', reasons: [{ kind: 'engines', range: '^1.0', api: '2.0.0' }] });
  assert.equal(describeEntry(old), 'нужен API Cyborg ^1.0, есть 2.0.0');
  const status = pluginStatuses(k.journal).find((st) => st.id === 'old')!;
  assert.equal(status.state, 'stopped');
  assert.equal(describeEntry(status.cause!), 'нужен API Cyborg ^1.0, есть 2.0.0');
  assert.deepEqual(k.journal.find((e) => e.pluginId === 'needs'), { pluginId: 'needs', kind: 'rejected', reasons: [{ kind: 'missing', contract: 'test.files', range: '^1' }] });
  await k.unload();
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

test('ST-3008/1: безопасный режим не запускает хосты', async () => {
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
  await assert.rejects(k.enable('a'), { code: 'Unavailable' });
  assert.equal(spawned, false, 'включение в безопасном режиме хост не поднимает');
  assert.equal(describeEntry(pluginStatuses(k.journal).find((st) => st.id === 'a')!.cause!), 'безопасный режим: код плагинов не запускается');
  await k.unload();
});

test('ST-5004/2, ST-5004/7: откат версии плагина: раздел config новее манифеста - плагин не активируется, данные целы', async () => {
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

test('ST-5004/1: миграция config идёт в хосте, ядро записывает итог; set плагина доходит до слоя', async () => {
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

test('ST-5004/4, ST-5004/7: migrate бросил, вернул не объект или не объявлен: плагин не активен, ни один слой не записан, migrate-error со слоем, версией и причиной, сосед работает', async () => {
  const layers = { user: { minutes: 5 }, workspace: { bad: true } };
  const initial = {
    user: { throws: layers.user, string: layers.user, none: layers.user, mate: { $version: 2, minutes: 1 } },
    workspace: { throws: layers.workspace, string: layers.workspace, none: layers.workspace },
  };
  const { docs, store, saves } = memory(structuredClone(initial));
  const k = await kernel(
    {
      throws: {
        config: {
          migrate: (_, d) => {
            if (d.bad) throw new Error('перенос сломан');
            return d;
          },
        },
        activate() {},
      },
      string: { config: { migrate: (_, d) => (d.bad ? ('строка' as unknown as Record<string, unknown>) : d) }, activate() {} },
      none: { activate() {} },
      mate: { activate: (ctx) => void ctx.commands.register('mate.read', () => ctx.config?.get()) },
    },
    {
      enabled: ['throws', 'string', 'none', 'mate'],
      manifests: ['throws', 'string', 'none'].map((id) => manifest(id, { config: { version: 2 } })).concat(manifest('mate', { config: { version: 2 }, commands: ['mate.read'] })),
      config: await SectionStore.open(store, ['user', 'workspace']),
    },
  );
  assert.deepEqual(k.active, ['mate']);
  assert.deepEqual(await k.run('mate.read'), { minutes: 1 });
  const results = k.journal.filter((e) => e.kind === 'config').map((e) => [e.pluginId, e.kind === 'config' && e.result]);
  assert.deepEqual(results, [
    ['throws', { status: 'migrate-error', layer: 'workspace', from: 1, error: 'перенос сломан' }],
    ['string', { status: 'migrate-error', layer: 'workspace', from: 1, error: 'migrate вернул не объект' }],
    ['none', { status: 'migrate-error', layer: 'user', from: 1, error: 'у плагина нет migrate' }],
  ]);
  assert.equal(describeEntry(k.journal.find((e) => e.pluginId === 'throws')!), 'перенос раздела настроек слоя workspace с версии 1 не удался: перенос сломан');
  assert.deepEqual(saves, [], 'слой user, который перенёсся бы, тоже не записан');
  assert.deepEqual(Object.fromEntries(docs), initial);
  await k.unload();
});

test('ST-1003/7: хост упал без виновника: журнал называет задетых через consumes, хост поднимается, после лимита брошен', async () => {
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

test('ST-1003/7: лимит по умолчанию - хост без виновника поднимается после первого и второго падения, после третьего брошен', async () => {
  const handles = new Map<string, HostHandle>();
  const spawn = inlineHosts(async () => ({ activate: () => undefined }));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['editor', 'tabs'],
    manifests: [manifest('editor'), manifest('tabs')],
    hosts: { one: ['editor'], two: ['tabs'] },
    spawnHost: (id) => {
      const handle = spawn(id);
      handles.set(id, handle);
      return handle;
    },
  });
  for (let i = 0; i < 3; i++) {
    handles.get('one')!.kill();
    await k.idle();
  }
  const host = k.journal.filter((e) => e.pluginId === undefined).map((e) => e.kind);
  assert.deepEqual(host, ['host-down', 'host-restart', 'host-down', 'host-restart', 'host-down', 'host-abandoned']);
  assert.deepEqual(k.journal.at(-1), { kind: 'host-abandoned', hostId: 'one', failures: 3, plugins: ['editor'] });
  assert.deepEqual(k.active, ['tabs']);
  await k.unload();
});

test('ST-1003/6: хост убит сигналом, виновника не назвал - сбой на плагин первого вызова после последнего отвеченного пинга; хост перезапущен, другой хост жив', async () => {
  const handles = new Map<string, HostHandle>();
  const spawn = inlineHosts(async (entry) => ({
    activate(ctx) {
      ctx.commands.register(`${entry}.call`, () => (entry === 'far' ? 'far' : new Promise(() => {})));
    },
  }));
  const ids = ['early', 'late', 'far'];
  const sent: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests: ids.map((id) => manifest(id, { commands: [`${id}.call`] })),
    bundled: ids,
    hosts: { shared: ['early', 'late'], other: ['far'] },
    watchdog: { interval: 10, timeout: 60_000 },
    spawnHost: (id) => {
      const handle = spawn(id);
      handles.set(id, handle);
      const post = (message: unknown) => {
        if (id === 'shared') sent.push(JSON.stringify(message));
        handle.port.post(message);
      };
      const onMessage: Port['onMessage'] = (listener) => {
        handle.port.onMessage(listener);
      };
      return { ...handle, port: { post, onMessage } };
    },
  });
  void k.run('early.call').catch(() => undefined);
  // Следующий пинг уходит только после ответа на прошлый: два пинга после вызова early - хост ответил на пинг, посланный уже после него.
  await waitFor('ответ на пинг после вызова early', () => {
    const call = sent.findIndex((m) => m.includes('early.call'));
    return call >= 0 && sent.slice(call).filter((m) => m.includes('"m":"ping"')).length >= 2;
  });
  void k.run('late.call').catch(() => undefined);
  void k.run('early.call').catch(() => undefined);
  await tick();
  handles.get('shared')!.kill();
  await k.idle();
  const down = k.journal.filter((e) => e.kind === 'host-down');
  assert.equal(down.length, 1);
  assert.deepEqual(down[0]?.kind === 'host-down' && { reason: down[0].reason, hostId: down[0].hostId, culprits: down[0].culprits }, { reason: 'crash', hostId: 'shared', culprits: ['late'] });
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'host-restart'),
    [{ kind: 'host-restart', hostId: 'shared', plugins: ['early', 'late'] }],
  );
  assert.deepEqual([...k.active].sort(), ['early', 'far', 'late']);
  assert.equal(await k.run('far.call'), 'far');
  await k.unload();
});

test('ST-1004/2, ST-1004/3, ST-1004/4: «Включить снова»: не поднявшийся плагин и потребитель следом, затем выключенный сторожем', async () => {
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
  const journalBefore = k.journal.length;
  await assert.rejects(k.enable('nobody'), /не загружается/);
  assert.deepEqual(k.active, ['user', 'flaky'], 'отказ не трогает остальные плагины');
  assert.equal(k.journal.length, journalBefore);
  assert.deepEqual(
    k.manifests.map((m) => m.id),
    ['flaky', 'user'],
  );
  await k.unload();
});

test('ST-1002/6, ST-3003/5: пространство поставки: отказ стороннему поставщику идёт в журнал, без bundled проверки нет', async () => {
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

test('ST-3005/1: группы рендера: сторонний всегда один в своей группе, запись group-isolated только если ему было с кем делить', async () => {
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

test('ST-3005/1: группы рендера: origin стороннего в своём пространстве имён - группа поставки с тем же именем его хранилище не делит, ни в одной загрузке, ни в следующей', async () => {
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

test('ST-1003/2, ST-2004/5, ST-3008/2: хосты: из поставки - по группам, сторонний всегда один в своём хосте', async () => {
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

test('ST-1001/7: журнал: загруженный сторонний плагин получает запись third-party, плагин поставки, выключенный и загрузка без bundled - нет', async () => {
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

test('ST-1001/9, ST-1001/10: хосты: host own у плагина поставки - свой хост без группы; в группе с соседом - хост группы и предупреждение host-own-grouped', async () => {
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

test('ST-1007/8, ST-5004/3, ST-5004/7, ST-5004/8: схема раздела из манифеста: значение не по схеме - отказ плагину, правка извне не по схеме - значение прежнее', async () => {
  const { docs, store, saves } = memory({ user: { timer: { $version: 1, minutes: 'пять' }, mate: { $version: 1, minutes: 3 } } });
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
  let mateSeen: unknown;
  const mate: PluginModule = { activate: (ctx) => void (mateSeen = ctx.config?.get()) };
  const refused = await kernel(
    { timer, mate },
    { ...options('./config.schema.json'), enabled: ['timer', 'mate'], manifests: [...options('./config.schema.json').manifests, manifest('mate', { config: { version: 1, schema: './config.schema.json' } })], config },
  );
  assert.deepEqual(refused.active, ['mate'], 'отказ только владельцу раздела');
  assert.deepEqual(mateSeen, { minutes: 3 });
  assert.deepEqual(refused.journal.filter((e) => e.pluginId === 'timer'), [{ pluginId: 'timer', kind: 'config', result: { status: 'invalid', errors: ['/minutes: ожидается integer, получено string'] } }]);
  assert.deepEqual(saves, [], 'ST-5004/7: отказ по схеме файл слоя не пишет');
  assert.deepEqual(docs.get('user'), { timer: { $version: 1, minutes: 'пять' }, mate: { $version: 1, minutes: 3 } });
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

test('ST-1007/8: config и state, правленные руками не по схеме: раздел отклонён с записью, значение прежнее, файл и разделы других плагинов не тронуты', async () => {
  const { docs, store, saves } = memory({ user: { timer: { $version: 1, minutes: 5 }, other: { $version: 1, color: 'red' } } });
  const kept = memory({ workspace: { timer: { $version: 1, count: 1 } } });
  const files: Record<string, unknown> = {
    './config.schema.json': { type: 'object', properties: { minutes: { type: 'integer', minimum: 1 } } },
    './state.schema.json': { type: 'object', properties: { count: { type: 'integer' } } },
  };
  const changes: unknown[] = [];
  const reader = (id: string): PluginModule => ({
    activate(ctx) {
      ctx.commands.register(`${id}.read`, () => ({ config: ctx.config?.get(), state: ctx.state?.get() }));
      ctx.config?.onChange((v) => changes.push([id, 'config', v]));
      ctx.state?.onChange((v) => changes.push([id, 'state', v]));
    },
  });
  const config = await SectionStore.open(store, ['user', 'workspace']);
  const state = await SectionStore.open(kept.store, ['workspace']);
  const k = await kernel(
    { timer: reader('timer'), other: reader('other') },
    {
      enabled: ['timer', 'other'],
      manifests: [
        manifest('timer', { config: { version: 1, schema: './config.schema.json' }, state: { version: 1, schema: './state.schema.json' }, commands: ['timer.read'] }),
        manifest('other', { config: { version: 1 }, commands: ['other.read'] }),
      ],
      schema: (_m, file) => files[file],
      config,
      state,
    },
  );
  assert.deepEqual(k.active, ['timer', 'other']);
  const userBefore = { timer: { $version: 1, minutes: 0 }, other: { $version: 1, color: 'blue' } };
  docs.set('user', structuredClone(userBefore));
  await k.reloadSections('config', await config.reload());
  kept.docs.set('workspace', { timer: { $version: 1, count: 'много' } });
  await k.reloadSections('state', await state.reload());

  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'config' || e.kind === 'state'),
    [
      { pluginId: 'timer', kind: 'config', result: { status: 'invalid', errors: ['/minutes: ожидается >= 1'] } },
      { pluginId: 'timer', kind: 'state', result: { status: 'invalid', errors: ['/count: ожидается integer, получено string'] } },
    ],
  );
  assert.deepEqual(await k.run('timer.read'), { config: { minutes: 5 }, state: { count: 1 } });
  assert.deepEqual(await k.run('other.read'), { config: { color: 'blue' }, state: undefined });
  assert.deepEqual(changes, [['other', 'config', { color: 'blue' }]]);
  assert.deepEqual([...saves, ...kept.saves], [], 'ядро не переписывает файл');
  assert.deepEqual(docs.get('user'), userBefore);
  await k.unload();
});

// Отмена запросов между плагинами (K-09): стенд - core/test/fixtures/cancel.ts.
// Пауза - только для проверки «ничего не произошло»; то, что должно произойти, ждётся по условию (`waitFor`), а не срокам в 60 мс.
const pause = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('ST-2001/8: отмена вызова контракта: поставщик получает сигнал, вызывающий - Cancelled, вызовы без сигнала целы', async () => {
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

test('ST-2003/1: раскладка: по order, при равенстве по id плагина, затем по имени; не зависит от порядка манифестов', async () => {
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

test('ST-2003/8: раскладка: плагин без видов и документов в снимок не попадает, манифест с ошибкой - тоже', async () => {
  const k = await kernel({ bare: quiet, bad: quiet }, { enabled: ['bare', 'bad'], manifests: [manifest('bare'), manifest('bad', { ui: { views: { x: view('./x.js', 'cellar') } } })] });
  assert.deepEqual(k.layout, []);
  await k.unload();
});

// K-08: вклады плагинов в меню окна. Снимок `kernel.menus` собирает ядро, приложение рисует меню ОС по нему.
const settle = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

/** Владелец состояния: контракт `test.state` с булевыми членами и команда, которая его меняет. */
function stateOwner(flags: { open: boolean; project: boolean; broken?: 'text' | 'throw' | 'hang' }): PluginModule {
  return {
    activate(ctx) {
      const read = (name: 'open' | 'project') => async () => {
        if (flags.broken === 'throw') throw new Error('состояние недоступно');
        if (flags.broken === 'hang') return new Promise<boolean>(() => undefined);
        return flags.broken === 'text' ? ('да' as unknown as boolean) : flags[name];
      };
      ctx.contracts.provide('test.state', '1.0', { isOpen: read('open'), hasProject: read('project') });
      ctx.commands.register('owner.toggle', () => void (flags.open = !flags.open));
      ctx.commands.register('owner.project', () => void (flags.project = !flags.project));
      return undefined;
    },
  };
}

const ownerManifest = manifest('owner', { provides: { 'test.state': '1.0' }, commands: ['owner.toggle', 'owner.project'] });
const open = { id: 'open', menu: 'view', title: 'Открыть', command: 'menu.open', order: 200, enabled: { contract: 'test.state', major: 1, member: 'hasProject' }, checked: { contract: 'test.state', major: 1, member: 'isOpen' } };
const menuManifest = (items: unknown[] = [open], extra: Record<string, unknown> = {}) =>
  manifest('menu', { optional: { 'test.state': '^1' }, commands: ['menu.open', 'menu.more'], contributes: { menus: items }, ...extra });
const opened: string[] = [];
const menuPlugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('menu.open', () => void opened.push('open'));
    ctx.commands.register('menu.more', () => void opened.push('more'));
    return undefined;
  },
};
const brief = (k: { menus: readonly { pluginId: string; id: string; enabled: boolean; checked?: boolean; mark?: string }[] }) =>
  k.menus.map((e) => `${e.pluginId}/${e.id}:${e.enabled ? 'on' : 'off'}${e.checked === undefined ? '' : e.checked ? '+' : '-'}${e.mark ? `[${e.mark}]` : ''}`);

test('меню: смена состояния владельца меняет enabled и checked пункта, приложение получает уведомление', async () => {
  const flags = { open: false, project: true };
  let changed = 0;
  const k = await kernel({ owner: stateOwner(flags), menu: menuPlugin }, { enabled: ['owner', 'menu'], manifests: [ownerManifest, menuManifest()], onMenus: () => changed++ });
  assert.deepEqual(brief(k), ['menu/open:on-']);
  assert.equal(changed, 0, 'первый снимок приложение читает само');

  await k.run('owner.toggle');
  await settle();
  assert.deepEqual(brief(k), ['menu/open:on+'], 'галочка следует состоянию владельца');
  assert.equal(changed, 1);

  await k.run('owner.project');
  await settle();
  assert.deepEqual(brief(k), ['menu/open:off+'], 'нет проекта - пункт недоступен');
  assert.equal(changed, 2);

  await k.refreshMenus();
  await k.refreshMenus();
  assert.equal(changed, 2, 'снимок не изменился - уведомления нет');
  await k.unload();
});

test('меню: снимок упорядочен по меню, order, id плагина и пункта и не зависит от порядка манифестов', async () => {
  const item = (id: string, menu: string, order?: number) => ({ id, menu, title: id, command: 'z.run', ...(order !== undefined && { order }) });
  const make = (id: string, items: unknown[]) => manifest(id, { commands: ['z.run'].map((c) => c.replace('z', id)), contributes: { menus: items.map((i) => ({ ...(i as object), command: `${id}.run` })) } });
  const manifests = [
    make('b', [item('x', 'view', 100), item('a', 'workspace')]),
    make('a', [item('y', 'view', 100), item('w', 'window', 5), item('late', 'tools')]),
  ];
  const first = await kernel({ a: quiet, b: quiet }, { enabled: ['a', 'b'], manifests });
  const second = await kernel({ a: quiet, b: quiet }, { enabled: ['a', 'b'], manifests: [...manifests].reverse() });
  const names = (k: typeof first) => k.menus.map((e) => `${e.menu}:${String(e.order)}:${e.pluginId}/${e.id}`);
  assert.deepEqual(names(first), ['workspace:1000:b/a', 'view:100:a/y', 'view:100:b/x', 'tools:1000:a/late', 'window:5:a/w']);
  assert.deepEqual(names(second), names(first));
  await first.unload();
  await second.unload();
});

test('ST-2002/6: меню: выключение плагина делает его пункты недоступными, а не убирает; включение возвращает', async () => {
  const flags = { open: true, project: true };
  const k = await kernel({ owner: stateOwner(flags), menu: menuPlugin }, { enabled: ['owner', 'menu'], manifests: [ownerManifest, menuManifest()] });
  assert.deepEqual(brief(k), ['menu/open:on+']);
  await k.disable('menu');
  assert.deepEqual(brief(k), ['menu/open:off-[disabled]'], 'пункт на месте, доступа нет');
  await k.enable('menu');
  await settle();
  assert.deepEqual(brief(k), ['menu/open:on+']);

  await k.disable('owner');
  await settle();
  assert.deepEqual(brief(k), ['menu/open:off-'], 'владелец состояния выгружен - пункт недоступен без записи об ошибке в журнале');
  assert.equal(k.journal.some((e) => e.kind === 'menu-source'), false);
  await k.unload();
});

test('меню: плагин, не включённый в настройках или отвергнутый графом, остаётся в снимке с меткой', async () => {
  const k = await kernel({ menu: menuPlugin }, { enabled: ['menu'], manifests: [menuManifest([open], { requires: { 'test.nobody': '^1' } }), manifest('idle', { commands: ['idle.run'], contributes: { menus: [{ id: 'run', menu: 'tools', title: 'Run', command: 'idle.run' }] } })] });
  assert.deepEqual(brief(k), ['menu/open:off-[out-of-graph]', 'idle/run:off[not-enabled]']);
  await k.unload();
});

test('меню: ленивый плагин виден и доступен до активации, нажатие будит его', async () => {
  opened.length = 0;
  const k = await kernel(
    { menu: menuPlugin },
    { enabled: ['menu'], manifests: [manifest('menu', { activation: 'lazy', commands: ['menu.open', 'menu.more'], contributes: { menus: [{ id: 'more', menu: 'tools', title: 'Ещё', command: 'menu.more' }] } })] },
  );
  assert.deepEqual(k.active, []);
  assert.deepEqual(brief(k), ['menu/more:on']);
  await k.runMenuItem('menu', 'more');
  assert.deepEqual(opened, ['more']);
  assert.deepEqual(k.active, ['menu']);
  await k.unload();
});

test('меню: нажатие недоступного или неизвестного пункта - отказ, чужую команду пункт не запускает', async () => {
  opened.length = 0;
  const flags = { open: false, project: false };
  const k = await kernel({ owner: stateOwner(flags), menu: menuPlugin }, { enabled: ['owner', 'menu'], manifests: [ownerManifest, menuManifest()] });
  await assert.rejects(k.runMenuItem('menu', 'open'), { code: 'Unavailable' });
  await assert.rejects(k.runMenuItem('menu', 'nope'), { code: 'NotFound' });
  await assert.rejects(k.runMenuItem('ghost', 'open'), { code: 'NotFound' });
  assert.deepEqual(opened, []);
  await k.run('owner.project');
  await settle();
  await k.runMenuItem('menu', 'open');
  assert.deepEqual(opened, ['open']);
  await k.unload();
});

test('меню: источник, который отвечает не boolean, падает или висит, даёт недоступный пункт и одну запись в журнале', { timeout: 30_000 }, async () => {
  for (const broken of ['text', 'throw', 'hang'] as const) {
    const flags = { open: true, project: true, broken };
    const k = await kernel({ owner: stateOwner(flags), menu: menuPlugin }, { enabled: ['owner', 'menu'], manifests: [ownerManifest, menuManifest()], });
    assert.deepEqual(brief(k), ['menu/open:off-'], broken);
    await k.refreshMenus();
    const recorded = k.journal.filter((e) => e.kind === 'menu-source');
    assert.equal(recorded.length, 2, `${broken}: enabled и checked - по записи, повтор того же не пишется`);
    assert.ok(recorded.every((e) => e.pluginId === 'menu'));
    await k.unload();
  }
});

test('меню: источник - член собственного контракта плагина', async () => {
  const flags = { open: true, project: true };
  const own = manifest('owner', {
    provides: { 'test.state': '1.0' },
    commands: ['owner.toggle', 'owner.project', 'owner.show'],
    contributes: { menus: [{ id: 'show', menu: 'view', title: 'Показать', command: 'owner.show', checked: { contract: 'test.state', major: 1, member: 'isOpen' } }] },
  });
  const k = await kernel({ owner: stateOwner(flags) }, { enabled: ['owner'], manifests: [own] });
  assert.deepEqual(brief(k), ['owner/show:on+']);
  await k.run('owner.toggle');
  await settle();
  assert.deepEqual(brief(k), ['owner/show:on-']);
  await k.unload();
});

test('ST-2002/6: меню: сочетание пункта занято в едином реестре клавиш - манифест проигрывает, динамическое отказано, оба видны в журнале', async () => {
  const flags = { open: false, project: true };
  const item = { ...open, accelerator: 'CmdOrCtrl+Shift+O' };
  const rival = manifest('rival', { commands: ['rival.run'], keybindings: [{ key: 'CmdOrCtrl+Shift+O', command: 'rival.run' }] });
  let register: ((key: string) => Promise<unknown>) | undefined;
  const dynamic: PluginModule = {
    activate(ctx) {
      register = (key) => ctx.keys.register({ key, command: 'dyn.run' });
      ctx.commands.register('dyn.run', () => undefined);
      return undefined;
    },
  };
  const k = await kernel(
    { owner: stateOwner(flags), menu: menuPlugin, rival: quiet, dyn: dynamic },
    { enabled: ['owner', 'menu', 'rival', 'dyn'], manifests: [ownerManifest, menuManifest([item]), rival, manifest('dyn', { commands: ['dyn.run'] })], platform: 'linux' },
  );
  const bound = k.keybinding('Ctrl+Shift+O');
  assert.deepEqual([bound?.pluginId, bound?.command], [MENU_OWNER, 'menu/open'], 'сочетание пункта в таблице: владелец - меню, команда - пункт');
  assert.deepEqual(bound?.shadowed, [{ pluginId: 'rival', command: 'rival.run' }]);
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'key-conflict').map((e) => `${e.pluginId}->${e.winner}`),
    ['rival->cyborg.menu'],
    'манифест, проигравший акселератору пункта, назван в журнале',
  );
  await assert.rejects(register?.('Ctrl+Shift+O') ?? Promise.reject(new Error('нет register')), { code: 'CommandConflict' });
  assert.deepEqual(
    k.journal.filter((e) => e.kind === 'key-conflict').map((e) => `${e.pluginId}->${e.winner}`),
    ['rival->cyborg.menu', 'dyn->cyborg.menu'],
    'отказанная динамическая регистрация тоже записана',
  );
  assert.equal(k.menus[0]?.accelerator, 'CmdOrCtrl+Shift+O', 'пункт держит сочетание: в снимке оно записью манифеста, которую понимает меню ОС');
  await k.unload();
});

test('меню: сочетание, которое человек отдал другой команде или освободил, из снимка уходит - меню ОС его не покажет', async () => {
  const item = { ...open, accelerator: 'CmdOrCtrl+Shift+O' };
  const run = async (keybindings: { key: string; command: string | null }[]) => {
    const k = await kernel({ owner: stateOwner({ open: false, project: true }), menu: menuPlugin }, { enabled: ['owner', 'menu'], manifests: [ownerManifest, menuManifest([item])], platform: 'linux', keybindings });
    const accelerator = k.menus[0]?.accelerator;
    const bound = k.keybinding('Ctrl+Shift+O');
    await k.unload();
    return { accelerator, bound: bound ? `${bound.pluginId}:${bound.command}` : undefined };
  };
  assert.deepEqual(await run([]), { accelerator: 'CmdOrCtrl+Shift+O', bound: 'cyborg.menu:menu/open' });
  assert.deepEqual(await run([{ key: 'Ctrl+Shift+O', command: null }]), { accelerator: undefined, bound: undefined }, 'null освобождает сочетание, пункт остаётся без него');
  assert.deepEqual(await run([{ key: 'Ctrl+Shift+O', command: 'menu.more' }]), { accelerator: undefined, bound: 'menu:menu.more' }, 'сочетание у человека - у пункта его нет');
});

test('меню: два пункта на одно сочетание - первый по id плагина и пункта, второй в журнале без сочетания', async () => {
  const mk = (id: string) => manifest(id, { commands: [`${id}.run`], contributes: { menus: [{ id: 'run', menu: 'tools', title: id, command: `${id}.run`, accelerator: 'F7' }] } });
  const k = await kernel({ a: quiet, b: quiet }, { enabled: ['a', 'b'], manifests: [mk('b'), mk('a')], platform: 'linux' });
  assert.deepEqual(k.menus.map((e) => `${e.pluginId}:${e.accelerator ?? '-'}`), ['a:F7', 'b:-']);
  const ignored = k.journal.filter((e) => e.kind === 'key-ignored');
  assert.equal(ignored.length, 1);
  assert.match(describeEntry(ignored[0]!), /сочетание меню занято пунктом меню a\/run/);
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
