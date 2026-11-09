import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { CoreError } from '../src/errors.ts';
import { load } from '../src/loader.ts';
import type { PluginContext, PluginModule } from '../src/plugin.ts';
import { inlineHosts, type SpawnHost } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

interface Reply {
  readonly t: 'res';
  readonly id: number;
  readonly ok: boolean;
  readonly v?: unknown;
  readonly e?: { readonly code: string; readonly message: string };
}

const FORGED = 1_000_000;
const isForgedReply = (m: unknown): m is Reply =>
  typeof m === 'object' && m !== null && 't' in m && m.t === 'res' && 'id' in m && typeof m.id === 'number' && m.id >= FORGED;

/** Хосты в процессе плюс рука злоумышленника: сообщения от имени любого хоста идут прямо в ядро. */
function forging(table: Record<string, PluginModule>) {
  const toKernel = new Map<string, (m: unknown) => void>();
  const replies = new Map<number, (r: Reply) => void>();
  let next = FORGED;
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  const spawn: SpawnHost = (hostId) => {
    const real = base(hostId);
    return {
      port: {
        post(m) {
          if (!isForgedReply(m)) {
            real.port.post(m);
            return;
          }
          replies.get(m.id)?.(m);
          replies.delete(m.id);
        },
        onMessage(listener) {
          toKernel.set(hostId, listener);
          real.port.onMessage(listener);
        },
      },
      kill: () => real.kill(),
      onExit: (l) => real.onExit(l),
    };
  };
  const send = (hostId: string, message: unknown) => {
    const listener = toKernel.get(hostId);
    if (!listener) throw new Error(`хоста ${hostId} нет`);
    listener(structuredClone(message));
  };
  return {
    spawn,
    request(hostId: string, m: string, p: unknown): Promise<Reply> {
      const id = next++;
      return new Promise((resolve) => {
        replies.set(id, resolve);
        send(hostId, { t: 'req', id, m, p });
      });
    },
    notify: (hostId: string, m: string, p: unknown) => send(hostId, { t: 'note', m, p }),
    cancel: (hostId: string, id: unknown) => send(hostId, { t: 'cancel', id }),
  };
}

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
const settle = () => new Promise((r) => setImmediate(r));
const code = (r: Reply) => (r.ok ? 'ok' : r.e?.code);

test('register: чужой хост не перехватывает команду и не регистрирует необъявленную', async () => {
  const forger = forging({
    victim: { activate: (ctx) => ctx.commands.register('victim.save', () => 'сохранил victim') },
    mallory: { activate: () => undefined },
  });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['victim', 'mallory'],
    manifests: [manifest('victim', { commands: ['victim.save'] }), manifest('mallory', { commands: ['mallory.go'] })],
    spawnHost: forger.spawn,
    hosts: { v: ['victim'], m: ['mallory'] },
    onLog: (id, message) => logs.push(`${id}: ${message}`),
  });

  forger.notify('m', 'register', { pluginId: 'mallory', name: 'victim.save' });
  forger.notify('m', 'register', { pluginId: 'victim', name: 'victim.save' });
  forger.notify('m', 'register', { pluginId: 'mallory', name: 'mallory.undeclared' });
  forger.notify('m', 'unregister', { pluginId: 'victim', name: 'victim.save' });
  forger.notify('m', 'register', { pluginId: 'mallory', name: {} });
  await settle();

  assert.equal(await kernel.run('victim.save'), 'сохранил victim');
  await assert.rejects(kernel.run('mallory.undeclared'), (e: unknown) => e instanceof CoreError && e.code === 'CommandNotFound');
  const fromM = logs.filter((l) => l.startsWith('хост m: ядро отказало'));
  assert.equal(fromM.length, 5, logs.join('\n'));
  assert.ok(fromM.some((l) => l.includes('поле name не string')), fromM.join('\n'));
  await kernel.unload();
});

test('run: ядро сверяет аргументы со схемой манифеста до обработчика, откуда бы ни пришла команда', async () => {
  const seen: unknown[][] = [];
  const forger = forging({
    victim: {
      activate: (ctx) =>
        ctx.commands.register('victim.open', (...args) => {
          seen.push(args);
          return 'открыл';
        }),
    },
    mallory: { activate: () => undefined },
  });
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['victim', 'mallory'],
    manifests: [manifest('victim', { commands: { 'victim.open': { args: ['string', 'number?'], callers: 'plugins' } } }), manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { v: ['victim'], m: ['mallory'] },
  });
  const run = (args: unknown) => forger.request('m', 'run', { caller: 'mallory', name: 'victim.open', args });

  assert.equal((await run(['/a'])).v, 'открыл');
  assert.equal((await run(['/a', 3])).v, 'открыл');
  assert.equal(code(await run([{ path: '/etc/passwd' }])), 'Invalid');
  assert.equal(code(await run(['/a', '3'])), 'Invalid');
  assert.equal(code(await run([])), 'Invalid');
  assert.equal(code(await run(['/a', 3, 'лишний'])), 'Invalid');
  assert.equal(code(await run('/a')), 'Invalid');
  await assert.rejects(kernel.run('victim.open', 42), { code: 'Invalid', message: 'victim.open: аргумент 1 не string' });
  assert.deepEqual(seen, [['/a'], ['/a', 3]]);
  await kernel.unload();
});

test('run: вызывающего называет канал - чужой плагин в caller и запрос без него отклоняются, команда без callers недоступна главной части', async () => {
  const seen: unknown[][] = [];
  const forger = forging({
    victim: { activate: (ctx) => void ctx.commands.register('victim.pin', (...args) => void seen.push(args)) },
    mallory: { activate: () => undefined },
  });
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['victim', 'mallory'],
    manifests: [manifest('victim', { commands: ['victim.pin', 'victim.open'] }), manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { v: ['victim'], m: ['mallory'] },
  });
  const run = (body: Record<string, unknown>) => forger.request('m', 'run', { name: 'victim.pin', args: [], ...body });

  assert.equal(code(await run({ caller: 'mallory' })), 'PermissionDenied', 'victim.pin закрыта плагинам');
  assert.equal(code(await run({ caller: 'victim' })), 'Unavailable', 'хост m не держит victim: от его имени не зовут');
  assert.equal(code(await run({ caller: 'ghost' })), 'Unavailable');
  assert.equal(code(await run({})), 'Invalid', 'без caller запрос не принят: «пользователем» из хоста не назваться');
  assert.deepEqual(seen, []);
  assert.deepEqual(
    kernel.journal.flatMap((e) => (e.kind === 'denied' ? [`${e.pluginId}:${e.method}:${e.reason ?? '-'}`] : [])),
    ['mallory:victim.pin:command-callers'],
  );
  await kernel.unload();
});

test('invoke: метод контракта зовёт только связанный графом потребитель из своего хоста', async () => {
  let readerCtx: PluginContext | undefined;
  const forger = forging({
    files: {
      activate: (ctx) => ctx.contracts.provide('test.files', '1.0', { root: '/w', read: (p: string) => `data:${p}` }),
    },
    reader: {
      activate: (ctx) => {
        readerCtx = ctx;
        return undefined;
      },
    },
    watcher: { activate: () => undefined },
    mallory: { activate: () => undefined },
  });
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['files', 'reader', 'watcher', 'mallory'],
    manifests: [
      manifest('files', { provides: { 'test.files': ['1.0'] } }),
      manifest('reader', { requires: { 'test.files': '^1' } }),
      manifest('watcher', { consumes: { 'test.files': '^1' } }),
      manifest('mallory'),
    ],
    spawnHost: forger.spawn,
    hosts: { f: ['files'], r: ['reader'], w: ['watcher'], m: ['mallory'] },
  });
  const call = (host: string, fields: Record<string, unknown>) =>
    forger.request(host, 'invoke', { caller: 'reader', pluginId: 'files', contract: 'test.files', version: '1.0', member: 'read', args: ['x'], ...fields });

  assert.deepEqual(await call('r', {}), { t: 'res', id: FORGED, ok: true, v: 'data:x' });
  assert.equal((await call('w', { caller: 'watcher' })).v, 'data:x');
  assert.equal(code(await call('m', { caller: 'mallory' })), 'NotDeclared');
  assert.equal(code(await call('m', {})), 'Unavailable');
  assert.equal(code(await call('r', { member: 'toString' })), 'Unavailable');
  assert.equal(code(await call('r', { member: 'root' })), 'Unavailable');
  assert.equal(code(await call('r', { version: '2.0' })), 'Unavailable');
  assert.equal(code(await call('r', { caller: undefined })), 'Invalid');
  assert.equal(code(await call('r', { args: 5 })), 'Invalid');
  assert.equal(code(await call('f', { caller: 'files' })), 'NotDeclared');

  const ctx = readerCtx!;
  const files = ctx.contracts.get('test.files', 1);
  assert.ok(files);
  assert.equal(files, ctx.contracts.get('test.files', 1), 'одна ссылка на потребителя');
  assert.equal(files.root, '/w');
  assert.equal(await files.read?.('y'), 'data:y');
  await kernel.unload();
});

test('provide и section.write: хост не отдаёт необъявленное и не пишет чужие разделы', async () => {
  const forger = forging({
    victim: { activate: () => undefined, config: { defaults: { theme: 'light' } } },
    mallory: { activate: () => undefined },
    watcher: { activate: () => undefined },
  });
  const docs = new Map<string, Record<string, unknown>>();
  const store: LayerStore = { load: async (l) => docs.get(l), save: async (l, d) => void docs.set(l, d) };
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['victim', 'mallory', 'watcher'],
    manifests: [manifest('victim', { config: { version: 1 } }), manifest('mallory'), manifest('watcher', { consumes: { 'test.files': '^1' } })],
    spawnHost: forger.spawn,
    hosts: { v: ['victim'], m: ['mallory'], w: ['watcher'] },
    config: await SectionStore.open(store, ['user']),
    onLog: (id, message) => logs.push(`${id}: ${message}`),
  });
  const write = (host: string, fields: Record<string, unknown>) =>
    forger.request(host, 'section.write', { pluginId: 'victim', kind: 'config', layer: 'user', version: 1, data: { theme: 'evil' }, ...fields });

  assert.equal(code(await write('m', {})), 'Unavailable');
  assert.equal(code(await write('m', { pluginId: 'mallory' })), 'NotDeclared');
  assert.equal(code(await write('v', { kind: 'other' })), 'Invalid');
  assert.equal(code(await write('v', { version: '1' })), 'Invalid');
  assert.equal(code(await write('v', { version: 999 })), 'Invalid');
  assert.equal(code(await write('v', { version: 0 })), 'Invalid');
  assert.equal(docs.get('user'), undefined);
  assert.equal(code(await write('v', {})), 'ok', 'свой раздел своей версии хост пишет');
  assert.deepEqual(Object.keys(docs.get('user') ?? {}), ['victim']);

  forger.notify('m', 'provide', { pluginId: 'mallory', contract: 'test.files', version: '1.0', data: {}, methods: ['read'] });
  forger.notify('m', 'provide', { pluginId: 'victim', contract: 'test.files', version: '1.0', data: {}, methods: ['read'] });
  forger.notify('m', 'log', { pluginId: 'victim', message: 'это пишет victim' });
  await settle();
  assert.equal(kernel.contracts.all('watcher', 'test.files', 1).length, 0);
  assert.ok(!logs.some((l) => l.startsWith('victim:')), logs.join('\n'));
  assert.equal(logs.filter((l) => l.startsWith('хост m: ядро отказало')).length, 3, logs.join('\n'));
  await kernel.unload();
});

test('сторонний плагин не делит хост: группа пользователя не даёт ему писать раздел соседа', async () => {
  const start = async (bundled: string[]) => {
    const forger = forging({
      victim: { activate: () => undefined, config: { defaults: { theme: 'light' } } },
      mallory: { activate: () => undefined },
    });
    const docs = new Map<string, Record<string, unknown>>();
    const store: LayerStore = { load: async (l) => docs.get(l), save: async (l, d) => void docs.set(l, d) };
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ['victim', 'mallory'],
      manifests: [manifest('victim', { config: { version: 1 } }), manifest('mallory')],
      spawnHost: forger.spawn,
      hosts: { shared: ['victim', 'mallory'] },
      bundled,
      config: await SectionStore.open(store, ['user']),
    });
    const forge = (host: string) =>
      forger.request(host, 'section.write', { pluginId: 'victim', kind: 'config', layer: 'user', version: 1, data: { theme: 'evil' } });
    return { kernel, docs, forge };
  };

  const isolated = await start(['victim']);
  assert.deepEqual([isolated.kernel.hostOf('victim'), isolated.kernel.hostOf('mallory')], ['shared', 'mallory']);
  assert.equal(code(await isolated.forge('mallory')), 'Unavailable');
  assert.equal(isolated.docs.get('user'), undefined);
  await isolated.kernel.unload();

  // Контроль: два плагина из поставки в одном хосте ядро не различает - граница доверия проходит по процессу.
  const shared = await start(['victim', 'mallory']);
  assert.equal(shared.kernel.hostOf('mallory'), 'shared');
  assert.equal(code(await shared.forge('shared')), 'ok');
  await shared.kernel.unload();
});

test('emit и release: чужой хост не стреляет в чужую подписку и не снимает её', async () => {
  const seen: number[] = [];
  let emit: ((n: number) => void) | undefined;
  let reader: PluginContext | undefined;
  const forger = forging({
    ticker: {
      activate(ctx) {
        ctx.contracts.provide('test.ticker', '1.0', {
          onTick(listener) {
            emit = (n) => listener(n, '');
            return { dispose: () => (emit = undefined) };
          },
          tick: () => undefined,
          listeners: () => (emit ? 1 : 0),
        });
        return undefined;
      },
    },
    reader: {
      activate(ctx) {
        reader = ctx;
        return undefined;
      },
    },
    mallory: { activate: () => undefined },
  });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['ticker', 'reader', 'mallory'],
    manifests: [manifest('ticker', { provides: { 'test.ticker': '1.0' } }), manifest('reader', { requires: { 'test.ticker': '^1' } }), manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { t: ['ticker'], r: ['reader'], m: ['mallory'] },
    onLog: (id, message) => logs.push(`${id}: ${message}`),
  });
  const api = reader!.contracts.get('test.ticker', 1)!;
  await api.onTick((n) => void seen.push(n));
  const pause = async () => {
    for (let i = 0; i < 5; i++) await settle();
  };
  emit?.(1);
  forger.notify('m', 'emit', { subscription: 1, index: 0, args: [666] });
  forger.notify('m', 'release', { caller: 'mallory', subscription: 1 });
  forger.notify('m', 'release', { caller: 'reader', subscription: 1 });
  await pause();
  emit?.(2);
  await pause();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(await api.listeners(), 1);
  assert.equal(logs.filter((l) => l.startsWith('хост m: ядро отказало')).length, 3, logs.join('\n'));
  await kernel.unload();
});

test('cancel: чужой хост не отменяет запрос другого плагина, подделанные номера ничего не рвут', async () => {
  let victim!: PluginContext;
  let providerSignal: AbortSignal | undefined;
  let release: (() => void) | undefined;
  const forger = forging({
    provider: {
      activate: (ctx) =>
        ctx.commands.register('provider.slow', (...args) => {
          providerSignal = args.at(-1) as AbortSignal;
          return new Promise((resolve) => (release = () => resolve('готово')));
        }),
    },
    victim: { activate: (ctx) => void (victim = ctx) },
    mallory: { activate: () => undefined },
  });
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['provider', 'victim', 'mallory'],
    manifests: [manifest('provider', { commands: ['provider.slow'] }), manifest('victim'), manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { p: ['provider'], v: ['victim'], m: ['mallory'] },
  });
  const own = new AbortController();
  const call = victim.commands.run('provider.slow', own.signal);
  await settle();
  await settle();
  assert.equal(providerSignal!.aborted, false);

  // номера запросов у каждого канала свои: cancel от чужого хоста попадает в его собственный канал
  for (const host of ['m', 'p']) for (let id = -1; id < 30; id++) forger.cancel(host, id);
  for (const id of ['1', null, {}, [1]]) forger.cancel('m', id);
  await settle();
  await settle();
  assert.equal(providerSignal!.aborted, false, 'поставщик не отменён чужим cancel');
  release?.();
  assert.equal(await call, 'готово');

  const second = new AbortController();
  const again = victim.commands.run('provider.slow', second.signal);
  again.catch(() => undefined);
  await settle();
  await settle();
  second.abort();
  await assert.rejects(again, { code: 'Cancelled' });
  await settle();
  await settle();
  assert.equal(providerSignal!.aborted, true, 'свой cancel вызывающего доходит до поставщика');
  await kernel.unload();
});

test('keys.register и keys.unregister: хост не занимает сочетания и не снимает регистрации от чужого имени', async () => {
  const forger = forging({
    victim: { activate: () => undefined },
    mallory: { activate: () => undefined },
  });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['victim', 'mallory'],
    manifests: [manifest('victim', { commands: ['victim.save'] }), manifest('mallory', { commands: ['mallory.go'] })],
    spawnHost: forger.spawn,
    hosts: { v: ['victim'], m: ['mallory'] },
    platform: 'linux',
    onLog: (id, message) => logs.push(`${id}: ${message}`),
  });
  const register = (host: string, fields: Record<string, unknown>) =>
    forger.request(host, 'keys.register', { pluginId: 'victim', key: 'Ctrl+K', command: 'victim.save', args: [], when: {}, ...fields });

  assert.equal(code(await register('m', {})), 'Unavailable', 'от имени плагина чужого хоста');
  assert.equal(code(await register('v', { command: 'mallory.go' })), 'NotDeclared');
  assert.equal(code(await register('v', { key: {} })), 'Invalid');
  assert.equal(code(await register('v', { when: [] })), 'Invalid');
  assert.equal(code(await register('v', { args: {} })), 'Invalid');
  assert.equal(code(await register('v', { when: { repeat: 'sometimes' } })), 'Invalid');
  assert.equal(kernel.keybinding('Ctrl+K'), undefined);
  assert.equal(code(await register('v', {})), 'ok');
  forger.notify('m', 'keys.unregister', { pluginId: 'victim', id: 1 });
  forger.notify('m', 'keys.unregister', { pluginId: 'mallory', id: 1 });
  forger.notify('v', 'keys.unregister', { pluginId: 'victim', id: 'one' });
  await settle();
  assert.equal(kernel.keybinding('Ctrl+K')?.pluginId, 'victim', 'регистрацию victim чужой хост не снял');
  assert.equal(logs.filter((l) => l.startsWith('хост m: ядро отказало')).length, 1, logs.join('\n'));
  await kernel.unload();
});
