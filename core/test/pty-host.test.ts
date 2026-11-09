import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext, PtyExit } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { describeEntry } from '../src/status.ts';
import { load, type JournalEntry, type LoadOptions } from '../src/loader.ts';
import { inlinePtyHost } from '../src/pty-link.ts';
import { PTY_HOST_LOST, type PtyBackend, type PtyProcess } from '../src/pty.ts';
import { Endpoint } from '../src/rpc.ts';
import { inlineHosts } from '../src/transports.ts';
import { fakePty, type FakeProc } from './fake-pty.ts';
import { fakeView } from './view-channel.ts';

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

async function setup(options: { backend?: PtyBackend; watchdog?: LoadOptions['watchdog']; plugins?: string[] } = {}) {
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
  await tick();
  s.hosts[0]!.handle.kill();
  await tick();
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
  await tick();
  s.hosts[0]!.deaf = true;
  const hung = performance.now();
  while (s.journal('host-down').length === 0 && performance.now() - hung < 3000) await sleep(10);
  assert.equal(s.journal('host-down')[0]?.reason, 'hang');
  assert.equal(s.hosts[0]?.killedByCore, true, 'зависший pty-хост не убит');
  assert.ok(performance.now() - hung >= 100, 'сторож убил хост раньше порога');
  await tick();
  assert.deepEqual(exits, [PTY_HOST_LOST]);
  assert.match(describeEntry(s.journal('host-down')[0]!), /^pty-хост завис/);
  await s.pty().spawn({ program: '/bin/bash' });
  assert.equal(s.hosts.length, 2);
});

test('pty-хост упал, пока pty ждал владельца: list показывает потерянный выход, attach отдаёт его один раз с пустым хвостом', async () => {
  await using s = await setup();
  const kept = await s.pty().spawn({ program: '/bin/bash', persist: true });
  await tick();
  s.handles.get('agent')!.kill();
  await s.k.idle();
  s.hosts[0]!.handle.kill();
  await tick();
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
  await tick();
  assert.deepEqual(closedByFrame.closed, [undefined], 'главный процесс не узнал, что фрейм закрыл порт');
  assert.deepEqual(lost.closed, []);
  s.hosts[0]!.handle.kill();
  await tick();
  assert.deepEqual(lost.closed, [PTY_HOST_LOST], 'вид о потере pty узнаёт только отсюда: порт молчит');
});

test('сторож не поднимает pty-хост, который падает снова и снова: host-abandoned; следующий spawn пробует заново', async () => {
  await using s = await setup({ watchdog: { strikes: 3 } });
  await s.pty().spawn({ program: '/bin/bash' });
  for (let i = 0; i < 3; i++) {
    const live = s.hosts.findLast((x) => !x.killedByCore);
    assert.ok(live, `хоста для падения ${String(i)} нет`);
    live.handle.kill();
    await tick();
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
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const base = fakePty();
  const backend: PtyBackend = {
    async spawn(file, args, options) {
      await gate;
      const proc = base.spawn(file, args, options) as PtyProcess as FakeProc;
      procs.push(proc);
      return proc;
    },
  };
  await using s = await setup({ backend });
  const pending = s.pty().spawn({ program: '/bin/bash' });
  pending.catch(() => undefined);
  await tick();
  s.handles.get('agent')!.kill();
  await s.k.idle();
  release();
  await assert.rejects(pending);
  await tick();
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
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const base = fakePty();
  const backend: PtyBackend = {
    async spawn(file, args, options) {
      await gate;
      return base.spawn(file, args, options);
    },
  };
  const host = inlinePtyHost(backend)();
  const ep = new Endpoint(host.port);
  await ep.request('init', { ptyInput: 1024, ptyFlushMs: 4, ptyFlushChars: 1024, backlog: 100 });
  const spawned = ep.request('spawn', { key: 'k', file: 'sh', args: [], options: { name: 'xterm-256color', env: {}, cols: 80, rows: 24 } });
  spawned.catch(() => undefined);
  await tick();
  ep.notify('end', { key: 'k' });
  await tick();
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
  const start = async (key: string) => void (await ep.request('spawn', { key, file: 'sh', args: [], options: { name: 'xterm-256color', env: {}, cols: 80, rows: 24 } }));
  await start('deaf');
  await start('polite');
  const [deaf, polite] = backend.procs as [FakeProc, FakeProc];
  ep.notify('end', { key: 'deaf' });
  ep.notify('end', { key: 'polite' });
  await tick();
  assert.deepEqual([deaf.killed, polite.killed], ['SIGHUP', 'SIGHUP']);
  polite.exit(0);
  polite.killed = 'не трогать';
  await sleep(120);
  assert.equal(deaf.killed, 'SIGKILL', 'процесс, не услышавший SIGHUP, жив: завершение не закреплено');
  assert.equal(polite.killed, 'не трогать', 'вышедшему процессу ушёл SIGKILL');

  host.kill();
});
