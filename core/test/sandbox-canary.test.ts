// TR-21 (docs/research/trust-and-isolation/06-work-plan.md, 5.3 п. 3): canary. Хост доказывает заявленные запреты сам, пробуя запрещённое, до того как загружен код плагина;
// ядро не активирует плагин, если запрет не действует (`sandbox-ineffective`), и записывает уровень изоляции, если действует (`isolation`, TR-24). Настоящие процессы Node.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import type { HostIsolation } from '../src/isolation.ts';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { describeEntry, entryLevel, pluginStatuses } from '../src/status.ts';
import { forkHosts, inlineHosts, type HostRequest, type SpawnHost } from '../src/transports.ts';

const CORE_SRC = fileURLToPath(new URL('../src', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const manifests = [{ id: 'sandboxed', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'sandboxed.probe': { args: ['string'] }, 'sandboxed.echo': { args: ['any'] }, 'sandboxed.bytes': { args: ['any'] }, 'sandboxed.leak': {}, 'sandboxed.hang': {}, 'sandboxed.crash': {} } }];

const CLAIM: HostIsolation = { level: 2, reason: 'запреты Node; сеть открыта', network: 'open', canary: { nodePermission: true, networkClosed: false } };
const PERMISSION = ['--permission', `--allow-fs-read=${CORE_SRC}`, `--allow-fs-read=${FIXTURES}`];

async function start(spawnHost: SpawnHost, bundled?: string[]): Promise<Kernel> {
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['sandboxed'],
    manifests,
    spawnHost,
    entry: () => new URL('./fixtures/sandboxed.ts', import.meta.url).href,
    ...(bundled !== undefined && { bundled }),
    watchdog: { interval: 50, timeout: 1500, strikes: 5 },
  });
  await kernel.idle();
  return kernel;
}
const kinds = (k: Kernel) => k.journal.map((e) => e.kind);
const entry = <K extends JournalEntry['kind']>(k: Kernel, kind: K): Extract<JournalEntry, { kind: K }> | undefined => k.journal.find((e): e is Extract<JournalEntry, { kind: K }> => e.kind === kind);

test('ST-3010/2, ST-3010/8: TR-21: хост под --permission доказал запреты: плагин активирован, записан уровень 2 с причиной и открытой сетью', async () => {
  const k = await start(forkHosts({ silent: true, env: {}, execArgv: PERMISSION, isolation: CLAIM }));
  try {
    assert.ok(k.active.includes('sandboxed'));
    const isolation = entry(k, 'isolation');
    assert.deepEqual(isolation && [isolation.pluginId, isolation.level, isolation.network, isolation.reason], ['sandboxed', 2, 'open', CLAIM.reason]);
    assert.ok(kinds(k).indexOf('isolation') < kinds(k).indexOf('activated'), 'уровень записан до активации');
    assert.equal(entry(k, 'sandbox-ineffective'), undefined);
    const status = pluginStatuses(k.journal).find((s) => s.id === 'sandboxed');
    assert.deepEqual(status?.isolation, { level: 2, reason: CLAIM.reason, network: 'open' });
    assert.match(describeEntry(isolation as JournalEntry), /уровень изоляции 2 из 3.*запреты Node; сеть открыта/);
    assert.equal(entryLevel(isolation as JournalEntry), 'info');
  } finally {
    await k.unload();
  }
});

test('ST-3010/2: TR-21: --permission заявлен, но не действует (хост без флага, как utilityProcess): sandbox-ineffective, плагин не активирован, хост остановлен', async () => {
  let exited: Promise<number | null> = Promise.resolve(-99);
  const base = forkHosts({ silent: true, env: {}, isolation: CLAIM });
  const spawn: SpawnHost = (hostId) => {
    const handle = base(hostId);
    exited = new Promise((resolve) => handle.onExit(resolve));
    return handle;
  };
  const k = await start(spawn);
  try {
    assert.ok(!k.active.includes('sandboxed'), 'плагин не активирован');
    assert.ok(!kinds(k).includes('activated'));
    assert.ok(!kinds(k).includes('isolation'), 'пока заявленное не доказано, уровень не записывается');
    const bad = entry(k, 'sandbox-ineffective');
    assert.ok(bad);
    assert.equal(bad.level, 2);
    assert.match(bad.reasons.join(' | '), /process\.permission не определён/);
    assert.match(bad.reasons.join(' | '), /запуск процесса: ожидался отказ ERR_ACCESS_DENIED, получено allowed/);
    const status = pluginStatuses(k.journal).find((s) => s.id === 'sandboxed');
    assert.ok(status);
    assert.equal(status.state, 'stopped');
    assert.equal(status.revivable, true, '«Включить снова» после исправления запуска');
    assert.equal(status.isolation, undefined);
    assert.equal(entryLevel(bad), 'error');
    assert.match(describeEntry(bad), /не запущен.*не доказал заявленную изоляцию/);
    assert.equal(await Promise.race([exited, new Promise((r) => setTimeout(() => r('жив'), 3000))]), null, 'процесс хоста убит ядром (SIGKILL)');
    await assert.rejects(k.run('sandboxed.probe', '/'));
  } finally {
    await k.unload();
  }
});

test('ST-3010/2: TR-22: ограничитель ОС заявлен (networkClosed), а сокет открылся - sandbox-ineffective с названной причиной; без заявления сеть - открыта и это не отказ', async () => {
  const closedClaim: HostIsolation = { level: 3, reason: 'запреты Node и ограничитель ОС', network: 'closed', canary: { nodePermission: true, networkClosed: true } };
  const k = await start(forkHosts({ silent: true, env: {}, execArgv: PERMISSION, isolation: closedClaim }));
  try {
    assert.ok(!k.active.includes('sandboxed'));
    const bad = entry(k, 'sandbox-ineffective');
    assert.ok(bad);
    assert.equal(bad.level, 3);
    assert.deepEqual(bad.reasons, ['ограничитель ОС заявлен, но сокет открылся: сеть не закрыта']);
  } finally {
    await k.unload();
  }
});

test('ST-3010/2: TR-21: запуск, который об изоляции ничего не заявил, проверки не получает и записи об уровне не оставляет (прежнее поведение)', async () => {
  const k = await start(forkHosts({ silent: true }));
  try {
    assert.ok(k.active.includes('sandboxed'));
    assert.ok(!kinds(k).includes('isolation') && !kinds(k).includes('sandbox-ineffective'));
    assert.equal(pluginStatuses(k.journal).find((s) => s.id === 'sandboxed')?.isolation, undefined);
  } finally {
    await k.unload();
  }
});

test('ST-3010/8: TR-21: уровень без canary (utilityProcess уровня 1) записывается без проверки', async () => {
  const claim: HostIsolation = { level: 1, reason: 'явное окружение, запретов ОС нет', network: 'open' };
  const base = inlineHosts(async () => (await import('./fixtures/sandboxed.ts')).default);
  const k = await start((id) => ({ ...base(id), isolation: claim }));
  try {
    assert.ok(k.active.includes('sandboxed'));
    assert.equal(entry(k, 'isolation')?.level, 1);
  } finally {
    await k.unload();
  }
});

test('ST-3010/1: TR-21: ядро говорит запуску, кто будет жить в хосте и откуда он: плагины с каталогом и признак стороннего', async () => {
  const seen: [string, HostRequest | undefined][] = [];
  const base = inlineHosts(async () => (await import('./fixtures/sandboxed.ts')).default);
  const spawn: SpawnHost = (hostId, request) => {
    seen.push([hostId, request]);
    return base(hostId);
  };
  const third = await start(spawn, ['other']);
  await third.unload();
  const bundled = await start(spawn, ['sandboxed']);
  await bundled.unload();
  const unknown = await start(spawn);
  await unknown.unload();
  assert.deepEqual(seen[0], ['sandboxed', { plugins: [{ id: 'sandboxed', home: FIXTURES }], thirdParty: true }]);
  assert.deepEqual(seen[1]?.[1], { plugins: [{ id: 'sandboxed', home: FIXTURES }], thirdParty: false });
  assert.equal(seen[2]?.[1]?.thirdParty, false, 'без bundled поставку не от чего отличить');
});
