import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakePty } from '../../testing/src/fake-pty.ts';
import { memorySecrets } from '../../testing/src/memory.ts';
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

test('ST-2002/1: register: чужой хост не перехватывает команду и не регистрирует необъявленную', async () => {
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

test('ST-2002/1: run: ядро сверяет аргументы со схемой манифеста до обработчика, откуда бы ни пришла команда', async () => {
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

test('ST-3001/9: run: вызывающего называет канал - чужой плагин в caller и запрос без него отклоняются, команда без callers недоступна главной части', async () => {
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

test('ST-2001/4: invoke: метод контракта зовёт только связанный графом потребитель из своего хоста', async () => {
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

test('ST-2001/2, ST-5004/3: provide и section.write: хост не отдаёт необъявленное и не пишет чужие разделы', async () => {
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

test('ST-3001/9: сторонний плагин не делит хост: группа пользователя не даёт ему писать раздел соседа', async () => {
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

test('ST-2001/6: emit и release: чужой хост не стреляет в чужую подписку и не снимает её', async () => {
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
    manifests: [manifest('provider', { commands: { 'provider.slow': { callers: 'plugins' } } }), manifest('victim'), manifest('mallory')],
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

test('ST-4002/2: log и output: хост пишет строки только за свои плагины, неизвестный уровень отклоняется, строка без плагина идёт с меткой хоста', async () => {
  const forger = forging({ victim: { activate: () => undefined }, mallory: { activate: () => undefined } });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['victim', 'mallory'],
    manifests: [manifest('victim'), manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { v: ['victim'], m: ['mallory'] },
    onLog: (id, message, level) => logs.push(`${id} [${level}]: ${message}`),
  });

  forger.notify('m', 'log', { pluginId: 'mallory', message: 'свои слова', level: 'warn' });
  forger.notify('m', 'log', { pluginId: 'victim', message: 'слова от имени victim', level: 'info' });
  forger.notify('m', 'log', { pluginId: 'mallory', message: 'уровень из головы', level: 'fatal' });
  forger.notify('m', 'output', { pluginId: 'mallory', level: 'error', text: 'вывод mallory' });
  forger.notify('m', 'output', { pluginId: '', level: 'info', text: 'вывод хоста' });
  forger.notify('m', 'output', { pluginId: 'victim', level: 'info', text: 'вывод от имени victim' });
  forger.notify('m', 'output', { pluginId: '', level: 'trace', text: 'уровень из головы' });
  await settle();

  const fromM = logs.filter((l) => !l.startsWith('хост m [warn]: ядро отказало'));
  assert.deepEqual(fromM, ['mallory [warn]: свои слова', 'mallory [error]: вывод mallory', 'хост m [info]: вывод хоста']);
  assert.equal(logs.length - fromM.length, 4, logs.join('\n'));
  await kernel.unload();
});

test('output: поток строк хоста без плагина тоже под пределом частоты - одна сводная строка с меткой хоста, плагины хоста не задеты', async () => {
  const forger = forging({ mallory: { activate: () => undefined } });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['mallory'],
    manifests: [manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { m: ['mallory'] },
    limits: { logRate: 2, logWindowMs: 40 },
    onLog: (id, message, level) => logs.push(`${id} [${level}]: ${message}`),
  });

  for (let i = 0; i < 6; i++) forger.notify('m', 'output', { pluginId: '', level: i === 4 ? 'error' : 'info', text: `строка ${String(i)}` });
  await settle();
  for (const end = Date.now() + 2000; logs.length < 3 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(logs, [
    'хост m [info]: строка 0',
    'хост m [info]: строка 1',
    'хост m [warn]: строк сверх предела за интервал: 4, из них error: 1; последняя error: строка 4',
  ]);
  assert.deepEqual(kernel.journal.filter((e) => e.kind === 'log-summary'), [], 'у хоста нет плагина - сводная не в журнале плагина');
  assert.deepEqual(kernel.active, ['mallory']);
  await kernel.unload();
});

test('output: строка хоста вычёркивает только значения секретов плагинов этого хоста; короткое значение не вычёркивается нигде', async () => {
  const mine = `mine-${randomUUID()}`;
  const theirs = `theirs-${randomUUID()}`;
  const forger = forging({
    a: {
      activate: async (ctx) => {
        await ctx.os.secrets.set('long', theirs);
        await ctx.os.secrets.set('short', 'e');
      },
    },
    b: {
      activate: async (ctx) => {
        await ctx.os.secrets.set('long', mine);
        await ctx.os.secrets.set('short', 'abc');
      },
    },
  });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['a', 'b'],
    manifests: [manifest('a'), manifest('b')],
    spawnHost: forger.spawn,
    hosts: { ha: ['a'], hb: ['b'] },
    os: { dataDir: tmpdir(), tempDir: tmpdir(), secrets: memorySecrets() },
    onLog: (id, message, level) => logs.push(`${id} [${level}]: ${message}`),
  });

  forger.notify('hb', 'output', { pluginId: '', level: 'error', text: `Error: heap exhausted in renderer; ${theirs}; ${mine}; abc` });
  await settle();

  // Секрет соседнего хоста в чужой строке не секрет, значения короче 4 символов не заменяются вовсе: замена испортила бы строку, а скрыть такое значение нельзя.
  assert.deepEqual(logs, [`хост hb [error]: Error: heap exhausted in renderer; ${theirs}; [секрет]; abc`]);
  await kernel.unload();
});

test('log: отказ ядра по заметке хоста идёт под теми же пределами длины и частоты, что строки плагина, и без секретов', async () => {
  const secret = `s3cr3t-${randomUUID()}`;
  const forger = forging({ a: { activate: async (ctx) => { await ctx.os.secrets.set('k', secret); } }, b: { activate: () => undefined } });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['a', 'b'],
    manifests: [manifest('a'), manifest('b')],
    spawnHost: forger.spawn,
    hosts: { ha: ['a'], hb: ['b'] },
    os: { dataDir: tmpdir(), tempDir: tmpdir(), secrets: memorySecrets() },
    limits: { logRate: 2, logLineBytes: 64, logWindowMs: 10_000 },
    onLog: (id, message, level) => logs.push(`${id} [${level}]: ${message}`),
  });

  // Код плагина в хосте пишет в канал напрямую: pluginId в 100 000 символов отказ повторяет в тексте.
  for (let i = 0; i < 50; i++) forger.notify('hb', 'log', { pluginId: `${secret}${'x'.repeat(100_000)}`, message: 'x', level: 'info' });
  await settle();

  assert.equal(logs.length, 2, `строк мимо предела частоты: ${String(logs.length)}`);
  for (const l of logs) {
    assert.ok(Buffer.byteLength(l) < 200, `строка ${String(Buffer.byteLength(l))} Б`);
    assert.ok(l.includes('[обрезано: всего'), l);
  }
  await kernel.unload();
  assert.equal(logs.length, 3, 'сводная запись при выгрузке');
  assert.match(logs[2] ?? '', /^хост hb \[warn\]: строк сверх предела за интервал: 48, из них error: 0$/);
  assert.ok(!logs.join('\n').includes(secret));
});

test('output: сводная строка хоста без плагина, не дождавшаяся конца интервала, пишется при выгрузке ядра', async () => {
  const forger = forging({ m: { activate: () => undefined } });
  const logs: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['m'],
    manifests: [manifest('m')],
    spawnHost: forger.spawn,
    hosts: { h: ['m'] },
    limits: { logRate: 1, logWindowMs: 600_000 },
    onLog: (id, message, level) => logs.push(`${id} [${level}]: ${message}`),
  });

  for (let i = 0; i < 4; i++) forger.notify('h', 'output', { pluginId: '', level: i === 3 ? 'error' : 'info', text: `строка ${String(i)}` });
  await settle();
  assert.deepEqual(logs, ['хост h [info]: строка 0']);
  await kernel.unload();
  assert.deepEqual(logs, ['хост h [info]: строка 0', 'хост h [warn]: строк сверх предела за интервал: 3, из них error: 1; последняя error: строка 3']);
});

test('ST-3001/1: os: плагин без прав - у ctx.os нет членов под правом, а каждый запрос шлюзу в обход ctx.os (fs вне области, process, все члены pty, net, serve, env, clipboard, secrets.ref, shell, notify, ui.lock, security.roots) - PermissionDenied и запись denied', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-trust-os-')));
  const outside = path.join(root, 'outside');
  const file = path.join(outside, 'secret.txt');
  await mkdir(outside);
  await writeFile(file, 'чужое');
  let members: string[] = [];
  const effects: string[] = [];
  const pty = fakePty();
  const forger = forging({
    mallory: {
      activate: (ctx) => {
        members = Object.keys(ctx.os).sort();
      },
    },
  });
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['mallory'],
    manifests: [manifest('mallory')],
    spawnHost: forger.spawn,
    hosts: { m: ['mallory'] },
    os: {
      dataDir: path.join(root, 'data'),
      tempDir: path.join(root, 'temp'),
      pty,
      env: { HOME: root, TOKEN: 't' },
      secrets: memorySecrets(),
      notify: (title) => void effects.push(`notify ${title}`),
      fetch: (async () => {
        effects.push('fetch');
        return new Response('ok');
      }) as unknown as typeof fetch,
      clipboard: { readText: () => (effects.push('clipboard read'), 'буфер'), writeText: () => void effects.push('clipboard write') },
      shell: { openPath: async (p) => void effects.push(`openPath ${p}`), openExternal: async (u) => void effects.push(`openExternal ${u}`) },
    },
  });
  assert.deepEqual(members, ['dialog', 'fs', 'paths', 'secrets'], 'без права члена в ctx.os нет');
  const calls: [string, ...unknown[]][] = [
    ['fs.readText', file],
    ['fs.readSlice', file, 0, 16],
    ['fs.list', outside],
    ['fs.stat', file],
    ['fs.realpath', file],
    ['fs.watch', outside, 'w1'],
    ['fs.writeText', path.join(outside, 'new.txt'), 'x'],
    ['fs.mkdir', path.join(outside, 'dir')],
    ['fs.remove', file],
    ['process.run', '/bin/sh', ['-c', 'id']],
    ['pty.spawn', { program: '/bin/sh', args: [] }],
    ['pty.share', 'pty-1'],
    ['pty.list'],
    ['pty.attach', 'pty-1'],
    ['pty.write', 'pty-1', 'x'],
    ['pty.resize', 'pty-1', 80, 24],
    ['pty.kill', 'pty-1'],
    ['net.fetch', 'https://example.com/'],
    ['serve.http', 's1'],
    ['serve.close', 's1'],
    ['env.get', 'TOKEN'],
    ['clipboard.readText'],
    ['clipboard.writeText', 'x'],
    ['secrets.resolve', 'vault://kv/jira'],
    ['shell.openPath', file],
    ['shell.openExternal', 'https://example.com/'],
    ['notify.show', 'фишинг'],
    ['notify.close', 'n1'],
    ['ui.lock', {}],
    ['ui.unlock'],
    ['security.setRoots', [outside]],
  ];
  const codes: string[] = [];
  for (const [method, ...args] of calls) codes.push(`${method} ${String(code(await forger.request('m', 'os', { pluginId: 'mallory', method, args })))}`);
  assert.deepEqual(codes, calls.map(([method]) => `${method} PermissionDenied`));
  assert.deepEqual(
    kernel.journal.flatMap((e) => (e.kind === 'denied' ? [`${e.pluginId}:${e.method}`] : [])),
    calls.map(([method]) => `mallory:${method}`),
    'каждый отказ - запись denied',
  );
  assert.deepEqual(effects, [], 'до среды приложения не дошёл ни один вызов');
  assert.deepEqual(pty.procs, []);
  assert.equal(await readFile(file, 'utf8'), 'чужое');
  await kernel.unload();
  await rm(root, { recursive: true, force: true });
});

test('os: notify.show и notify.close плагина без права notify отклоняет шлюз ядра (PermissionDenied, запись denied), а не только отсутствие ctx.os.notify (PL-02)', async () => {
  const shown: string[] = [];
  const forger = forging({
    mallory: {
      activate: (ctx) => {
        if (ctx.os.notify !== undefined) shown.push('у плагина без права есть ctx.os.notify');
      },
    },
    bell: { activate: () => undefined },
  });
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['mallory', 'bell'],
    manifests: [manifest('mallory'), manifest('bell', { permissions: { notify: true } })],
    spawnHost: forger.spawn,
    hosts: { m: ['mallory'], b: ['bell'] },
    os: { dataDir: tmpdir(), tempDir: tmpdir(), notify: (title) => void shown.push(title) },
  });
  const os = (hostId: string, pluginId: string, method: string, ...args: unknown[]) => forger.request(hostId, 'os', { pluginId, method, args });
  // Хост подделывает запрос, который ctx.os плагина без права не даст отправить: члена notify у него нет.
  assert.equal(code(await os('m', 'mallory', 'notify.show', 'фишинг', 'нажми')), 'PermissionDenied');
  assert.equal(code(await os('m', 'mallory', 'notify.close', 'n1')), 'PermissionDenied');
  assert.deepEqual(shown, [], 'до среды приложения уведомление не дошло');
  assert.equal(code(await os('b', 'bell', 'notify.show', 'свой')), 'ok', 'плагин с правом показывает');
  assert.deepEqual(shown, ['свой']);
  assert.deepEqual(
    kernel.journal.flatMap((e) => (e.kind === 'denied' ? [`${e.pluginId}:${e.method}`] : [])),
    ['mallory:notify.show', 'mallory:notify.close'],
    'каждый отказ - запись в журнале плагина',
  );
  await kernel.unload();
});

test('ST-3001/1: os: право pty отняли новой версией манифеста - pty с persist прежней версии не пережил выгрузку ядра, а члены pty.* новой версии отказывают PermissionDenied (#241)', async () => {
  const backend = fakePty();
  const first = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['agent'],
    manifests: [manifest('agent', { permissions: { pty: ['/bin/sh'] } })],
    spawnHost: inlineHosts(async () => ({
      activate: async (ctx: PluginContext) => {
        await ctx.os.pty?.spawn({ program: '/bin/sh', persist: true });
      },
    })),
    os: { dataDir: tmpdir(), tempDir: tmpdir(), pty: backend },
  });
  assert.equal(backend.procs.length, 1, 'прежняя версия запустила pty с persist');
  await first.unload();
  assert.equal(backend.procs[0]?.killed, 'SIGHUP', 'persist держит pty только до падения хоста, выгрузка ядра завершает его: к новой версии он не доходит');

  const forger = forging({ agent: { activate: () => undefined } });
  const second = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['agent'],
    manifests: [manifest('agent', { version: '2.0.0' })],
    spawnHost: forger.spawn,
    hosts: { h: ['agent'] },
    os: { dataDir: tmpdir(), tempDir: tmpdir(), pty: backend },
  });
  const members: [string, ...unknown[]][] = [['pty.list'], ['pty.attach', 'pty-1'], ['pty.write', 'pty-1', 'x'], ['pty.kill', 'pty-1']];
  const codes: string[] = [];
  for (const [method, ...args] of members) codes.push(`${method} ${String(code(await forger.request('h', 'os', { pluginId: 'agent', method, args })))}`);
  assert.deepEqual(codes, members.map(([method]) => `${method} PermissionDenied`));
  assert.deepEqual(backend.procs[0].writes, [], 'в прежний процесс ничего не записано');
  assert.deepEqual(
    second.journal.flatMap((e) => (e.kind === 'denied' ? [e.method] : [])),
    members.map(([method]) => method),
  );
  await second.unload();
});
