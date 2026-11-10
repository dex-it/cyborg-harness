import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext, PtyExit } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { describeEntry } from '../src/status.ts';
import { load as loadKernel, type JournalEntry, type Kernel, type LoadOptions } from '../src/loader.ts';
import { trackKernels } from './kernels.ts';
import { waitFor } from './wait-for.ts';
import { inlinePtyHost } from '../src/pty-link.ts';
import { PTY_HOST_LOST, type PtyBackend } from '../src/pty.ts';
import { Endpoint } from '../src/rpc.ts';
import { inlineHosts } from '../src/transports.ts';
import { fakePty, type FakeProc } from '../../testing/src/fake-pty.ts';
import { fakeView } from './view-channel.ts';

// Ядро выгружается после каждого теста файла, и упавшим тоже: иначе слежение и программы держат процесс файла (core/test/kernels.ts).
const track = trackKernels();
const load = async (options: LoadOptions): Promise<Kernel> => track(await loadKernel(options));

const tick = () => sleep(30);
const shell = { pty: [{ program: '/bin/bash', args: [] }] };

/** pty-хосты, поднятые ядром: тест роняет их, вешает и считает запуски. */
function ptyHosts(backend: PtyBackend) {
  const inline = inlinePtyHost(backend);
  const hosts: { handle: ReturnType<typeof inline>; deaf: boolean; killedByCore: boolean }[] = [];
  const spawn = () => {
    const handle = inline();
    const rec = { handle, deaf: false, killedByCore: false };
    hosts.push(rec);
    return {
      // Зависший хост молчит: сообщения до него доходят, ответов нет.
      port: {
        post: (m: unknown, t?: readonly unknown[]) => {
          if (!rec.deaf) handle.port.post(m, t);
        }, onMessage: (l: Parameters<typeof handle.port.onMessage>[0]) => handle.port.onMessage(l) },
      kill: () => {
        rec.killedByCore = true;
        handle.kill();
      },
      onExit: (l: (code: number | null) => void) => handle.onExit(l),
    };
  };
  return { spawn, hosts };
}

async function setup(options: { backend?: PtyBackend; watchdog?: LoadOptions['watchdog']; plugins?: string[]; limits?: LoadOptions['limits'] } = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pty-host-')));
  const backend = options.backend ?? fakePty();
  const hosts = ptyHosts(backend);
  const ids = options.plugins ?? ['agent'];
  const contexts = new Map<string, PluginContext>();
  const plugin = inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) }));
  const handles = new Map<string, ReturnType<typeof plugin>>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests: ids.map((id) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, permissions: shell })),
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: '/usr/bin' }, ptyHost: hosts.spawn },
    watchdog: { interval: 10, timeout: 100, ...options.watchdog },
    ...(options.limits && { limits: options.limits }),
    spawnHost: (id) => {
      const h = plugin(id);
      handles.set(id, h);
      return h;
    },
  });
  const pty = (id = 'agent') => {
    const p = contexts.get(id)?.os.pty;
    assert.ok(p, `${id}: нет ctx.os.pty`);
    return p;
  };
  const journal = <K extends JournalEntry['kind']>(kind: K) => k.journal.filter((e): e is Extract<JournalEntry, { kind: K }> => e.kind === kind);
  return {
    k,
    backend: backend as ReturnType<typeof fakePty>,
    hosts: hosts.hosts,
    handles,
    pty,
    journal,
    [Symbol.asyncDispose]: async () => {
      await k.unload();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('pty-хост запускается при первом pty, а не при старте ядра; выгрузка ядра завершает процессы и убивает хост', async () => {
  await using s = await setup();
  assert.equal(s.hosts.length, 0, 'pty-хост поднят без единого pty');
  await s.pty().spawn({ program: '/bin/bash' });
  await s.pty().spawn({ program: '/bin/bash' });
  assert.equal(s.hosts.length, 1, 'один pty-хост на все pty');
  const procs = s.backend.procs;
  await s.k.unload();
  assert.deepEqual(procs.map((p) => p.killed), ['SIGHUP', 'SIGHUP'], 'выгрузка не завершила процессы до убийства хоста');
  assert.equal(s.hosts[0]?.killedByCore, true);
});

test('pty-хост упал: владельцы получают onExit, журнал пишет host-down и host-restart, новый spawn работает на новом хосте', async () => {
  await using s = await setup();
  const exits: PtyExit[] = [];
  const first = await s.pty().spawn({ program: '/bin/bash', persist: true });
  first.onExit((e) => exits.push(e));
  s.hosts[0]!.handle.kill();
  // Ждём факта (владелец узнал, сторож поднял хост заново), а не 30 мс: до перезапуска любой вызов pty отвечает HostGone.
  await waitFor('владелец узнал о потере pty и сторож поднял pty-хост заново', () => exits.length > 0 && s.hosts.length === 2 && s.journal('host-restart').length > 0);
  assert.deepEqual(exits, [PTY_HOST_LOST], 'владелец не узнал, что pty потерян');
  assert.deepEqual(await s.pty().list(), [], 'потерянный pty с владельцем остался в списке');
  assert.equal(s.backend.procs[0]?.killed, 'SIGHUP', 'процессы упавшего хоста не завершены');

  const down = s.journal('host-down');
  assert.equal(down.length, 1);
  assert.deepEqual([down[0]?.hostId, down[0]?.reason, down[0]?.lostPtys, down[0]?.plugins], ['pty-host', 'crash', ['agent'], []]);
  assert.deepEqual(s.journal('host-restart').map((e) => e.hostId), ['pty-host']);
  assert.equal(s.hosts.length, 2, 'сторож не поднял pty-хост заново');
  assert.match(describeEntry(down[0]!), /^pty-хост упал: процессы pty потеряны, их владельцы получили выход: agent$/);

  const again = await s.pty().spawn({ program: '/bin/bash' });
  assert.equal(again.pid, s.backend.procs[1]?.pid, 'новый spawn не дошёл до нового pty-хоста');
  assert.equal(s.backend.procs.length, 2);
});

test('pty-хост завис: сторож убивает его по порогу, а не по падению; pty потеряны, новый spawn работает', async () => {
  await using s = await setup();
  const h = await s.pty().spawn({ program: '/bin/bash', persist: true });
  const exits: PtyExit[] = [];
  h.onExit((e) => exits.push(e));
  s.hosts[0]!.deaf = true;
  const hung = performance.now();
  await waitFor('сторож записал зависание pty-хоста', () => s.journal('host-down').length > 0);
  assert.equal(s.journal('host-down')[0]?.reason, 'hang');
  assert.equal(s.hosts[0]?.killedByCore, true, 'зависший pty-хост не убит');
  assert.ok(performance.now() - hung >= 100, 'сторож убил хост раньше порога');
  await waitFor('владелец узнал о потере pty', () => exits.length > 0);
  assert.deepEqual(exits, [PTY_HOST_LOST]);
  assert.match(describeEntry(s.journal('host-down')[0]!), /^pty-хост завис/);
  await s.pty().spawn({ program: '/bin/bash' });
  assert.equal(s.hosts.length, 2);
});

test('pty-хост упал, пока pty ждал владельца: list показывает потерянный выход, attach отдаёт его один раз с пустым хвостом', async () => {
  await using s = await setup();
  const kept = await s.pty().spawn({ program: '/bin/bash', persist: true });
  s.handles.get('agent')!.kill();
  await s.k.idle();
  s.hosts[0]!.handle.kill();
  // Пока сторож поднимает pty-хост заново, list отвечает отказом: проба повторяется.
  await waitFor('list показывает потерянный выход', async () => ((await s.pty().list())[0]?.exit ? true : undefined));
  assert.deepEqual((await s.pty().list()).map((p) => [p.id, p.exit]), [[kept.id, PTY_HOST_LOST]]);
  const back = await s.pty().attach(kept.id);
  assert.deepEqual([back.backlog, back.exit], ['', PTY_HOST_LOST]);
  assert.deepEqual(await s.pty().list(), []);
});

test('вид: pty-хост упал - главный процесс получает closed с потерянным выходом; вид закрыл порт - closed без выхода', async () => {
  await using s = await setup();
  const h = await s.pty().spawn({ program: '/bin/bash', persist: true });
  const lost = fakeView();
  const closedByFrame = fakeView();
  await s.k.openTerminal('agent', await h.share(), lost.channel);
  await s.k.openTerminal('agent', await h.share(), closedByFrame.channel);
  closedByFrame.close();
  await waitFor('главный процесс узнал о закрытии порта', () => closedByFrame.closed.length === 1);
  assert.deepEqual(closedByFrame.closed, [undefined], 'главный процесс не узнал, что фрейм закрыл порт');
  assert.deepEqual(lost.closed, []);
  s.hosts[0]!.handle.kill();
  await waitFor('вид узнал о потере pty-хоста', () => lost.closed.length === 1);
  assert.deepEqual(lost.closed, [PTY_HOST_LOST], 'вид о потере pty узнаёт только отсюда: порт молчит');
});

test('сторож не поднимает pty-хост, который падает снова и снова: host-abandoned; следующий spawn пробует заново', async () => {
  await using s = await setup({ watchdog: { strikes: 3 } });
  await s.pty().spawn({ program: '/bin/bash' });
  for (let i = 0; i < 3; i++) {
    const live = s.hosts.findLast((x) => !x.killedByCore);
    assert.ok(live, `хоста для падения ${String(i)} нет`);
    live.handle.kill();
    // Два первых падения сторож чинит новым хостом; третье он не чинит - host-abandoned.
    await waitFor(`сторож отработал падение ${String(i + 1)}`, () => (i < 2 ? s.hosts.length === i + 2 : s.journal('host-abandoned').length === 1));
  }
  assert.equal(s.journal('host-abandoned').length, 1);
  assert.equal(s.journal('host-abandoned')[0]?.hostId, 'pty-host');
  assert.equal(s.hosts.length, 3, 'после третьего падения хост поднят снова');
  assert.match(describeEntry(s.journal('host-abandoned')[0]!), /больше не перезапускается сам/);
  await s.pty().spawn({ program: '/bin/bash' });
  assert.equal(s.hosts.length, 4, 'явный spawn не попробовал снова');
});

test('запуск асинхронный: pid приходит позже, чем решение; плагин ушёл, пока процесс поднимался, - процесс завершён, а не потерян', async () => {
  const procs: FakeProc[] = [];
  let spawning = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const base = fakePty();
  const backend: PtyBackend = {
    async spawn(file, args, options) {
      spawning = true;
      await gate;
      const proc = base.spawn(file, args, options);
      procs.push(proc);
      return proc;
    },
  };
  await using s = await setup({ backend });
  const pending = s.pty().spawn({ program: '/bin/bash' });
  pending.catch(() => undefined);
  await waitFor('backend начал запуск процесса', () => spawning);
  s.handles.get('agent')!.kill();
  await s.k.idle();
  release();
  await assert.rejects(pending);
  await waitFor('процесс отозванного запуска завершён', () => procs[0]?.killed === 'SIGHUP');
  assert.equal(procs.length, 1);
  assert.equal(procs[0]?.killed, 'SIGHUP', 'процесс запуска, от которого отказались, жив без владельца');
});

test('pty-хост сам проверяет размер 1..1000 и ввод; неверное не доходит до pty ни запросом, ни уведомлением', async () => {
  const backend = fakePty();
  const host = inlinePtyHost(backend)();
  const ep = new Endpoint(host.port);
  await ep.request('init', { ptyInput: 4, ptyFlushMs: 4, ptyFlushChars: 1024, backlog: 100 });
  await ep.request('spawn', { key: 'k', file: 'sh', args: [], options: { name: 'xterm-256color', env: {}, cols: 80, rows: 24 } });
  const proc = backend.procs[0]!;
  for (const [cols, rows] of [[0, 24], [1001, 24], [80, 0], [80, 1001], [1.5, 24]]) {
    await assert.rejects(ep.request('resize', { key: 'k', cols, rows }), { code: 'Invalid' });
    ep.notify('resize', { key: 'k', cols, rows });
  }
  await assert.rejects(ep.request('write', { key: 'k', data: '12345' }), { code: 'Invalid', message: /больше 4 байт/ });
  ep.notify('write', { key: 'k', data: '12345' });
  await tick();
  assert.deepEqual(proc.resizes, [], 'неверный размер дошёл до pty');
  assert.deepEqual(proc.writes, [], 'ввод сверх предела дошёл до pty');
  await ep.request('resize', { key: 'k', cols: 1000, rows: 1 });
  await ep.request('write', { key: 'k', data: '1234' });
  assert.deepEqual([proc.resizes, proc.writes], [[[1000, 1]], ['1234']]);
  host.kill();
});

test('вид: размер и ввод проверяет pty-хост и отвечает в порт; чужое сообщение в порту отбрасывается', async () => {
  await using s = await setup();
  const h = await s.pty().spawn({ program: '/bin/bash', persist: true });
  const v = fakeView();
  await s.k.openTerminal('agent', await h.share(), v.channel);
  assert.match((await v.resize(0, 24)).error ?? '', /целые 1\.\.1000/);
  assert.match((await v.resize(80, 1001)).error ?? '', /целые 1\.\.1000/);
  assert.match((await v.resize('80', 24)).error ?? '', /целые 1\.\.1000/);
  assert.match((await v.write(42)).error ?? '', /ввод - строка/);
  assert.deepEqual(await v.resize(100, 30), { ok: true });
  assert.deepEqual(s.backend.procs[0]?.resizes.at(-1), [100, 30]);
  assert.deepEqual(s.backend.procs[0].writes, []);
});

test('pty-хост: end пришёл, пока backend ещё поднимал процесс, - процесс завершён сразу после запуска, запрос отклонён', async () => {
  let spawning = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const base = fakePty();
  const backend: PtyBackend = {
    async spawn(file, args, options) {
      spawning = true;
      await gate;
      return base.spawn(file, args, options);
    },
  };
  const host = inlinePtyHost(backend)();
  const ep = new Endpoint(host.port);
  await ep.request('init', { ptyInput: 1024, ptyFlushMs: 4, ptyFlushChars: 1024, backlog: 100 });
  const spawned = ep.request('spawn', { key: 'k', file: 'sh', args: [], options: { name: 'xterm-256color', env: {}, cols: 80, rows: 24 } });
  spawned.catch(() => undefined);
  await waitFor('backend начал запуск процесса', () => spawning);
  ep.notify('end', { key: 'k' });
  // Сообщения одного канала идут по порядку: ответ на ping значит, что `end` уже обработан.
  await ep.request('ping', null);
  release();
  await assert.rejects(spawned, { code: 'NotFound' });
  assert.equal(base.procs[0]?.killed, 'SIGHUP', 'процесс отозванного запуска жив');
  host.kill();
});

test('pty-хост: завершаемый процесс, переживший SIGHUP, добивается SIGKILL по сроку; вышедший сам срока не получает (ревью K-01)', async () => {
  const backend = fakePty();
  const host = inlinePtyHost(backend, { endGraceMs: 60 })();
  const ep = new Endpoint(host.port);
  await ep.request('init', { ptyInput: 1024, ptyFlushMs: 4, ptyFlushChars: 1024, backlog: 100 });
  const start = async (key: string) => {
    await ep.request('spawn', { key, file: 'sh', args: [], options: { name: 'xterm-256color', env: {}, cols: 80, rows: 24 } });
  };
  await start('deaf');
  await start('polite');
  const [deaf, polite] = backend.procs as [FakeProc, FakeProc];
  ep.notify('end', { key: 'deaf' });
  ep.notify('end', { key: 'polite' });
  await waitFor('оба процесса получили SIGHUP', () => deaf.killed === 'SIGHUP' && polite.killed === 'SIGHUP');
  polite.exit(0);
  polite.killed = 'не трогать';
  await waitFor('срок добивания вышел', () => deaf.killed === 'SIGKILL');
  assert.equal(deaf.killed, 'SIGKILL', 'процесс, не услышавший SIGHUP, жив: завершение не закреплено');
  assert.equal(polite.killed, 'не трогать', 'вышедшему процессу ушёл SIGKILL');

  host.kill();
});

test('выгрузка: pty-хост глух к endAll, плагин после deactivate просит слежение - оно не занимает ресурс и после unload() его нет (ревью K-01, K-10)', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pty-host-')));
  const backend = fakePty();
  const hosts = ptyHosts(backend);
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['late'],
    manifests: [{ id: 'late', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { ...shell, 'fs.read': [root] } }],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: '/usr/bin' }, ptyHost: hosts.spawn },
    watchdog: { interval: 10, timeout: 100 },
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
  });
  const ctx = contexts.get('late')!;
  await ctx.os.pty!.spawn({ program: '/bin/bash' });
  const watching = () => process.getActiveResourcesInfo().filter((r) => r === 'FSEventWrap').length;
  const base = watching();
  // pty-хост перестал отвечать: выгрузка ждёт его, пока хосты плагинов ещё живы.
  hosts.hosts[0]!.deaf = true;
  const unloading = k.unload();
  await waitFor('плагин снят', () => k.journal.some((e) => e.kind === 'deactivated'));
  // Запрос снятого плагина ядро отклоняет (K-10: запросы `os` принимает только активный плагин), так что ресурс не занят; вторая зачистка в `unload()` - запасная.
  await assert.rejects(ctx.os.fs.watch(root, () => undefined), { code: 'Unavailable' });
  assert.equal(watching(), base, 'слежение снятого плагина заняло ресурс');
  await unloading;
  await waitFor('слежение, пришедшее после выгрузки плагина, не пережило unload()', () => watching() === base);
  await rm(root, { recursive: true, force: true });
});

// #134 (У-47): программа pty не читает stdin - очередь node-pty растёт без предела. Читаемость ядру не видна, поэтому ввод ограничен запасом и скоростью (ведро байт) на каждый pty.
const INIT = { ptyInput: 1024, ptyFlushMs: 4, ptyFlushChars: 1024, backlog: 100 };
const SPAWN = { file: 'sh', args: [], options: { name: 'xterm-256color', env: {}, cols: 80, rows: 24 } };

test('pty-хост: ввод в pty, чья программа не читает stdin, сверх запаса отклоняется Invalid; в очередь процесса не попадает ни запросом, ни уведомлением', async () => {
  const backend = fakePty();
  const host = inlinePtyHost(backend)();
  const ep = new Endpoint(host.port);
  await ep.request('init', { ...INIT, ptyInputBurst: 4096, ptyInputRate: 1 });
  await ep.request('spawn', { key: 'k', ...SPAWN });
  const proc = backend.procs[0]!;
  const chunk = 'x'.repeat(1000);
  const replies: string[] = [];
  for (let i = 0; i < 10; i++) {
    try {
      await ep.request('write', { key: 'k', data: chunk });
      replies.push('ok');
    } catch (error) {
      replies.push((error as { code?: string }).code ?? 'другое');
    }
  }
  assert.deepEqual(replies, ['ok', 'ok', 'ok', 'ok', ...Array<string>(6).fill('Invalid')]);
  ep.notify('write', { key: 'k', data: chunk });
  // Сообщения одного канала идут по порядку: ответ на ping значит, что уведомление уже обработано.
  await ep.request('ping', null);
  // Невычитанное - всё, что хост отдал процессу: подделка stdin не читает.
  const queued = proc.writes.join('').length;
  assert.ok(queued <= 4096, `в очереди процесса ${String(queued)} Б при запасе 4096`);
  await assert.rejects(ep.request('write', { key: 'k', data: chunk }), { code: 'Invalid', message: /ввод быстрее 1 Б\/с/ });
  host.kill();
});

test('pty-хост: запас ввода пополняется со скоростью ptyInputRate и не копится выше ptyInputBurst; у каждого pty свой запас', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const backend = fakePty();
  const host = inlinePtyHost(backend)();
  const ep = new Endpoint(host.port);
  await ep.request('init', { ...INIT, ptyInputBurst: 2048, ptyInputRate: 1000 });
  await ep.request('spawn', { key: 'a', ...SPAWN });
  await ep.request('spawn', { key: 'b', ...SPAWN });
  const chunk = 'x'.repeat(1000);
  const write = (key: string, data = chunk) => ep.request('write', { key, data });
  await write('a');
  await write('a');
  await assert.rejects(write('a'), { code: 'Invalid' });
  await write('b');
  t.mock.timers.setTime(1_000_000 + 1000);
  await write('a');
  await assert.rejects(write('a'), { code: 'Invalid' }, 'за секунду пополнилось 1000 Б, не больше');
  // Простой дольше времени полного пополнения даёт не больше запаса.
  t.mock.timers.setTime(1_000_000 + 3_600_000);
  await write('a');
  await write('a');
  await assert.rejects(write('a'), { code: 'Invalid' }, 'запас вырос выше ptyInputBurst');
  // Ввод больше остатка не принимается частью и остаток не трогает.
  await assert.rejects(write('a', 'x'.repeat(100)), { code: 'Invalid' });
  await write('a', 'x'.repeat(48));
  assert.equal(backend.procs[0]?.writes.join('').length, 2000 + 1000 + 2000 + 48);
  assert.equal(backend.procs[1]?.writes.join('').length, 1000, 'запас соседнего pty не затронут');
  host.kill();
});

test('вид: ввод в порт сверх запаса получает ошибку в ответе на write, а не молчание; обычный ввод и вставка до предела проходят', async () => {
  await using s = await setup({ limits: { ptyInput: 1024, ptyInputBurst: 3000, ptyInputRate: 1 } });
  const h = await s.pty().spawn({ program: '/bin/bash', persist: true });
  const v = fakeView();
  await s.k.openTerminal('agent', await h.share(), v.channel);
  assert.deepEqual(await v.write('ls\r'), { ok: true });
  assert.deepEqual(await v.write('x'.repeat(1024)), { ok: true }, 'вставка до предела одного ввода');
  assert.deepEqual(await v.write('y'.repeat(1024)), { ok: true });
  const refused = await v.write('z'.repeat(1024));
  assert.match(refused.error ?? '', /ввод быстрее 1 Б\/с/);
  assert.equal(s.backend.procs[0]?.writes.join('').length, 3 + 1024 + 1024);
  assert.deepEqual(await v.write('ok'), { ok: true }, 'мелкий ввод после отказа проходит: запас ещё есть');
});
