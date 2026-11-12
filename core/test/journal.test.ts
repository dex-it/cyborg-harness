import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg-harness/contracts';
import { appendBounded, DeniedCollapse, DeprecatedCollapse } from '../src/journal.ts';
import { load, type JournalEntry } from '../src/loader.ts';
import { describeEntry } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

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
    apiVersion: PLUGIN_API_VERSION,
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

test('журнал: окно не пустило вид на чужой адрес - запись denied в журнал его плагина, адрес обрезан, повторы склеены, чужой id не пишется', async () => {
  const k = await load({
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    enabled: ['p'],
    manifests: [{ id: 'p', version: '1.0.0', engines: { cyborg: '^1' } }],
  });
  for (let i = 0; i < 5; i++) k.viewDenied('p', 'https://evil.example/login');
  k.viewDenied('p', `data:text/html,${'x'.repeat(5000)}`);
  k.viewDenied('ghost', 'https://evil.example/');
  await k.unload();
  const denied = k.journal.filter((e) => e.kind === 'denied');
  assert.deepEqual(
    denied.map((e) => [e.pluginId, e.method, e.reason, e.repeats]),
    [
      ['p', 'navigate', 'window', undefined],
      ['p', 'navigate', 'window', undefined],
      ['p', 'navigate', 'window', 4],
    ],
  );
  const [away, nav] = denied;
  assert.ok(away && nav);
  assert.equal(describeEntry(away), 'отказ окна: переход на https://evil.example/login');
  assert.ok(describeEntry(nav).length < 250, 'адрес вида не обрезан');
  assert.match(describeEntry(nav), /^отказ окна: переход на data:text\/html,x+…$/);
});

// #160: CSP отказала виду (инлайн-стиль без ui.inlineStyles и другое): человек без DevTools видит причину в журнале плагина, поток отказов журнал не раздувает.
test('журнал: отказ CSP вида - запись denied с reason csp в журнал его плагина, текст обрезан, повторы склеены, чужой id не пишется', async () => {
  const k = await load({
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    enabled: ['p'],
    manifests: [{ id: 'p', version: '1.0.0', engines: { cyborg: '^1' } }],
  });
  for (let i = 0; i < 5; i++) k.viewCspDenied('p', 'инлайн-стиль (style-src-elem): объявите ui.inlineStyles');
  k.viewCspDenied('p', `адрес ${'x'.repeat(5000)}`);
  k.viewCspDenied('ghost', 'инлайн-стиль (style-src-elem)');
  await k.unload();
  const denied = k.journal.filter((e) => e.kind === 'denied');
  assert.deepEqual(
    denied.map((e) => [e.pluginId, e.method, e.reason, e.repeats]),
    [
      ['p', 'csp', 'csp', undefined],
      ['p', 'csp', 'csp', undefined],
      ['p', 'csp', 'csp', 4],
    ],
  );
  const [style, long] = denied;
  assert.ok(style && long);
  assert.equal(describeEntry(style), 'отказ CSP: инлайн-стиль (style-src-elem): объявите ui.inlineStyles');
  assert.ok(describeEntry(long).length < 250, 'текст отказа не обрезан');
});

test('журнал: цикл отказов CSP с разными адресами не раздувает журнал сверх предела отказов', async () => {
  const k = await load({
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    enabled: ['p'],
    manifests: [{ id: 'p', version: '1.0.0', engines: { cyborg: '^1' } }],
  });
  for (let i = 0; i < 3000; i++) k.viewCspDenied('p', `https://evil.example/${String(i)}.css (style-src-elem)`);
  assert.ok(k.journal.filter((e) => e.kind === 'denied').length <= 1000, 'отказов CSP в журнале больше предела');
  await k.unload();
});

type DeprecatedCall = Extract<JournalEntry, { kind: 'deprecated-call' }>;
const old = (caller: string, member = 'list', contract = 'test.old', provider = 'prov'): DeprecatedCall => ({ pluginId: caller, kind: 'deprecated-call', provider, contract, member });

test('ST-5003/3: журнал: вызовы устаревшего члена за окно - первая запись сразу, повторы одной записью с repeats; пара (вызывающий, член) считается отдельно', () => {
  const out: JournalEntry[] = [];
  const c = new DeprecatedCollapse((e) => out.push(e), 60_000);
  for (let i = 0; i < 100; i++) c.record(old('a'));
  c.record(old('b'));
  c.record(old('a', 'get'));
  c.record(old('a', 'list', 'test.other'));
  c.record(old('a', 'list', 'test.old', 'other'));
  assert.equal(out.length, 5, 'по записи на каждую пару при первом вызове');
  c.flush();
  assert.equal(out.length, 6);
  const last = out[5];
  assert.ok(last?.kind === 'deprecated-call');
  assert.deepEqual([last.pluginId, last.member, last.repeats], ['a', 'list', 99]);
  assert.match(describeEntry(last), /ещё 99 раз/);
});

test('журнал: окно склейки закрывается - следующий вызов пишется заново', async () => {
  const out: JournalEntry[] = [];
  const c = new DeprecatedCollapse((e) => out.push(e), 10);
  c.record(old('a'));
  c.record(old('a'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(out.map((e) => e.kind === 'deprecated-call' ? e.repeats : null), [undefined, 1]);
  c.record(old('a'));
  assert.equal(out.length, 3);
  c.flush();
});

test('журнал: записей deprecated-call не больше предела, старейшая самого шумного уходит; отказы и записи жизненного цикла остаются', () => {
  const list: JournalEntry[] = [{ pluginId: 'p', kind: 'activated', hostId: 'h', ms: 1 }, denied('x'), old('quiet')];
  for (let i = 0; i < 50; i++) appendBounded(list, old('loud', `m${String(i)}`), (e) => e, 10);
  const calls = list.filter((e) => e.kind === 'deprecated-call');
  assert.equal(calls.length, 10);
  assert.ok(calls.some((e) => e.pluginId === 'quiet'), 'тихий не вытеснен шумным');
  assert.deepEqual(calls.filter((e) => e.pluginId === 'loud').map((e) => e.member), ['m41', 'm42', 'm43', 'm44', 'm45', 'm46', 'm47', 'm48', 'm49']);
  assert.equal(list.filter((e) => e.kind === 'denied').length, 1, 'пределы отдельные у каждого вида');
  assert.equal(list.filter((e) => e.kind === 'activated').length, 1);
});

test('журнал: поток вызовов устаревшего члена не вытесняет отказы, а предел по умолчанию - 1000', () => {
  const list: JournalEntry[] = [];
  for (let i = 0; i < 5; i++) appendBounded(list, denied(String(i)), (e) => e);
  for (let i = 0; i < 3000; i++) appendBounded(list, old('loud', `m${String(i)}`), (e) => e);
  assert.equal(list.filter((e) => e.kind === 'deprecated-call').length, 1000);
  assert.equal(list.filter((e) => e.kind === 'denied').length, 5);
});
