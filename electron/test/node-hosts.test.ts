// TR-21, TR-22a, TR-22b, TR-24 (ADR-CH-0019): способ запуска хоста по происхождению плагина, уровни изоляции, ограничители ОС.
// Хосты - настоящие процессы Node (`forkHosts`), ядро - настоящее; utilityProcess подменён хостом в процессе (Electron в `npm test` нет).
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { inlineHosts, load, PLUGIN_API_VERSION, pluginStatuses, type HostIsolation, type HostRequest, type JournalEntry, type Kernel } from '@cyborg-harness/core';
import { describeProbe, landlockConfiner, parseProbe } from '../src/confiner-landlock.ts';
import { seatbeltConfiner, seatbeltProfile, SANDBOX_EXEC } from '../src/confiner-seatbelt.ts';
import type { ConfinerLauncher } from '../src/confiner.ts';
import { nodeIsolation, packageFilesAbove, pickConfiner, pluginHosts, utilityIsolation, type IsolationSettings } from '../src/node-hosts.ts';

const ENTRY = fileURLToPath(import.meta.resolve('@cyborg-harness/core/host-entry'));
const manifest = { id: 'sandboxed', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'sandboxed.probe': { args: ['string'] }, 'sandboxed.echo': { args: ['any'] }, 'sandboxed.bytes': { args: ['any'] }, 'sandboxed.leak': {}, 'sandboxed.hang': {}, 'sandboxed.crash': {} } };
const NODE = process.execPath;

/** Подставной `utilityProcess`: хост в процессе, заявление об изоляции - то, которое дал адаптер. */
function fakeUtility(seen: { request?: HostRequest | undefined; isolation?: HostIsolation | undefined }[]) {
  return (isolation: (request: HostRequest | undefined) => HostIsolation) => {
    const base = inlineHosts(async () => (await import('./fixtures/sandboxed.ts')).default);
    return {
      spawn: (hostId: string, request?: HostRequest) => {
        const claim = isolation(request);
        seen.push({ request, isolation: claim });
        return { ...base(hostId), isolation: claim };
      },
      pidOf: () => undefined,
    };
  };
}

async function start(settings: IsolationSettings, bundled: string[] = []): Promise<{ kernel: Kernel; seen: { request?: HostRequest | undefined; isolation?: HostIsolation | undefined }[]; pidOf: (hostId: string) => number | undefined }> {
  const seen: { request?: HostRequest | undefined; isolation?: HostIsolation | undefined }[] = [];
  const hosts = pluginHosts(fakeUtility(seen), settings);
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['sandboxed'],
    manifests: [manifest],
    spawnHost: hosts.spawn,
    entry: () => new URL('./fixtures/sandboxed.ts', import.meta.url).href,
    bundled,
    watchdog: { interval: 100, timeout: 3000, strikes: 5 },
  });
  await kernel.idle();
  return { kernel, seen, pidOf: hosts.pidOf };
}
const isolationOf = (k: Kernel): Extract<JournalEntry, { kind: 'isolation' }> | undefined => k.journal.find((e): e is Extract<JournalEntry, { kind: 'isolation' }> => e.kind === 'isolation');
const ineffective = (k: Kernel): Extract<JournalEntry, { kind: 'sandbox-ineffective' }> | undefined => k.journal.find((e): e is Extract<JournalEntry, { kind: 'sandbox-ineffective' }> => e.kind === 'sandbox-ineffective');

const none = (why = 'тест'): { none: string } => ({ none: why });
const fakeConfiner = (over: Partial<ConfinerLauncher> = {}): ConfinerLauncher => ({ name: 'тестовый', status: { ok: true, files: true, summary: 'сокеты закрыты' }, wrap: (c) => c, ...over });

test('ST-3010/8: TR-24: уровни по запуску: встроенный в utilityProcess - 1; сторонний в utilityProcess - 1 с предупреждением; Node без ограничителя - 2 и сеть названа; с ограничителем - 3', () => {
  const builtin = utilityIsolation({ plugins: [{ id: 'files' }], thirdParty: false });
  assert.deepEqual([builtin.level, builtin.network, builtin.canary], [1, 'open', undefined]);
  assert.match(builtin.reason, /встроенный плагин.*код поставки проверен нами.*запретов ОС нет/);
  const third = utilityIsolation({ plugins: [{ id: 'x' }], thirdParty: true }, 'режим стороннего хоста переключён на utilityProcess настройкой');
  assert.equal(third.level, 1);
  assert.match(third.reason, /сторонний плагин.*utilityProcess настройкой.*запреты Node в нём не действуют.*НЕ закрыты/);

  const bare = nodeIsolation(none('нет запускателя'));
  assert.deepEqual([bare.level, bare.network, bare.canary], [2, 'open', { nodePermission: true, networkClosed: false }]);
  assert.match(bare.reason, /Сеть и сокеты НЕ закрыты: ограничителя ОС нет \(нет запускателя\), плагин может открыть соединение мимо ctx\.os\.net/);
  assert.match(bare.reason, /нельзя запускать процессы, создавать потоки и грузить аддоны/);

  const broken = nodeIsolation(fakeConfiner({ status: { ok: false, reason: 'нет /usr/bin/sandbox-exec' } }));
  assert.equal(broken.level, 2);
  assert.match(broken.reason, /ограничитель ОС тестовый недоступен \(нет \/usr\/bin\/sandbox-exec\)/);

  const full = nodeIsolation(fakeConfiner());
  assert.deepEqual([full.level, full.network, full.canary], [3, 'closed', { nodePermission: true, networkClosed: true }]);

  // Ядро Linux без Landlock: сеть закрыта seccomp, но файлы держит только Node - уровень 3 не ставится.
  const partial = nodeIsolation(fakeConfiner({ status: { ok: true, files: false, summary: 'Landlock недоступен' } }));
  assert.deepEqual([partial.level, partial.network], [2, 'closed']);
});

test('ST-3010/1: TR-21: сторонний плагин (не из bundled) работает в процессе Node: запреты действуют, env пуст, нарушитель получает отказ на чтение вне каталога и процесс; уровень 2 в журнале и статусе', async () => {
  const { kernel, seen, pidOf } = await start({ node: { binary: NODE, entry: ENTRY }, confiner: 'off' }, ['other']);
  try {
    assert.ok(kernel.active.includes('sandboxed'), `плагин активен: ${JSON.stringify(kernel.journal.filter((e) => e.pluginId === 'sandboxed').map((e) => e.kind))}`);
    assert.equal(seen.length, 0, 'utilityProcess не запускался');
    const probe = (await kernel.run('sandboxed.probe', fileURLToPath(new URL('../../package.json', import.meta.url)))) as { pid: number; permission: string; env: string[]; readOutside: string; spawn: string; electron: null };
    assert.equal(probe.permission, 'object');
    assert.equal(probe.readOutside, 'ERR_ACCESS_DENIED');
    assert.equal(probe.spawn, 'ERR_ACCESS_DENIED');
    assert.deepEqual(probe.env.filter((n) => n !== '__CF_USER_TEXT_ENCODING'), []);
    assert.equal(pidOf(kernel.hostOf('sandboxed') ?? ''), probe.pid, 'pid хоста известен адаптеру и совпадает с процессом плагина');
    assert.notEqual(probe.pid, process.pid);
    const isolation = isolationOf(kernel);
    assert.ok(isolation);
    assert.equal(isolation.level, 2);
    assert.equal(isolation.network, 'open');
    assert.match(isolation.reason, /Сеть и сокеты НЕ закрыты: ограничителя ОС нет \(.*отключён настройкой\)/);
    assert.equal(pluginStatuses(kernel.journal).find((s) => s.id === 'sandboxed')?.isolation?.level, 2);
    // Канал json с кодеком: типы structuredClone доезжают через границу процесса.
    const echoed = await kernel.run('sandboxed.echo', { map: new Map([['a', 1n]]), bytes: new Uint8Array([1, 2]), date: new Date(5) });
    assert.deepEqual(echoed, { map: new Map([['a', 1n]]), bytes: new Uint8Array([1, 2]), date: new Date(5) });
    await assert.rejects(kernel.run('sandboxed.leak'), { code: 'NotCloneable' });
  } finally {
    await kernel.unload();
  }
});

test('ST-3010/1: TR-21: плагин из bundled остаётся в utilityProcess с уровнем 1', async () => {
  const { kernel, seen } = await start({ node: { binary: NODE, entry: ENTRY }, confiner: 'off' }, ['sandboxed']);
  try {
    assert.ok(kernel.active.includes('sandboxed'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.request?.thirdParty, false);
    assert.equal(isolationOf(kernel)?.level, 1);
  } finally {
    await kernel.unload();
  }
});

test('ST-3010/5: TR-21: возврат одной настройкой: thirdPartyHost "utility" - сторонний плагин в utilityProcess, уровень 1, причина названа; без бинарника Node - то же', async () => {
  for (const [settings, why] of [
    [{ thirdPartyHost: 'utility', node: { binary: NODE, entry: ENTRY } }, /переключён на utilityProcess настройкой/],
    [{}, /отдельный Node не настроен/],
  ] as const) {
    const { kernel, seen } = await start(settings, ['other']);
    try {
      assert.ok(kernel.active.includes('sandboxed'));
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.request?.thirdParty, true);
      assert.equal(isolationOf(kernel)?.level, 1);
      assert.match(isolationOf(kernel)?.reason ?? '', why);
    } finally {
      await kernel.unload();
    }
  }
});

test('ST-3010/1: TR-21: каталог плагина с «*» хост Node не получает (Node прочёл бы маску): плагин не запущен с причиной, а не хост с чужими правами', async () => {
  const seen: { request?: HostRequest | undefined; isolation?: HostIsolation | undefined }[] = [];
  const hosts = pluginHosts(fakeUtility(seen), { node: { binary: NODE, entry: ENTRY }, confiner: 'off' });
  assert.throws(() => hosts.spawn('x', { plugins: [{ id: 'x', home: '/tmp/a*b' }], thirdParty: true }), /содержит «\*»/);
});

test('ST-3010/2: TR-21: --permission заявлен, а бинарник его не соблюдает (фальшивый Node): canary ловит, плагин не запущен', async () => {
  // «Node», который молча отбрасывает --permission и --allow-fs-read: так вёл бы себя utilityProcess (опыт Б исследования доверия).
  const fake = path.join(mkdtempSync(path.join(tmpdir(), 'cyborg-fake-node-')), 'node');
  writeFileSync(fake, `#!/bin/sh\nn=$#\ni=0\nwhile [ $i -lt $n ]; do a="$1"; shift; case "$a" in --permission|--allow-fs-read=*) ;; *) set -- "$@" "$a";; esac; i=$((i+1)); done\nexec "${NODE}" "$@"\n`);
  chmodSync(fake, 0o755);
  const { kernel } = await start({ node: { binary: fake, entry: ENTRY }, confiner: 'off' }, ['other']);
  try {
    assert.ok(!kernel.active.includes('sandboxed'));
    const bad = ineffective(kernel);
    assert.ok(bad, JSON.stringify(kernel.journal));
    assert.match(bad.reasons.join('|'), /process\.permission не определён/);
  } finally {
    await kernel.unload();
  }
});

test('ST-3010/6: TR-22a: профиль Seatbelt: сеть, fork, запись закрыты; исполнение только Node; чтение содержимого вне названного; пути экранируются, управляющий символ отвергается', () => {
  const profile = seatbeltProfile({ read: ['/work/plug"in', '/work/host'], exec: ['/opt/node/bin/node'] });
  assert.match(profile, /^\(version 1\)\n\(allow default\)\n\(deny network\*\)\n\(deny process-fork\)/);
  assert.match(profile, /\(deny process-exec\* \(require-not \(require-any \(literal "\/opt\/node\/bin\/node"\)\)\)\)/);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(subpath "\/work\/plug\\"in"\)/);
  assert.match(profile, /\(deny file-read-data \(require-not \(require-any .*\(subpath "\/work\/host"\).*\(literal "\/opt\/node\/bin\/node"\)\)\)\)$/);
  assert.throws(() => seatbeltProfile({ read: ['/a\nb'], exec: [] }), /управляющим символом/);
  assert.equal(seatbeltConfiner('/нет/такой/программы').status.ok, false);
});

test('ST-3010/7: TR-22b: запускатель Linux: ответ --probe разбирается; ядро без Landlock, до 6.7 и с 6.7 названы честно; обёртка команды несёт чтение и исполнение', () => {
  assert.deepEqual(parseProbe('{"abi":4,"seccomp":true,"arch":"x86_64","kernel":"6.8.0"}'), { abi: 4, seccomp: true, arch: 'x86_64', kernel: '6.8.0' });
  assert.equal(parseProbe('не json'), undefined);
  assert.equal(parseProbe('{"abi":"4"}'), undefined);
  const k = (abi: number, seccomp = true) => describeProbe({ abi, seccomp, arch: 'x86_64', kernel: `ядро-${String(abi)}` });
  assert.deepEqual(k(0), { ok: true, files: false, summary: (k(0) as { summary: string }).summary });
  assert.match((k(0) as { summary: string }).summary, /Landlock недоступен.*ABI 0.*только запретами Node/);
  assert.match((k(3) as { summary: string }).summary, /ABI 3.*правил TCP Landlock в этом ядре нет.*до 6\.7.*одним seccomp/);
  assert.match((k(4) as { summary: string }).summary, /TCP bind и connect закрыты Landlock/);
  assert.match((k(7) as { summary: string }).summary, /абстрактные unix-сокеты и сигналы/);
  assert.deepEqual(k(5, false), { ok: false, reason: 'ядро ядро-5 (x86_64): seccomp недоступен, сокеты закрыть нечем' });
  const missing = landlockConfiner('/нет/cyborg-confine');
  assert.ok(!missing.status.ok);
  assert.match(missing.status.reason, /не найден \(сборка: npm run build:confiner\)/);
  const wrapped = missing.wrap({ command: '/n/node', args: ['--permission', 'entry.js', 'h'] }, { read: ['/p'], exec: ['/n/node'] });
  assert.equal(wrapped.command, '/нет/cyborg-confine');
  assert.ok(wrapped.args.includes('--read=/p') && wrapped.args.includes('--exec=/n/node') && wrapped.args.includes('--read=/proc/self'));
  assert.deepEqual(wrapped.args.slice(wrapped.args.indexOf('--')), ['--', '/n/node', '--permission', 'entry.js', 'h']);
});

test('ST-3010/6, ST-3010/7: TR-22: ограничитель по настройке: off - нет, готовый - как есть, auto на платформе без ограничителя - нет с причиной; на Linux без запускателя - нет', () => {
  assert.deepEqual(pickConfiner({ confiner: 'off' }), { none: 'ограничитель ОС отключён настройкой' });
  const ready = fakeConfiner();
  assert.equal(pickConfiner({ confiner: ready }), ready);
  assert.deepEqual(pickConfiner({}, 'win32'), { none: 'ограничителя ОС для win32 нет' });
  assert.match((pickConfiner({}, 'linux') as { none: string }).none, /cyborg-confine.*не задан/);
});

// Настоящие ограничители ОС на своей платформе: хост за обёрткой, ядро доказывает закрытую сеть canary, нарушитель получает отказ.
const macOnly = { skip: process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC) ? 'только macOS с sandbox-exec' : false };
test('ST-3010/6: TR-22a: macOS: хост под Seatbelt - уровень 3, canary подтверждает закрытую сеть, плагин работает и читает только своё', macOnly, async () => {
  const { kernel } = await start({ node: { binary: NODE, entry: ENTRY }, confiner: 'auto' }, ['other']);
  try {
    assert.ok(kernel.active.includes('sandboxed'), JSON.stringify(kernel.journal.filter((e) => e.pluginId === 'sandboxed')));
    assert.equal(isolationOf(kernel)?.level, 3);
    assert.equal(isolationOf(kernel)?.network, 'closed');
    assert.match(isolationOf(kernel)?.reason ?? '', /Seatbelt/);
    const echoed = await kernel.run('sandboxed.echo', { a: [1, 2, 3] });
    assert.deepEqual(echoed, { a: [1, 2, 3] });
  } finally {
    await kernel.unload();
  }
});

const confineBinary = fileURLToPath(new URL(`../native/build/${process.platform}-${process.arch}/cyborg-confine`, import.meta.url));
const linuxOnly = { skip: process.platform !== 'linux' ? 'только Linux' : !existsSync(confineBinary) ? 'запускатель не собран (npm run build:confiner)' : false };
test('ST-3010/7: TR-22b: Linux: хост за cyborg-confine - сеть закрыта seccomp (canary), уровень по ядру: 3 с Landlock, иначе 2 с закрытой сетью; плагин работает', linuxOnly, async () => {
  const { kernel } = await start({ node: { binary: NODE, entry: ENTRY }, confiner: 'auto', confinerBinary: confineBinary }, ['other']);
  try {
    assert.ok(kernel.active.includes('sandboxed'), JSON.stringify(kernel.journal.filter((e) => e.pluginId === 'sandboxed')));
    const isolation = isolationOf(kernel);
    assert.ok(isolation);
    assert.equal(isolation.network, 'closed');
    assert.ok(isolation.level === 3 || isolation.level === 2);
    assert.match(isolation.reason, /seccomp/);
    assert.deepEqual(await kernel.run('sandboxed.echo', { a: [1] }), { a: [1] });
  } finally {
    await kernel.unload();
  }
});

test('ST-3010/7: TR-22: ограничителю названы файлы package.json над кодом хоста (Node ищет по ним тип модуля и падает на нечитаемом), и только они', () => {
  const dir = path.dirname(ENTRY);
  const files = packageFilesAbove(dir);
  assert.ok(files.length > 0 && files.every((f) => path.basename(f) === 'package.json' && dir.startsWith(path.dirname(f))), files.join(', '));
  assert.ok(files.includes(path.join(path.dirname(path.dirname(dir)), 'package.json')), 'пакет ядра: core/package.json над dist/src');
});
