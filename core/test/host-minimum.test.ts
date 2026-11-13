// TR-03 (docs/research/trust-and-isolation/06-work-plan.md): хост получает только своё. Канал ядро - хост записывается в подставном хосте
// (так же, как подделки в trust.test.ts), настоящий процесс с нарушителем - playground/test/real/trust-real-host.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load } from '../src/loader.ts';
import type { Kernel } from '../src/kernel-types.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type SpawnHost } from '../src/transports.ts';

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'test.vault': { 1: { readonly token: string; read(): Promise<string> } };
  }
}

const TOKEN = 'vault-data-of-provider';
const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
const settle = () => new Promise((r) => setImmediate(r));

interface Sent {
  readonly t?: string;
  readonly m?: string;
  readonly p?: { readonly manifests?: readonly { readonly id: string }[]; readonly bindings?: readonly (readonly [string, unknown])[]; readonly contract?: string; readonly providers?: readonly { readonly pluginId: string; readonly data: { readonly token?: string } }[] };
}

/** Хосты в процессе плюс запись всего, что ядро отправило каждому хосту; `kill` роняет хост, как падение процесса. */
function recording(table: Record<string, PluginModule>) {
  const sent = new Map<string, Sent[]>();
  const killers = new Map<string, () => void>();
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  const spawn: SpawnHost = (hostId) => {
    const real = base(hostId);
    const log = sent.get(hostId) ?? [];
    sent.set(hostId, log);
    killers.set(hostId, () => {
      real.kill();
    });
    return {
      port: {
        post(message, transfer) {
          log.push(structuredClone(message) as Sent);
          real.port.post(message, transfer);
        },
        onMessage(listener) {
          real.port.onMessage(listener);
        },
      },
      kill: () => real.kill(),
      onExit(listener) {
        real.onExit(listener);
      },
    };
  };
  const received = (hostId: string, method: string): Sent[] => (sent.get(hostId) ?? []).filter((m) => m.m === method);
  return { spawn, received, kill: (hostId: string) => killers.get(hostId)?.() };
}

const table: Record<string, PluginModule> = {
  prov: {
    activate(ctx) {
      const impl = { token: TOKEN, read: async () => TOKEN };
      let handle = ctx.contracts.provide('test.vault', '1.0', impl);
      ctx.commands.register('prov.reprovide', () => {
        handle.dispose();
        handle = ctx.contracts.provide('test.vault', '1.0', impl);
      });
    },
  },
  cons: {
    activate(ctx) {
      ctx.commands.register('cons.read', async () => (await ctx.contracts.get('test.vault', 1)?.read()) ?? null);
    },
  },
  opt: {
    activate(ctx) {
      ctx.commands.register('opt.read', async () => (await ctx.contracts.get('test.vault', 1)?.read()) ?? null);
    },
  },
  all: {
    activate(ctx) {
      ctx.commands.register('all.count', () => ctx.contracts.all('test.vault', 1).length);
    },
  },
  other: { activate: (ctx) => void ctx.commands.register('other.ping', () => 'other') },
};

const MANIFESTS = [
  manifest('prov', { provides: { 'test.vault': '1.0' }, commands: ['prov.reprovide'] }),
  manifest('cons', { requires: { 'test.vault': '^1' }, commands: ['cons.read'] }),
  manifest('opt', { optional: { 'test.vault': '^1' }, commands: ['opt.read'] }),
  manifest('all', { consumes: { 'test.vault': '^1' }, commands: ['all.count'] }),
  manifest('other', { commands: ['other.ping'] }),
];
const IDS = MANIFESTS.map((m) => m.id);
// Хост на плагин: id хоста - буква-приставка, чтобы в проверках не путать плагин и хост.
const HOSTS = { hp: ['prov'], hc: ['cons'], ho: ['opt'], ha: ['all'], hx: ['other'] };

async function start(): Promise<{ kernel: Kernel; rec: ReturnType<typeof recording> }> {
  const rec = recording(table);
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: IDS,
    manifests: MANIFESTS,
    bundled: IDS,
    hosts: HOSTS,
    spawnHost: rec.spawn,
    watchdog: { interval: 1000, timeout: 30_000 },
  });
  await kernel.idle();
  return { kernel, rec };
}

const providerIds = (note: Sent) => (note.p?.providers ?? []).map((d) => d.pluginId);
const leaked = (rec: ReturnType<typeof recording>, hostId: string) => rec.received(hostId, 'contracts').filter((n) => (n.p?.providers ?? []).some((d) => d.data.token === TOKEN));

test('TR-03: contracts с данными поставщика идут только в хосты, где объявлен потребитель (requires, optional, consumes)', async () => {
  const { kernel, rec } = await start();
  for (const host of ['hc', 'ho', 'ha']) {
    const notes = rec.received(host, 'contracts');
    assert.ok(notes.some((n) => providerIds(n).includes('prov')), `${host}: описание поставщика пришло`);
  }
  assert.deepEqual(rec.received('hx', 'contracts'), [], 'хост без потребителя контракта не получает ничего');
  assert.deepEqual(rec.received('hp', 'contracts'), [], 'хост одного поставщика без потребителя тоже: свои данные у него и так есть');
  assert.deepEqual(leaked(rec, 'hx'), []);
  // Фильтр не ломает зеркало: потребители во всех трёх видах привязки видят поставщика.
  assert.equal(await kernel.run('cons.read'), TOKEN);
  assert.equal(await kernel.run('opt.read'), TOKEN);
  assert.equal(await kernel.run('all.count'), 1);
  await kernel.unload();
});

test('TR-03: повторная отдача контракта рассылается тем же хостам, посторонний хост по-прежнему ничего не получает', async () => {
  const { kernel, rec } = await start();
  const before = rec.received('hc', 'contracts').length;
  await kernel.run('prov.reprovide');
  await settle();
  assert.ok(rec.received('hc', 'contracts').length > before, 'потребитель узнал о новой отдаче');
  assert.deepEqual(rec.received('hx', 'contracts'), []);
  assert.equal(await kernel.run('cons.read'), TOKEN);
  await kernel.unload();
});

test('TR-03: disable и enable потребителя во время работы, затем падение его хоста - зеркало контракта снова актуально, посторонний хост пуст', async () => {
  const { kernel, rec } = await start();
  await kernel.disable('cons');
  await kernel.enable('cons');
  assert.equal(await kernel.run('cons.read'), TOKEN, 'после enable хост поднят заново и получил описание поставщика');
  assert.ok(rec.received('hc', 'contracts').length >= 2, 'announce при новом старте хоста');

  rec.kill('hc');
  await kernel.idle();
  await settle();
  await kernel.idle();
  assert.equal(await kernel.run('cons.read'), TOKEN, 'после перезапуска хоста сторожем');
  assert.ok(kernel.journal.some((e) => e.kind === 'host-restart'));
  assert.deepEqual(rec.received('hx', 'contracts'), []);
  assert.deepEqual(leaked(rec, 'hx'), []);
  await kernel.unload();
});

test('TR-03: поставщик выключен и включён снова - потребитель из другого хоста получает его заново', async () => {
  const { kernel, rec } = await start();
  await kernel.disable('prov');
  await kernel.enable('prov');
  await kernel.enable('cons');
  await kernel.idle();
  assert.equal(await kernel.run('cons.read'), TOKEN);
  assert.deepEqual(rec.received('hx', 'contracts'), []);
  await kernel.unload();
});

const initIds = (rec: ReturnType<typeof recording>, hostId: string): string[][] => rec.received(hostId, 'init').map((n) => (n.p?.manifests ?? []).map((m) => m.id).sort());

test('TR-03: init хосту несёт манифесты плагинов хоста и тех, с кем у них привязки графа; чужих манифестов нет', async () => {
  const { kernel, rec } = await start();
  assert.deepEqual(initIds(rec, 'hx'), [['other']], 'плагин без привязок: только свой манифест');
  assert.deepEqual(initIds(rec, 'hc'), [['cons', 'prov']], 'потребитель: свой манифест и поставщика');
  assert.deepEqual(initIds(rec, 'ho'), [['opt', 'prov']]);
  // consumes граф не привязывает (поставщиков много, они приходят описаниями в contracts), поэтому манифеста поставщика хост consumes-потребителя не получает.
  assert.deepEqual(initIds(rec, 'ha'), [['all']]);
  assert.deepEqual(initIds(rec, 'hp'), [['cons', 'opt', 'prov']], 'поставщик: свой манифест и тех, кто к нему привязан через requires и optional');
  // Привязки - только плагинов этого хоста: зеркало контрактов спрашивает о них, чужих привязок хост не получает.
  const bindings = (hostId: string) => rec.received(hostId, 'init').map((n) => (n.p?.bindings ?? []).map(([id]) => id));
  assert.deepEqual(bindings('hc'), [['cons']]);
  assert.deepEqual(bindings('hx'), [['other']]);
  await kernel.unload();
});

test('TR-03: init после disable, enable и перезапуска хоста тот же, зеркало хоста работает', async () => {
  const { kernel, rec } = await start();
  await kernel.disable('cons');
  await kernel.enable('cons');
  rec.kill('hc');
  await kernel.idle();
  await settle();
  await kernel.idle();
  assert.equal(await kernel.run('cons.read'), TOKEN);
  const inits = initIds(rec, 'hc');
  assert.ok(inits.length >= 2, 'хост поднимался заново');
  for (const ids of inits) assert.deepEqual(ids, ['cons', 'prov']);
  assert.deepEqual(initIds(rec, 'hx'), [['other']]);
  await kernel.unload();
});
