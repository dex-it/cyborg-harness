import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Disposable, PluginContext } from '@cyborg/contracts';
import { DisposableStore, toDisposable } from '../src/disposable.ts';
import { load, type JournalEntry, type Kernel, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle, type SpawnHost } from '../src/transports.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

interface Rig {
  readonly spawned: string[];
  readonly handles: HostHandle[];
  readonly killed: () => number;
  /** Пока в наборе есть id хоста, пинги ему не доходят: сторож видит зависание. */
  readonly hung: Set<string>;
  start(): Promise<Kernel>;
}

function rig(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>): Rig {
  const spawned: string[] = [];
  const handles: HostHandle[] = [];
  const hung = new Set<string>();
  let killed = 0;
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  const spawnHost: SpawnHost = (id) => {
    spawned.push(id);
    const h = base(id);
    const wrapped: HostHandle = {
      port: {
        post: (m) => {
          const ping = typeof m === 'object' && m !== null && (m as { m?: string }).m === 'ping';
          if (!(ping && hung.has(id))) h.port.post(m);
        },
        onMessage: (l) => h.port.onMessage(l),
      },
      kill: () => {
        killed++;
        h.kill();
      },
      onExit: (l) => h.onExit(l),
    };
    handles.push(wrapped);
    return wrapped;
  };
  return { spawned, handles, hung, killed: () => killed, start: () => load({ apiVersion: '1.0.0', watchdog: { interval: 20, timeout: 150 }, spawnHost, ...options }) };
}

const kinds = (k: Kernel, kind: JournalEntry['kind']) => k.journal.filter((e) => e.kind === kind);
const heap = (): number => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  gc();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

interface Svc {
  watch(cb: (n: number) => void): Promise<Disposable>;
  ping(): Promise<string>;
}

declare module '@cyborg/contracts' {
  interface Contracts {
    'test.svc': { 1: object };
    'test.src': { 1: { readonly name: string } };
    'test.late': { 1: object };
    'test.chain': { 1: object };
  }
}

test('stress-lifecycle: 300 циклов disable/enable поставщика с потребителями и подписками - ничего не копится, хосты не текут', async () => {
  let live = 0;
  const subs: Svc[] = [];
  let seen = 0;
  const prov: PluginModule = {
    activate(ctx) {
      ctx.contracts.provide('test.svc', '1.0', {
        ping: () => 'pong',
        watch: (cb: (n: number) => void) => {
          live++;
          const t = setInterval(() => cb(1), 1);
          t.unref();
          return toDisposable(() => {
            live--;
            clearInterval(t);
          });
        },
      });
    },
  };
  const cons: PluginModule = {
    activate(ctx) {
      const svc = ctx.contracts.get('test.svc', 1) as unknown as Svc;
      subs.push(svc);
    },
  };
  const opt: PluginModule = {
    activate(ctx) {
      ctx.contracts.onChange('test.svc', () => {
        seen++;
      });
    },
  };
  const r = rig(
    { prov, cons, opt },
    {
      enabled: ['prov', 'cons', 'opt'],
      manifests: [manifest('prov', { provides: { 'test.svc': '1.0' } }), manifest('cons', { requires: { 'test.svc': '^1' } }), manifest('opt', { optional: { 'test.svc': '^1' } })],
      hosts: { p: ['prov'], c: ['cons'], o: ['opt'] },
      bundled: ['prov', 'cons', 'opt'],
    },
  );
  const k = await r.start();
  const resources = () => process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
  let heapAt50 = 0;
  const timersBefore = resources();
  for (let i = 0; i < 300; i++) {
    const svc = subs[subs.length - 1];
    assert.ok(svc, `цикл ${String(i)}: потребитель получил контракт`);
    await svc.watch(() => undefined);
    (await svc.watch(() => undefined)).dispose();
    await svc.watch(() => undefined);
    assert.equal(await svc.ping(), 'pong');
    await sleep(2);
    await k.disable('prov');
    assert.deepEqual([...k.active], ['opt'], `цикл ${String(i)}: требующий выгружен вместе с поставщиком`);
    assert.equal(live, 0, `цикл ${String(i)}: подписки поставщика сняты вместе с ним`);
    await k.enable('prov');
    assert.deepEqual([...k.active].sort(), ['cons', 'opt', 'prov']);
    if (i === 49) heapAt50 = heap();
  }
  assert.ok(seen >= 300, 'optional-потребитель получал onChange');
  const growth = heap() - heapAt50;
  assert.ok(growth < 25 * 1024 * 1024, `рост кучи за 250 циклов: ${String(Math.round(growth / 1024 / 1024))} МБ`);
  await k.unload();
  assert.equal(r.killed(), r.spawned.length, 'каждый запущенный хост остановлен');
  assert.equal(live, 0);
  assert.ok(resources() <= timersBefore, 'таймеры сторожа погашены');
});

test('stress-lifecycle: поставщики consumes приходят и уходят в цикле - all() всегда равен живым, onChange на каждую смену', async () => {
  const providers = Array.from({ length: 8 }, (_, i) => `src${String(i)}`);
  let ctxC!: PluginContext;
  let changes = 0;
  const table: Record<string, PluginModule> = {
    hub: {
      activate(ctx) {
        ctxC = ctx;
        ctx.contracts.onChange('test.src', () => {
          changes++;
        });
      },
    },
  };
  for (const id of providers) table[id] = { activate: (ctx) => void ctx.contracts.provide('test.src', '1.0', { name: id }) };
  const r = rig(table, {
    enabled: ['hub', ...providers],
    manifests: [manifest('hub', { consumes: { 'test.src': '^1' } }), ...providers.map((id) => manifest(id, { provides: { 'test.src': '1.0' } }))],
    hosts: { h: ['hub'], s: providers },
    bundled: ['hub', ...providers],
  });
  const k = await r.start();
  const names = () => ctxC.contracts.all('test.src', 1).map((p) => p.pluginId).sort();
  await sleep(20);
  assert.deepEqual(names(), [...providers].sort());
  const live = new Set(providers);
  for (let i = 0; i < 160; i++) {
    const id = providers[(i * 5) % providers.length]!;
    if (live.has(id)) {
      await k.disable(id);
      live.delete(id);
    } else {
      await k.enable(id);
      live.add(id);
    }
    await sleep(5);
    assert.deepEqual(names(), [...live].sort(), `шаг ${String(i)}`);
  }
  await sleep(20);
  assert.ok(changes >= 160, `onChange дошёл на каждую смену: ${String(changes)}`);
  await k.unload();
});

test('stress-lifecycle: цепочка из 30 плагинов по requires - disable корня выгружает всех в обратном порядке, enable возвращает всех', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, '0')}`);
  const table: Record<string, PluginModule> = {};
  const manifests = ids.map((id, i) => {
    const prev = ids[i - 1];
    table[id] = { activate: (ctx) => void ctx.contracts.provide(`test.c${String(i)}` as 'test.chain', '1.0', {}) };
    return manifest(id, { provides: { [`test.c${String(i)}`]: '1.0' }, ...(prev !== undefined && { requires: { [`test.c${String(i - 1)}`]: '^1' } }) });
  });
  const r = rig(table, { enabled: ids, manifests, hosts: Object.fromEntries(ids.map((id) => [id, [id]])), bundled: ids });
  const k = await r.start();
  assert.deepEqual([...k.active], ids);
  for (let round = 0; round < 5; round++) {
    const mark = k.journal.length;
    await k.disable('n00');
    assert.deepEqual([...k.active], []);
    const order = k.journal.slice(mark).filter((e) => e.kind === 'unloaded').map((e) => e.pluginId);
    assert.deepEqual(order, [...ids].reverse());
    await k.enable('n00');
    assert.deepEqual([...k.active], ids);
  }
  await k.unload();
  assert.equal(r.killed(), r.spawned.length);
});

test('stress-lifecycle: зависание хоста - сторож называет виновника, соседний хост жив, после третьего подряд плагин выключен, enable сбрасывает счёт', async () => {
  const table: Record<string, PluginModule> = {
    bad: { activate: (ctx) => { ctx.commands.register('bad.run', () => new Promise(() => undefined)); ctx.commands.register('bad.ok', () => 'ran'); } },
    good: { activate: (ctx) => void ctx.commands.register('good.run', () => 'fine') },
  };
  const r = rig(table, {
    enabled: ['bad', 'good'],
    manifests: [manifest('bad', { commands: { 'bad.run': {}, 'bad.ok': {} } }), manifest('good', { commands: { 'good.run': {} } })],
    hosts: { b: ['bad'], g: ['good'] },
    bundled: ['bad', 'good'],
  });
  const k = await r.start();
  for (let strike = 1; strike <= 3; strike++) {
    r.hung.add('b');
    // Незавершённый вызов в зависшем хосте: он и делает плагин виновником.
    const call = k.run('bad.run').catch((e: unknown) => e);
    await sleep(0);
    await sleep(250);
    r.hung.delete('b');
    await call;
    await k.idle();
    assert.equal(await k.run('good.run'), 'fine', 'соседний хост жив');
  }
  const downs = kinds(k, 'host-down') as Extract<JournalEntry, { kind: 'host-down' }>[];
  assert.ok(downs.length >= 1);
  assert.equal(kinds(k, "switched-off").length, 1, "после третьего зависания подряд плагин выключен");
  assert.ok(downs.every((d) => d.hostId === 'b' && d.reason === 'hang'));
  await k.enable('bad');
  assert.equal(await k.run('bad.ok'), 'ran', 'после «Включить снова» плагин работает');
  await k.unload();
});

test('stress-lifecycle: disable сразу после падения хоста - выключенный человеком плагин сторож не поднимает даже на миг', async () => {
  let activations = 0;
  const slow: PluginModule = {
    async activate() {
      activations++;
      await sleep(30);
    },
  };
  const r = rig({ a: slow, b: slow }, { enabled: ['a', 'b'], manifests: [manifest('a'), manifest('b')], hosts: { h: ['a', 'b'] }, bundled: ['a', 'b'] });
  const k = await r.start();
  const base = activations;
  r.handles[0]?.kill();
  const d = k.disable('a');
  await d;
  await k.idle();
  assert.deepEqual([...k.active], ['b'], 'выключенный человеком не возвращён сторожем');
  assert.equal(activations - base, 1, 'b поднят заново ровно раз, a - ни разу');
  await k.unload();
});

test('stress-lifecycle: активация дольше таймаута - запись failed, поздний provide плагина не оставляет поставщика в реестре', async () => {
  const gate: { open: () => void } = { open: () => undefined };
  const late: PluginModule = {
    async activate(ctx) {
      await new Promise<void>((resolve) => (gate.open = resolve));
      ctx.contracts.provide('test.late', '1.0', { hi: () => 'hi' });
    },
  };
  let consumerCtx!: PluginContext;
  const r = rig(
    { late, c: { activate: (ctx) => void (consumerCtx = ctx) } },
    {
      enabled: ['late', 'c'],
      manifests: [manifest('late', { provides: { 'test.late': '1.0' } }), manifest('c', { optional: { 'test.late': '^1' } })],
      hosts: { l: ['late'], c: ['c'] },
      bundled: ['late', 'c'],
      activationTimeout: 60,
    },
  );
  const k = await r.start();
  assert.equal(kinds(k, 'failed').length, 1);
  gate.open();
  await sleep(60);
  await k.idle();
  assert.deepEqual([...k.active], ['c']);
  assert.equal(consumerCtx.contracts.get('test.late', 1), undefined, 'провалившаяся активация не оставляет поставщика');
  await k.unload();
});

test('stress-lifecycle: DisposableStore - снятые по одному подписки не удерживаются хранилищем до его снятия', () => {
  const store = new DisposableStore();
  const before = heap();
  for (let i = 0; i < 1000; i++) {
    const payload = Buffer.alloc(64 * 1024, i % 256);
    const d = toDisposable(() => {
      assert.ok(payload.length > 0);
    });
    store.add(d);
    d.dispose();
  }
  const held = heap() - before;
  // Подписка, которую плагин сам снял (onChange, watch, subscribe в цикле), не должна жить в хранилище плагина до конца его жизни.
  assert.ok(held < 16 * 1024 * 1024, `хранилище удерживает ${String(Math.round(held / 1024 / 1024))} МБ снятых подписок`);
  store.dispose();
});

test('stress-lifecycle: зависание общего хоста - страйк получает тот, чей вызов хост принял после последнего пинга, а не сосед, честно ждущий своего', async () => {
  const table: Record<string, PluginModule> = {
    waiter: { activate: (ctx) => void ctx.commands.register('waiter.gh', () => new Promise(() => undefined)) },
    spinner: { activate: (ctx) => void ctx.commands.register('spinner.loop', () => new Promise(() => undefined)) },
  };
  const r = rig(table, {
    enabled: ['waiter', 'spinner'],
    manifests: [manifest('waiter', { commands: { 'waiter.gh': {} } }), manifest('spinner', { commands: { 'spinner.loop': {} } })],
    hosts: { shared: ['waiter', 'spinner'] },
    bundled: ['waiter', 'spinner'],
  });
  const k = await r.start();
  // Сосед ждёт долгий внешний вызов: хост за это время отвечает на пинги.
  const waiting = k.run('waiter.gh').catch((e: unknown) => e);
  await sleep(100);
  r.hung.add('shared');
  const spinning = k.run('spinner.loop').catch((e: unknown) => e);
  await sleep(250);
  r.hung.delete('shared');
  await Promise.all([waiting, spinning]);
  await k.idle();
  const downs = kinds(k, 'host-down') as Extract<JournalEntry, { kind: 'host-down' }>[];
  assert.deepEqual(
    downs.map((d) => d.culprits),
    [['spinner']],
  );
  await k.unload();
});
