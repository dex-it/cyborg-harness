import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { load as loadKernel, type Kernel, type LoadOptions } from '../src/loader.ts';
import { trackKernels } from './kernels.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// Ядро выгружается после каждого теста файла, и упавшим тоже: иначе слежение и программы держат процесс файла (core/test/kernels.ts).
const track = trackKernels();
const load = async (options: LoadOptions): Promise<Kernel> => track(await loadKernel(options));

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

function start(table: Record<string, PluginModule>, ids: string[], hosts: Record<string, string[]>) {
  const spawned: string[] = [];
  const handles: HostHandle[] = [];
  const base = inlineHosts(async (entry) => table[entry]!);
  return {
    spawned,
    handles,
    kernel: load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ids,
      manifests: ids.map((id) => manifest(id)),
      hosts,
      bundled: ids,
      watchdog: { interval: 20, timeout: 200 },
      spawnHost: (id) => {
        spawned.push(id);
        const h = base(id);
        handles.push(h);
        return h;
      },
    }),
  };
}

test('stress-restart: unload во время перезапуска хоста - новые хосты не запускаются, процессы остановлены', async () => {
  let activations = 0;
  const slow: PluginModule = {
    async activate() {
      activations++;
      await sleep(40);
    },
  };
  const t = start({ a: slow, b: slow, c: slow }, ['a', 'b', 'c'], { h: ['a', 'b', 'c'] });
  const k = await t.kernel;
  const before = activations;
  t.handles[0]?.kill();
  await sleep(5);
  await k.unload();
  const spawned = t.spawned.length;
  await sleep(150);
  assert.equal(t.spawned.length, spawned, 'после unload новых хостов нет');
  assert.deepEqual([...k.active], []);
  assert.ok(activations - before <= 3);
});

test('stress-restart: падение хоста в момент его собственной выгрузки (disable, deactivate в полёте) - disable завершается, плагин не возвращается', async () => {
  const stubborn: PluginModule = {
    activate: (ctx) => {
      ctx.subscriptions.add({
        dispose: () => {
          // Освобождение ресурсов, во время которого хост умирает.
        },
      });
    },
  };
  const t = start({ a: stubborn, b: stubborn }, ['a', 'b'], { ha: ['a'], hb: ['b'] });
  const k = await t.kernel;
  const d = k.disable('a');
  t.handles[0]?.kill();
  await d;
  await k.idle();
  assert.deepEqual([...k.active], ['b']);
  await sleep(100);
  assert.deepEqual([...k.active], ['b'], 'сторож не поднял выключенного');
  await k.unload();
});

test('stress-restart: 30 падений подряд посреди живой работы с 20 вызовами в полёте - вызовы получают HostGone, ядро и сосед целы', async () => {
  const worker: PluginModule = {
    activate(ctx) {
      ctx.commands.register('w.slow', () => new Promise((resolve) => setTimeout(() => resolve('done'), 20)));
    },
  };
  const other: PluginModule = { activate: (ctx) => void ctx.commands.register('o.ping', () => 'pong') };
  const ids = ['w', 'o'];
  const spawned: { id: string; h: HostHandle }[] = [];
  const base = inlineHosts(async (entry) => (entry === 'w' ? worker : other));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests: [manifest('w', { commands: { 'w.slow': {} } }), manifest('o', { commands: { 'o.ping': {} } })],
    hosts: { hw: ['w'], ho: ['o'] },
    bundled: ids,
    watchdog: { interval: 20, timeout: 200, strikes: 1000 },
    spawnHost: (id) => {
      const h = base(id);
      spawned.push({ id, h });
      return h;
    },
  });
  for (let round = 0; round < 30; round++) {
    const calls = Array.from({ length: 20 }, () => k.run('w.slow').then(() => 'ok', (e: unknown) => (e as { code?: string }).code ?? 'err'));
    await sleep(5);
    spawned.findLast((s) => s.id === "hw")?.h.kill();
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r === 'ok' || r === 'HostGone'), `раунд ${String(round)}: ${results.join(',')}`);
    await k.idle();
    assert.equal(await k.run('o.ping'), 'pong');
  }
  assert.deepEqual([...k.active].sort(), ['o', 'w']);
  await k.unload();
});
