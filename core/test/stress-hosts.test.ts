import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { load, type JournalEntry, type Kernel, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { waitFor } from './wait-for.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

/** Ядро на inline-хостах; handles[i] - i-й запущенный хост, kill() даёт «падение процесса». */
function rig(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>, hook?: (n: number) => void) {
  const handles: HostHandle[] = [];
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  return {
    handles,
    start: () =>
      load({
        apiVersion: PLUGIN_API_VERSION,
        watchdog: { interval: 20, timeout: 200 },
        spawnHost: (id) => {
          hook?.(handles.length + 1);
          const h = base(id);
          handles.push(h);
          return h;
        },
        ...options,
      }),
  };
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: не завершилось за ${String(ms)} мс`)))]);

const kinds = (k: Kernel, kind: JournalEntry['kind']) => k.journal.filter((e) => e.kind === kind);

test('stress-hosts: spawnHost бросает при перезапуске после падения - ядро остаётся управляемым (idle, disable, unload)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let attempts = 0;
    const r = rig({ a: { activate: () => undefined } }, { enabled: ['a'], manifests: [manifest('a')] }, (n) => {
      attempts = n;
      if (n >= 2) throw new Error('spawn EAGAIN');
    });
    const k = await r.start();
    r.handles[0]?.kill();
    await waitFor('сторож попытался перезапустить хост', () => attempts >= 2);
    // SAD 3.2/3.5: отказ запуска - запись в журнале у этого плагина, а не вечный отказ всех операций ядра.
    await within(k.idle(), 500, 'idle после неудачного перезапуска');
    await within(k.disable('a'), 500, 'disable после неудачного перезапуска');
    await within(k.unload(), 500, 'unload после неудачного перезапуска');
    assert.deepEqual(unhandled, [], 'отказ spawn не должен всплывать как unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('stress-hosts: падение хоста посреди активации - поставщик, отданный до падения, не остаётся мёртвой заготовкой старого хоста', async () => {
  let first = true;
  let provided!: () => void;
  const seen = new Promise<void>((resolve) => (provided = resolve));
  const files: PluginModule = {
    async activate(ctx) {
      ctx.contracts.provide('test.files', '1.0', { read: (p: string) => `data:${p}` });
      ctx.commands.register('files.ping', () => 'pong');
      if (first) {
        first = false;
        provided();
        await new Promise(() => undefined);
      }
    },
  };
  const logs: string[] = [];
  const r = rig(
    { files, consumer: { activate: () => undefined } },
    {
      enabled: ['files', 'consumer'],
      manifests: [
        manifest('files', { provides: { 'test.files': '1.0' }, commands: { 'files.ping': {} } }),
        manifest('consumer', { optional: { 'test.files': '^1' } }),
      ],
      hosts: { f: ['files'], c: ['consumer'] },
      bundled: ['files', 'consumer'],
      onLog: (id, message) => void logs.push(`${id}: ${message}`),
    },
  );
  const loading = r.start();
  await seen;
  await sleep(20);
  const filesHost = r.handles[0];
  assert.ok(filesHost);
  filesHost.kill();
  const k = await within(loading, 3000, 'load');
  await k.idle();
  assert.equal(await k.run('files.ping'), 'pong');
  // Вид потребителя ходит в поставщика через callAs: реестр ядра должен держать нового поставщика, а не заготовку упавшего хоста.
  assert.equal(await within(k.callAs('consumer', 'test.files', 1, 'read', ['y']), 1000, 'callAs'), 'data:y');
  assert.deepEqual(
    logs.filter((l) => l.includes('уже отдан')),
    [],
    'новая активация не должна упираться в «уже отдан» от упавшей',
  );
  await k.unload();
});

test('stress-hosts: сбои «подряд» - сбой позже окна после прошлого начинает счёт заново, плагин не выключается на третьем падении за всё время', async () => {
  let n = 0;
  let hangs = 0;
  const p: PluginModule = {
    activate(ctx) {
      n++;
      ctx.commands.register('p.hang', () => {
        hangs++;
        return new Promise(() => undefined);
      });
      ctx.commands.register('p.ok', () => 'ok');
      return undefined;
    },
  };
  // Окно 50 мс вместо 10 минут: между падениями теста 60 мс здоровой работы.
  const r = rig({ p }, { enabled: ['p'], manifests: [manifest('p', { commands: { 'p.hang': {}, 'p.ok': {} } })], watchdog: { interval: 20, timeout: 200, window: 50 } });
  const k = await r.start();
  for (let i = 0; i < 3; i++) {
    const hung = k.run('p.hang').catch(() => undefined);
    await waitFor('команда p.hang зависла в хосте', () => hangs === i + 1);
    r.handles[r.handles.length - 1]?.kill();
    await hung;
    await k.idle();
    assert.equal(await k.run('p.ok').catch((e: unknown) => String(e)), 'ok', `после падения ${String(i + 1)} плагин должен быть жив`);
    await sleep(60);
  }
  // SAD 3.5: «после трёх зависаний подряд плагин выключается» - три падения со здоровой работой между ними не подряд.
  assert.deepEqual(kinds(k, 'switched-off'), []);
  assert.equal(n, 4);
  await k.unload();
});

test('stress-hosts: wake и enable одного ленивого плагина одновременно - одна активация, одна запись в active', async () => {
  let activations = 0;
  const lazy: PluginModule = {
    async activate() {
      activations++;
      await sleep(40);
    },
  };
  const r = rig({ l: lazy }, { enabled: ['l'], manifests: [manifest('l', { activation: 'lazy' })] });
  const k = await r.start();
  await Promise.all([k.wake('l'), k.enable('l')]);
  await k.idle();
  assert.equal(activations, 1, 'код плагина активирован один раз');
  assert.deepEqual(
    k.active.filter((id) => id === 'l'),
    ['l'],
  );
  await k.disable('l');
  assert.deepEqual(k.active, [], 'после disable плагин не остаётся в active');
  await k.unload();
});
