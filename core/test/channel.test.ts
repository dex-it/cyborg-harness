import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ViewChannel } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts } from '../src/transports.ts';

// K-13: канал «главная часть - вид» (FR-CH-2027). Вид глазами ядра - имя в `ui.views` и вызовы `Kernel.viewPost` / `onViewMessage`.
const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ui: { views: { main: './ui.js' } }, ...fields });

type Sent = [plugin: string, view: string, message: unknown];

/** Плагины-образцы: `inbox` собирает то, что вид прислал каналу `main`, `chans` отдаёт каналы наружу для проверок. */
function stand(extra: Record<string, PluginModule> = {}, manifests: Record<string, unknown>[] = [], options: Partial<LoadOptions> = {}) {
  const sent: Sent[] = [];
  const inbox: Record<string, unknown[]> = { a: [], b: [] };
  const chans: Record<string, ViewChannel> = {};
  const logs: string[] = [];
  const talker = (id: string): PluginModule => ({
    activate(ctx) {
      const channel = ctx.views.channel('main');
      chans[id] = channel;
      channel.onMessage((m) => void inbox[id]?.push(m));
      return undefined;
    },
  });
  const modules: Record<string, PluginModule> = { a: talker('a'), b: talker('b'), ...extra };
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-channel-'));
  const base = inlineHosts(async (entry) => {
    const mod = modules[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  const start = () =>
    load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: base,
      os: { dataDir: dir, tempDir: dir },
      enabled: Object.keys(modules),
      manifests: manifests.length > 0 ? manifests : [manifest('a', { ui: { views: { main: './ui.js', side: './side.js' } } }), manifest('b', { ui: { views: { main: './ui.js', own: './own.js' } } })],
      bundled: Object.keys(modules),
      hosts: { shared: ['a', 'b'] },
      onViewMessage: (pluginId, view, message) => void sent.push([pluginId, view, message]),
      onLog: (id, message) => void logs.push(`${id}: ${message}`),
      watchdog: { interval: 20, timeout: 1000, strikes: 3 },
      ...options,
    });
  return { start, sent, inbox, chans, logs };
}

test('канал: главная часть шлёт виду своего плагина, и только по имени вида из своего манифеста', async () => {
  const s = stand();
  const k = await s.start();
  await s.chans.a?.post({ n: 1 });
  await s.chans.b?.post('привет');
  assert.deepEqual(s.sent, [['a', 'main', { n: 1 }], ['b', 'main', 'привет']], 'сообщение несёт плагин и вид: окно отдаёт его фреймам только этого плагина с этим именем');

  // Вид `own` есть у b, у a его нет: a не достаёт до чужого вида по имени.
  await assert.rejects(k.viewPost('a', 'own', 1), { code: 'Invalid' });
  assert.equal(s.sent.length, 2);
  await k.unload();
});

test('канал: вид, которого нет в манифесте, - Invalid при первом post, а не молчание', async () => {
  let late: ViewChannel | undefined;
  const probe: PluginModule = {
    activate(ctx) {
      late = ctx.views.channel('nothing');
      return undefined;
    },
  };
  const s = stand({ probe }, [manifest('probe')]);
  const k = await s.start();
  await assert.rejects(late?.post(1) ?? Promise.reject(new Error('канал не выдан')), { code: 'Invalid' });
  assert.deepEqual(s.sent, []);
  await k.unload();
});

test('ST-2001/9: канал: сообщение сверх лимита - Invalid, не данные - NotCloneable, канал работает дальше', async () => {
  const s = stand();
  const k = await s.start();
  const big = 'я'.repeat(40 * 1024);
  await assert.rejects(s.chans.a?.post(big) ?? Promise.reject(new Error('нет канала')), { code: 'Invalid' }, 'лимит считается в байтах, а не в символах');
  await assert.rejects(s.chans.a?.post(() => 1) ?? Promise.reject(new Error('нет канала')), { code: 'NotCloneable' });
  await assert.rejects(k.viewPost('a', 'main', big), { code: 'Invalid' }, 'в обратную сторону тот же предел');
  await s.chans.a?.post('после отказов');
  await k.viewPost('a', 'main', 'и вид тоже');
  assert.deepEqual(s.sent, [['a', 'main', 'после отказов']]);
  assert.deepEqual(s.inbox.a, ['и вид тоже']);
  await k.unload();

  const wide = stand({}, [], { limits: { viewMessage: 100 } });
  const k2 = await wide.start();
  await assert.rejects(wide.chans.a?.post('x'.repeat(200)) ?? Promise.reject(new Error('нет канала')), { code: 'Invalid' }, 'предел задаёт приложение через limits');
  await wide.chans.a?.post('x'.repeat(50));
  await k2.unload();
});

test('канал: сообщение вида доходит до слушателей главной части своего плагина и только до них', async () => {
  const s = stand();
  const k = await s.start();
  await k.viewPost('a', 'main', { from: 'вид a' });
  await k.viewPost('b', 'main', { from: 'вид b' });
  assert.deepEqual(s.inbox.a, [{ from: 'вид a' }]);
  assert.deepEqual(s.inbox.b, [{ from: 'вид b' }]);
  await assert.rejects(k.viewPost('a', 'own', 1), { code: 'Invalid' }, 'вид a не пишет в канал вида b');
  await assert.rejects(k.viewPost('нет', 'main', 1), { code: 'Invalid' });
  await k.unload();
});

test('канал: упавший слушатель пишет в лог плагина и не мешает соседу и следующему сообщению', async () => {
  const seen: unknown[] = [];
  const twice: PluginModule = {
    activate(ctx) {
      const channel = ctx.views.channel('main');
      channel.onMessage(() => {
        throw new Error('сломан');
      });
      channel.onMessage((m) => void seen.push(m));
      return undefined;
    },
  };
  const s = stand({ twice }, [manifest('twice')]);
  const k = await s.start();
  await k.viewPost('twice', 'main', 1);
  await k.viewPost('twice', 'main', 2);
  await k.idle();
  assert.deepEqual(seen, [1, 2]);
  assert.ok(s.logs.some((l) => l.includes('twice: слушатель канала main упал: сломан')), s.logs.join('\n'));
  await k.unload();
});

test('канал: выгрузка плагина закрывает канал - post отказывает, сообщения вида не доходят, слушатели сняты', async () => {
  const s = stand();
  const k = await s.start();
  const channel = s.chans.a;
  await k.disable('a');
  await assert.rejects(channel?.post('после выгрузки') ?? Promise.reject(new Error('нет канала')), { code: 'Unavailable' });
  assert.deepEqual(s.sent, [], 'после выгрузки ничего не ушло виду');
  await assert.rejects(k.viewPost('a', 'main', 1), { code: 'Unavailable' });
  assert.deepEqual(s.inbox.a, []);
  // Сосед по хосту работает: выгрузка закрыла только каналы a.
  await s.chans.b?.post('b жив');
  assert.deepEqual(s.sent, [['b', 'main', 'b жив']]);
  await k.enable('a');
  await s.chans.a?.post('заново');
  await k.viewPost('a', 'main', 'принято');
  assert.deepEqual(s.inbox.a, ['принято'], 'старый слушатель не вернулся, новая активация завела свой');
  await k.unload();
});

test('канал: ленивая главная часть просыпается от сообщения вида и получает его', async () => {
  const got: unknown[] = [];
  const lazy: PluginModule = {
    activate(ctx) {
      ctx.views.channel('main').onMessage((m) => void got.push(m));
      return undefined;
    },
  };
  const s = stand({ lazy }, [manifest('lazy', { activation: 'lazy' })]);
  const k = await s.start();
  assert.ok(!k.active.includes('lazy'));
  await k.viewPost('lazy', 'main', 'разбуди');
  assert.deepEqual(got, ['разбуди']);
  await k.unload();
});
