import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg/contracts';
import { appendBounded, DeniedCollapse } from '../src/journal.ts';
import { load, type JournalEntry } from '../src/loader.ts';
import { describeEntry } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';

const denied = (detail: string): JournalEntry => ({ pluginId: 'p', kind: 'denied', method: 'fs.readText', detail });

test('журнал: отказов не больше предела, старейший уходит; записи жизненного цикла остаются все', () => {
  const list: JournalEntry[] = [{ pluginId: 'p', kind: 'activated', hostId: 'h', ms: 1 }];
  for (let i = 0; i < 50; i++) appendBounded(list, denied(String(i)), (e) => e, 10);
  appendBounded(list, { pluginId: 'p', kind: 'revived' }, (e) => e, 10);
  assert.equal(list.filter((e) => e.kind === 'denied').length, 10);
  assert.deepEqual(
    list.map((e) => (e.kind === 'denied' ? e.detail : e.kind)),
    ['activated', '40', '41', '42', '43', '44', '45', '46', '47', '48', '49', 'revived'],
  );
});

test('журнал: поток разных отказов одного плагина не вытесняет отказы другого', () => {
  const list: JournalEntry[] = [];
  for (let i = 0; i < 3; i++) appendBounded(list, { pluginId: 'quiet', kind: 'denied', method: 'net.fetch', detail: `q${String(i)}` }, (e) => e, 10);
  for (let i = 0; i < 500; i++) appendBounded(list, denied(String(i)), (e) => e, 10);
  assert.deepEqual(
    list.filter((e) => e.kind === 'denied' && e.pluginId === 'quiet').map((e) => (e.kind === 'denied' ? e.detail : '')),
    ['q0', 'q1', 'q2'],
  );
  assert.equal(list.length, 10);
});

test('журнал: одинаковые отказы за окно - первая запись сразу, повторы одной записью с repeats; разные не склеиваются', () => {
  const out: JournalEntry[] = [];
  const c = new DeniedCollapse((e) => out.push(e), 60_000);
  for (let i = 0; i < 100; i++) c.record({ pluginId: 'p', kind: 'denied', method: 'fs.readText', detail: 'путь вне fs.read: /etc/hostname' });
  c.record({ pluginId: 'p', kind: 'denied', method: 'fs.readText', detail: 'путь вне fs.read: /etc/passwd' });
  assert.equal(out.length, 2);
  c.flush();
  assert.equal(out.length, 3);
  const last = out[2];
  assert.ok(last?.kind === 'denied');
  assert.equal(last.repeats, 99);
  assert.match(describeEntry(last), /ещё 99 раз/);
});

test('журнал: плагин в цикле из 20 000 отказов не раздувает журнал ядра', async () => {
  let ctx!: PluginContext;
  const k = await load({
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
    enabled: ['p'],
    manifests: [{ id: 'p', version: '1.0.0', engines: { cyborg: '^1' } }],
  });
  // Разные отказы раньше повторов: вытеснение уносит их, а не записи счёта.
  for (let i = 0; i < 3000; i++) await ctx.os.fs.readText(`/etc/x${String(i)}`).catch(() => undefined);
  for (let i = 0; i < 20_000; i++) await ctx.os.fs.readText('/etc/hostname').catch(() => undefined);
  const deniedNow = k.journal.filter((e) => e.kind === 'denied').length;
  assert.ok(deniedNow <= 1000, `отказов в журнале: ${String(deniedNow)}`);
  await k.unload();
  // Медленная машина закроет окно посреди цикла: тогда записей счёта несколько, но сумма та же.
  const counted = k.journal.reduce((n, e) => n + (e.kind === 'denied' && e.detail.includes('/etc/hostname') ? (e.repeats ?? 1) : 0), 0);
  assert.equal(counted, 20_000, 'счёт повторов не потерян при выгрузке');
});
