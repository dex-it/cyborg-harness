import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import type { Subscription } from '@cyborg-harness/contracts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { PluginContext, PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

function ticker(): PluginModule {
  return {
    activate(ctx) {
      const listeners = new Set<(n: number, label: string) => void>();
      ctx.contracts.provide('test.ticker', '1.0', {
        onTick(listener, label = '') {
          const bound = (n: number) => listener(n, label);
          listeners.add(bound);
          return { dispose: () => void listeners.delete(bound) };
        },
        tick: (n) => listeners.forEach((l) => l(n, '')),
        listeners: () => listeners.size,
      });
      ctx.commands.register('ticker.count', () => listeners.size);
      return undefined;
    },
  };
}

async function start(extra: Partial<LoadOptions> = {}) {
  const got: string[] = [];
  const handles = new Map<string, HostHandle>();
  let ctx: PluginContext | undefined;
  const table: Record<string, PluginModule> = {
    ticker: ticker(),
    user: {
      activate(c) {
        ctx = c;
        return undefined;
      },
    },
  };
  const kernel = await load({
    apiVersion: '1.0.0',
    enabled: ['ticker', 'user'],
    manifests: [manifest('ticker', { provides: { 'test.ticker': '1.0' }, commands: ['ticker.count'] }), manifest('user', { optional: { 'test.ticker': '^1' } })],
    hosts: { t: ['ticker'], u: ['user'] },
    spawnHost: (hostId) => {
      const handle = inlineHosts(async (entry) => {
        const mod = table[entry];
        if (!mod) throw new Error(`нет модуля ${entry}`);
        return mod;
      })(hostId);
      handles.set(hostId, handle);
      return handle;
    },
    watchdog: { strikes: 1 },
    ...extra,
  });
  const api = ctx!.contracts.get('test.ticker', 1)!;
  const listen = (label: string): Promise<Subscription> => api.onTick((n, l) => void got.push(`${l || label}:${n}`), label);
  return { kernel, api, got, listen, ctx: ctx!, handles };
}

test('подписка через границу хоста: колбэк получает данные, dispose снимает его у поставщика', async () => {
  const { kernel, api, got, listen } = await start();
  const sub = await listen('a');
  assert.equal(typeof sub.dispose, 'function');
  assert.equal(await api.listeners(), 1);
  await api.tick(1);
  await settle();
  assert.deepEqual(got, ['a:1']);

  sub.dispose();
  await settle();
  assert.equal(await api.listeners(), 0);
  await api.tick(2);
  await settle();
  assert.deepEqual(got, ['a:1']);
  await kernel.unload();
});

test('подписка снимается, когда выгружен потребитель', async () => {
  const { kernel, api, listen } = await start();
  await listen('a');
  await listen('b');
  assert.equal(await api.listeners(), 2);
  await kernel.disable('user');
  await settle();
  assert.equal(await kernel.run('ticker.count'), 0);
  await kernel.unload();
});

test('хост потребителя упал: подписку снимает ядро, отписаться хосту уже некому', async () => {
  const { kernel, listen, handles } = await start();
  await listen('a');
  assert.equal(await kernel.run('ticker.count'), 1);
  handles.get('u')!.kill();
  await settle();
  assert.equal(await kernel.run('ticker.count'), 0);
  await kernel.unload();
});

test('поставщик выгружен: колбэки потребителя забыты, после возврата подписка берётся заново', async () => {
  const { kernel, got, listen, ctx } = await start();
  let changes = 0;
  ctx.contracts.onChange('test.ticker', () => changes++);
  await listen('a');
  await kernel.disable('ticker');
  await settle();
  assert.equal(ctx.contracts.get('test.ticker', 1), undefined);
  await kernel.enable('ticker');
  await settle();
  assert.equal(changes, 2);
  const again = ctx.contracts.get('test.ticker', 1)!;
  assert.equal(await again.listeners(), 0, 'новый процесс поставщика старых подписок не знает');
  await again.onTick((n) => void got.push(`b:${n}`));
  await again.tick(5);
  await settle();
  assert.deepEqual(got, ['b:5']);
  await kernel.unload();
});

test('метод без подписки в ответ: колбэк живёт только до ответа', async () => {
  const seen: number[] = [];
  let ctx: PluginContext | undefined;
  const kernel = await load({
    apiVersion: '1.0.0',
    enabled: ['each', 'user'],
    manifests: [manifest('each', { provides: { 'test.ticker': '1.0' } }), manifest('user', { requires: { 'test.ticker': '^1' } })],
    hosts: { e: ['each'], u: ['user'] },
    spawnHost: inlineHosts(async (entry) =>
      entry === 'each'
        ? {
            activate(c) {
              let later: ((n: number, label: string) => void) | undefined;
              c.contracts.provide('test.ticker', '1.0', {
                onTick(listener) {
                  listener(1, '');
                  later = listener;
                  return undefined as unknown as Subscription;
                },
                tick: (n) => later?.(n, ''),
                listeners: () => 0,
              });
              return undefined;
            },
          }
        : {
            activate(c) {
              ctx = c;
              return undefined;
            },
          },
    ),
  });
  const api = ctx!.contracts.get('test.ticker', 1)!;
  assert.equal(await api.onTick((n) => void seen.push(n)), undefined);
  await api.tick(2);
  await settle();
  assert.deepEqual(seen, [1], 'синхронный вызов до ответа дошёл, поздний - нет');
  await kernel.unload();
});

test('предел подписок потребителя: сверх предела - Invalid, снятая подписка освобождает место', async () => {
  const { kernel, api, listen } = await start({ limits: { subscriptions: 2 } });
  const a = await listen('a');
  await listen('b');
  await assert.rejects(listen('c'), { code: 'Invalid', message: /подписок через контракты больше 2/ });
  assert.equal(await api.listeners(), 2, 'отказ не дошёл до поставщика');
  a.dispose();
  await settle();
  await listen('c');
  assert.equal(await api.listeners(), 2);
  await kernel.unload();
});
