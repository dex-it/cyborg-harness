import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, PtyExit } from '@cyborg-harness/contracts';
import { load as loadKernel, type Kernel, type LoadOptions } from '../src/loader.ts';
import { trackKernels } from './kernels.ts';
import { describePermissions } from '../src/permissions.ts';
import { fakePty, type FakeProc } from '../../testing/src/fake-pty.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import type { Port } from '../src/rpc.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { fakeView } from './view-channel.ts';
import { waitFor } from './wait-for.ts';

// Ядро выгружается после каждого теста файла, и упавшим тоже: иначе слежение и программы держат процесс файла (core/test/kernels.ts).
const track = trackKernels();
const load = async (options: LoadOptions): Promise<Kernel> => track(await loadKernel(options));

const tick = () => new Promise((r) => setTimeout(r, 30));

async function setup(plugins: Record<string, unknown>, withBackend = true, limits?: LoadOptions['limits'], ptyOrphanGrace?: number, onKeptPty?: () => void) {
  // На macOS tmpdir - симлинк /var -> /private/var, а шлюз отдаёт пути после realpath.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pty-')));
  const work = path.join(root, 'work');
  await mkdir(work);
  const backend = fakePty();
  const contexts = new Map<string, PluginContext>();
  const handles = new Map<string, HostHandle>();
  const spawn = inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) }));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: Object.keys(plugins),
    manifests: Object.entries(plugins).map(([id, permissions]) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...(permissions !== undefined && { permissions }) })),
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: '/usr/bin', HOME: '/h', SECRET: 'x' }, ...(withBackend && { pty: backend }), ...(ptyOrphanGrace !== undefined && { ptyOrphanGrace }) },
    ...(limits && { limits }),
    spawnHost: (id) => {
      const h = spawn(id);
      handles.set(id, h);
      return h;
    },
    onKeptPty,
  });
  const pty = (id: string) => {
    const p = contexts.get(id)?.os.pty;
    assert.ok(p, `${id}: нет ctx.os.pty`);
    return p;
  };
  const hasPty = (id: string) => contexts.get(id)?.os.pty !== undefined;
  return { k, backend, pty, hasPty, handles, work, [Symbol.asyncDispose]: async () => {
      await k.unload();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const shell = { pty: [{ program: '/bin/bash', args: [], env: ['COLORTERM'] }], 'fs.read': [] as string[] };

test('ST-2006/2: pty.spawn: программа, окружение и cwd по праву; вывод до подписки не теряется; ввод, размер, сигнал и выход', async () => {
  await using s = await setup({ term: { ...shell, 'fs.read': ['/'] }, plain: undefined });
  const h = await s.pty('term').spawn({ program: '/bin/bash', args: ['-l'], cwd: s.work, env: { COLORTERM: 'truecolor' }, cols: 120, rows: 40 });
  const proc = s.backend.procs[0]!;
  assert.deepEqual([proc.file, proc.args, proc.options.cwd, proc.options.cols, proc.options.rows], ['/bin/bash', ['-l'], s.work, 120, 40]);
  assert.deepEqual(proc.options.env, { PATH: '/usr/bin', HOME: '/h', COLORTERM: 'truecolor' }, 'чужое окружение Cyborg дошло до pty');
  assert.equal(h.pid, proc.pid);
  const seen: string[] = [];
  h.onData((c) => seen.push(c));
  proc.emit('ls\r\n');
  await waitFor('приглашение и вывод дошли до подписчика', () => seen.join('') === '$ ls\r\n');
  assert.deepEqual(seen.join(''), '$ ls\r\n');
  await h.write('echo 1\r');
  await h.resize(100, 30);
  await assert.rejects(h.resize(0, 30), { code: 'Invalid' });
  await assert.rejects(h.kill('SIGSTOP' as never), { code: 'Invalid' });
  assert.deepEqual([proc.writes, proc.resizes], [['echo 1\r'], [[100, 30]]]);
  const exits: PtyExit[] = [];
  h.onExit((e) => exits.push(e));
  proc.exit(3);
  await waitFor('выход дошёл до владельца', () => exits.length === 1);
  assert.deepEqual(exits, [{ code: 3 }]);
  await assert.rejects(h.write('x'), { code: 'NotFound' });

  await assert.rejects(s.pty('term').spawn({ program: '/bin/sh' }), { code: 'PermissionDenied' });
  await assert.rejects(s.pty('term').spawn({ program: '/bin/bash', env: { LD_PRELOAD: '/x.so' } }), { code: 'PermissionDenied' });
  assert.equal(s.backend.procs.length, 1, 'запуск без права дошёл до бэкенда');
});

test('ST-2006/1, ST-2006/2: pty.spawn с describedBy: описание поставщика проходит, только если подходит и под его launch (confused deputy)', async () => {
  const rule = { program: '/bin/bash', args: ['-c', 'exec agent'], env: ['AGENT_FILE'] };
  await using s = await setup({
    consumer: { pty: [{ program: '/bin/bash', args: ['-c', 'exec agent'], env: ['AGENT_FILE', 'COLORTERM'] }] },
    honest: { launch: [rule] },
    rogue: { launch: [{ program: '/bin/bash', args: ['-c', 'exec other'] }] },
    wide: { launch: [rule, { ...rule, program: '/bin/zsh' }] },
    silent: undefined,
  });
  const spec = { program: '/bin/bash', args: ['-c', 'exec agent', '--x'], env: { AGENT_FILE: '/f' } };
  await s.pty('consumer').spawn({ ...spec, describedBy: 'honest' });
  for (const [describedBy, why] of [
    ['rogue', 'чужое описание под правом потребителя'],
    ['silent', 'поставщик без launch'],
    ['nobody', 'плагина нет'],
  ] as const) {
    await assert.rejects(s.pty('consumer').spawn({ ...spec, describedBy }), { code: 'PermissionDenied' }, why);
  }
  await assert.rejects(s.pty('consumer').spawn({ ...spec, env: { AGENT_FILE: '/f', COLORTERM: 'x' }, describedBy: 'honest' }), { code: 'PermissionDenied' }, 'переменная, которой нет в launch');
  await assert.rejects(s.pty('consumer').spawn({ ...spec, program: '/bin/zsh', describedBy: 'wide' }), { code: 'PermissionDenied' }, 'программа в launch поставщика, но вне pty потребителя');
  assert.equal(s.backend.procs.length, 1);
  assert.equal(s.hasPty('honest'), false, 'launch не даёт поставщику ctx.os.pty');
  const denied = s.k.journal.flatMap((e) => (e.kind === 'denied' ? [`${e.pluginId}: ${e.detail}`] : []));
  assert.equal(denied.length, 5);
  assert.match(denied[0] ?? '', /^consumer: rogue: аргументы не по правилу launch: \/bin\/bash$/);
  assert.match(denied[4] ?? '', /^consumer: .*\/bin\/zsh/);
  assert.deepEqual(describePermissions({ launch: [rule] }), ['предлагает запуск в терминале: /bin/bash -c exec agent (окружение: AGENT_FILE) - его выполнит потребитель']);
});

test('deny правила pty: флаг в хвосте argv, в том числе `флаг=значение`, - PermissionDenied и запись denied с именем флага без значения; процесс не создан', async () => {
  const rule = { program: '/bin/bash', args: ['-l'], deny: ['--rcfile', '--dangerously-skip-permissions'] };
  await using s = await setup({ term: { pty: [rule] }, plain: { pty: [{ program: '/bin/bash', args: ['-l'] }] } });
  for (const tail of [['--rcfile'], ['--rcfile=/tmp/evil-rc'], ['x', '--dangerously-skip-permissions'], ['--dangerously-skip-permissions=1']]) {
    await assert.rejects(s.pty('term').spawn({ program: '/bin/bash', args: ['-l', ...tail] }), { code: 'PermissionDenied' }, tail.join(' '));
  }
  assert.equal(s.backend.procs.length, 0, 'процесс не создан');
  const denied = s.k.journal.flatMap((e) => (e.kind === 'denied' && e.method === 'pty.spawn' ? [e.detail] : []));
  // Одинаковые отказы за окно журнал склеивает: записей две - по флагу.
  assert.deepEqual(denied, ['запрещён флаг --rcfile в правиле pty: /bin/bash', 'запрещён флаг --dangerously-skip-permissions в правиле pty: /bin/bash'], 'имя флага из deny, значение в журнал не идёт');
  await s.pty('term').spawn({ program: '/bin/bash', args: ['-l', '--rcfiles', '--rcfile-x=1'] });
  assert.equal(s.backend.procs.length, 1, 'близкие по написанию аргументы не запрещены');
  await s.pty('plain').spawn({ program: '/bin/bash', args: ['-l', '--rcfile=/tmp/rc'] });
  assert.equal(s.backend.procs.length, 2, 'правило без deny работает как раньше');
});

test('ST-1008/4, ST-3001/8, ST-3007/7: pty: чужие не видны и не трогаются; cwd вне права - отказ; без бэкенда - Unavailable; без права - нет члена', async () => {
  await using s = await setup({ a: shell, b: shell, plain: undefined });
  const mine = await s.pty('a').spawn({ program: '/bin/bash' });
  assert.deepEqual((await s.pty('b').list()).map((i) => i.id), []);
  assert.deepEqual((await s.pty('a').list()).map((i) => i.id), [mine.id]);
  await assert.rejects(s.pty('b').attach(mine.id), { code: 'NotFound' });
  await assert.rejects(s.pty('a').spawn({ program: '/bin/bash', cwd: s.work }), { code: 'PermissionDenied' });
  assert.ok(s.k.journal.some((e) => e.kind === 'denied' && e.method === 'pty.spawn'));
  assert.deepEqual(describePermissions({ pty: ['claude', { program: 'git', args: ['log'] }] }), ['запускает в терминале: claude, git log - полный доступ через программу']);

  await using bare = await setup({ a: shell }, false);
  await assert.rejects(bare.pty('a').spawn({ program: '/bin/bash' }), { code: 'Unavailable' });
});

test('ST-1003/3, ST-1008/1: падение хоста: pty с persist живёт и копит вывод, вернувшийся плагин забирает его через attach; без persist - завершён', async () => {
  await using s = await setup({ agent: shell });
  const kept = await s.pty('agent').spawn({ program: '/bin/bash', persist: true, cols: 90, rows: 20 });
  await s.pty('agent').spawn({ program: '/bin/bash' });
  const [keptProc, lostProc] = s.backend.procs as [FakeProc, FakeProc];
  s.handles.get('agent')!.kill();
  await s.k.idle();
  assert.equal(lostProc.killed, 'SIGHUP');
  assert.equal(keptProc.killed, undefined, 'pty с persist завершён вместе с хостом');
  keptProc.emit('пока хоста не было');

  const back = s.pty('agent');
  assert.deepEqual(await back.list(), [{ id: kept.id, pid: keptProc.pid, program: '/bin/bash', args: [], persist: true }]);
  const h = await back.attach(kept.id);
  assert.equal(h.backlog, '$ пока хоста не было');
  assert.deepEqual(keptProc.resizes, [[89, 20], [90, 20]], 'после attach нет толчка SIGWINCH');
  const seen: string[] = [];
  h.onData((c) => seen.push(c));
  keptProc.emit('дальше');
  await waitFor('вывод дошёл до подписчика', () => seen.length === 1);
  assert.deepEqual(seen, ['дальше']);

  await s.k.disable('agent');
  await waitFor('выключенный плагин не оставил pty', () => keptProc.killed === 'SIGHUP');
});

test('ST-1003/3: зависание хоста: сторож снимает хост, pty с persist живёт и копит вывод, вернувшийся плагин забирает его; без persist - завершён', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pty-')));
  const backend = fakePty();
  const contexts: PluginContext[] = [];
  const spawn = inlineHosts(async () => ({ activate: (ctx: PluginContext) => void contexts.push(ctx) }));
  const frozen = new Set<HostHandle>();
  const handles: HostHandle[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['agent'],
    manifests: [{ id: 'agent', version: '1.0.0', engines: { cyborg: '^1' }, permissions: shell }],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: '/usr/bin' }, pty: backend },
    watchdog: { interval: 10, timeout: 50 },
    spawnHost: (id) => {
      const handle = spawn(id);
      handles.push(handle);
      // Хост, переставший читать сообщения ядра, не отвечает на пинг - для сторожа это зависание.
      const post = (message: unknown) => {
        if (!frozen.has(handle)) handle.port.post(message);
      };
      const onMessage: Port['onMessage'] = (listener) => {
        handle.port.onMessage(listener);
      };
      return { ...handle, port: { post, onMessage } };
    },
  });
  try {
    const kept = await contexts[0]!.os.pty!.spawn({ program: '/bin/bash', persist: true });
    await contexts[0]!.os.pty!.spawn({ program: '/bin/bash' });
    const [keptProc, lostProc] = backend.procs as [FakeProc, FakeProc];
    frozen.add(handles[0]!);
    await waitFor('сторож снял зависший хост', () => k.journal.some((e) => e.kind === 'host-down'));
    await waitFor('плагин вернулся', () => contexts.length === 2 && k.active.includes('agent'));
    const down = k.journal.find((e) => e.kind === 'host-down');
    assert.equal(down?.kind === 'host-down' && down.reason, 'hang');
    assert.equal(lostProc.killed, 'SIGHUP');
    assert.equal(keptProc.killed, undefined, 'pty с persist завершён вместе с зависшим хостом');
    keptProc.emit('пока хост висел');

    const back = contexts[1]!.os.pty!;
    assert.deepEqual((await back.list()).map((p) => p.id), [kept.id]);
    const h = await back.attach(kept.id);
    assert.equal(h.backlog, '$ пока хост висел');
  } finally {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  }
});

test('ST-1008/2: сирота: плагин вернулся после падения хоста, но не взял pty за срок - процесс завершён, журнал называет срок', async () => {
  await using s = await setup({ agent: shell }, true, undefined, 100);
  const taken = await s.pty('agent').spawn({ program: '/bin/bash', persist: true });
  await s.pty('agent').spawn({ program: '/bin/bash', persist: true });
  const [takenProc, orphanProc] = s.backend.procs as [FakeProc, FakeProc];
  s.handles.get('agent')!.kill();
  await s.k.idle();
  await s.pty('agent').attach(taken.id);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(orphanProc.killed, 'SIGHUP');
  assert.equal(takenProc.killed, undefined, 'взятый до срока живёт');
  assert.deepEqual((await s.pty('agent').list()).map((p) => p.id), [taken.id]);
  const expired = s.k.journal.filter((e) => e.kind === 'pty-expired');
  assert.deepEqual(expired, [{ kind: 'pty-expired', pluginId: 'agent', id: 'pty-2', program: '/bin/bash', graceMs: 100 }]);
});

test('pty завершился без владельца: list показывает выход, attach отдаёт хвост и выход и убирает запись', async () => {
  await using s = await setup({ agent: shell });
  const kept = await s.pty('agent').spawn({ program: '/bin/bash', persist: true });
  const proc = s.backend.procs[0]!;
  s.handles.get('agent')!.kill();
  await s.k.idle();
  proc.emit('bye');
  proc.exit(0);
  await waitFor('list показывает выход', async () => ((await s.pty('agent').list())[0]?.exit ? true : undefined));
  assert.deepEqual((await s.pty('agent').list()).map((i) => i.exit), [{ code: 0 }]);
  const h = await s.pty('agent').attach(kept.id);
  assert.equal(h.backlog, '$ bye');
  const exits: PtyExit[] = [];
  h.onExit((e) => exits.push(e));
  await waitFor('attach отдал выход подписчику', () => exits.length === 1);
  assert.deepEqual(exits, [{ code: 0 }]);
  assert.deepEqual(await s.pty('agent').list(), []);
});

test('ST-1008/1: share: билет одноразовый и только для своего UI; вид видит вывод и пишет мимо хоста, в том числе пока хоста нет', async () => {
  await using s = await setup({ term: shell, other: shell });
  const h = await s.pty('term').spawn({ program: '/bin/bash', persist: true, cols: 80, rows: 24 });
  const proc = s.backend.procs[0]!;
  const stolen = await h.share();
  await assert.rejects(s.k.openTerminal('other', stolen, fakeView().channel), { code: 'NotFound' }, 'чужой плагин открыл билет');
  await assert.rejects(s.k.openTerminal('term', stolen, fakeView().channel), { code: 'NotFound' }, 'билет пережил первое предъявление');
  await assert.rejects(s.k.openTerminal('term', 'выдуманный', fakeView().channel), { code: 'NotFound' });

  const a = fakeView();
  const view = await s.k.openTerminal('term', await h.share(), a.channel);
  assert.deepEqual([view.id, view.pid, view.backlog], [h.id, proc.pid, '$ ']);
  assert.deepEqual(await a.write('ls\r'), { ok: true });
  assert.deepEqual(await a.resize(100, 30), { ok: true });
  assert.deepEqual([proc.writes, proc.resizes.at(-1)], [['ls\r'], [100, 30]]);
  await assert.rejects(s.pty('other').attach(h.id), { code: 'NotFound' });

  s.handles.get('term')!.kill();
  proc.emit('хост лежит, вид видит');
  assert.deepEqual(await a.write('pwd\r'), { ok: true });
  await waitFor('вывод дошёл до вида', () => a.data.length === 1);
  assert.deepEqual(a.data, ['хост лежит, вид видит'], 'вывод в вид ходит из pty-хоста по порту, хост плагина не нужен');
  assert.equal(proc.writes.at(-1), 'pwd\r');
  await s.k.idle();

  view.close();
  await tick();
  proc.emit('после close');
  void a.write('x');
  await tick();
  assert.deepEqual(a.data, ['хост лежит, вид видит']);
  assert.equal(proc.writes.at(-1), 'pwd\r', 'ввод после close дошёл до pty');

  const b = fakeView();
  const back = await s.pty('term').attach(h.id);
  await s.k.openTerminal('term', await back.share(), b.channel);
  proc.exit(0);
  await waitFor('выход дошёл до вида', () => b.exit.length === 1);
  assert.deepEqual(b.exit, [{ code: 0 }]);
  assert.equal(b.closed.length, 1, 'главный процесс не узнал, что канал вида больше не нужен');
  await assert.rejects(back.share(), { code: 'NotFound' }, 'билет на завершённый pty');
});

test('share: просроченный билет не открывается', async () => {
  await using s = await setup({ term: shell });
  const h = await s.pty('term').spawn({ program: '/bin/bash' });
  const ticket = await h.share();
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    await assert.rejects(s.k.openTerminal('term', ticket, fakeView().channel), { code: 'NotFound' });
  } finally {
    Date.now = realNow;
  }
});

test('ST-1008/3: выключение: preview называет живые pty; keepPty оставляет их ждать attach вернувшегося плагина; без keepPty и при выгрузке - завершены', async () => {
  await using s = await setup({ agent: shell, quiet: shell });
  const term = await s.pty('agent').spawn({ program: '/bin/bash', cols: 90, rows: 20 });
  await s.pty('agent').spawn({ program: '/bin/bash' });
  const [termProc, doneProc] = s.backend.procs as [FakeProc, FakeProc];
  doneProc.exit(0);
  await waitFor('выход первого pty учтён', () => s.k.disablePreview('agent').ptys.length === 1);
  assert.deepEqual(s.k.disablePreview('agent'), { plugins: ['agent'], ptys: [{ pluginId: 'agent', id: term.id, pid: termProc.pid, program: '/bin/bash', args: [], persist: false }] });
  assert.deepEqual(s.k.disablePreview('quiet'), { plugins: ['quiet'], ptys: [] });

  await s.k.disable('agent', { keepPty: true });
  assert.equal(termProc.killed, undefined, 'keepPty завершил процесс');
  assert.ok(s.k.journal.some((e) => e.kind === 'unloaded' && e.pluginId === 'agent' && e.keptPty === 1));
  assert.deepEqual(s.k.disablePreview('agent'), { plugins: [], ptys: [] }, 'выключенный плагин всё ещё что-то заберёт');
  termProc.emit('пока плагин выключен');

  await s.k.enable('agent');
  assert.deepEqual((await s.pty('agent').list()).map((p) => p.id), [term.id]);
  const back = await s.pty('agent').attach(term.id);
  assert.match(back.backlog, /пока плагин выключен$/);

  await s.k.disable('agent');
  await waitFor('выключение без keepPty завершило процесс', () => termProc.killed === 'SIGHUP');

  const parked = await s.pty('quiet').spawn({ program: '/bin/bash' });
  await s.k.disable('quiet', { keepPty: true });
  await s.k.unload();
  assert.equal(s.backend.procs.find((p) => p.pid === parked.pid)?.killed, 'SIGHUP', 'припаркованный pty пережил выгрузку ядра');
});

test('ST-1008/3: оставленный: ждёт без срока, пока плагин выключен, виден приложению и завершается человеком; вернувшийся плагин без attach теряет его по сроку', async () => {
  let changes = 0;
  await using s = await setup({ agent: shell }, true, undefined, 100, () => {
    changes++;
  });
  const ended = await s.pty('agent').spawn({ program: '/bin/bash' });
  const left = await s.pty('agent').spawn({ program: '/bin/bash' });
  const [endedProc, leftProc] = s.backend.procs as [FakeProc, FakeProc];

  await s.k.disable('agent', { keepPty: true });
  assert.deepEqual(s.k.keptPty().map((p) => [p.pluginId, p.id, typeof p.keptAt]), [['agent', ended.id, 'number'], ['agent', left.id, 'number']]);
  assert.ok(changes > 0, 'приложение не узнало об оставленных');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(leftProc.killed, undefined, 'срок сработал, пока плагин выключен');

  s.k.endKeptPty(ended.id);
  await waitFor('оставленный процесс завершён', () => endedProc.killed === 'SIGHUP');
  assert.deepEqual(s.k.keptPty().map((p) => p.id), [left.id]);
  assert.throws(() => s.k.endKeptPty(ended.id), { code: 'NotFound' });

  await s.k.enable('agent');
  assert.deepEqual(s.k.keptPty(), [], 'вернувшийся плагин владеет процессом, он больше не оставленный');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(leftProc.killed, 'SIGHUP', 'плагин не взял процесс за срок, а он жив');
  assert.deepEqual(s.k.journal.filter((e) => e.kind === 'pty-expired'), [{ kind: 'pty-expired', pluginId: 'agent', id: left.id, program: '/bin/bash', graceMs: 100 }]);
});

test('uninstall: активный плагин с живым pty - отказ, pty жив; оставленные человеком при выключении pty завершаются, чужие целы', async () => {
  let changes = 0;
  await using s = await setup({ agent: shell, neighbour: shell }, true, undefined, undefined, () => {
    changes++;
  });
  const own = await s.pty('agent').spawn({ program: '/bin/bash' });
  await s.pty('agent').spawn({ program: '/bin/bash' });
  await s.pty('neighbour').spawn({ program: '/bin/bash' });
  const [ownProc, secondProc, neighbourProc] = s.backend.procs as [FakeProc, FakeProc, FakeProc];

  await assert.rejects(s.k.uninstall('agent'), { code: 'Invalid' });
  assert.deepEqual([ownProc.killed, secondProc.killed], [undefined, undefined], 'отказ не тронул процессы');
  assert.equal(s.k.disablePreview('agent').ptys.length, 2, 'приложение сначала спрашивает человека о живых pty');

  await s.k.disable('agent', { keepPty: true });
  assert.equal(s.k.keptPty().length, 2);
  assert.ok(s.k.keptPty().some((p) => p.id === own.id));
  const before = changes;

  const report = await s.k.uninstall('agent');
  assert.deepEqual([ownProc.killed, secondProc.killed], ['SIGHUP', 'SIGHUP'], 'оставленные pty удалённого плагина завершены');
  assert.equal(neighbourProc.killed, undefined, 'pty соседа цел');
  assert.deepEqual(s.k.keptPty(), []);
  assert.ok(changes > before, 'приложение узнало, что оставленных больше нет');
  assert.ok(report.erased.includes('терминалов завершено: 2'), report.erased.join('; '));
  await s.k.unload();
});

test('пределы pty: ввод больше предела - Invalid, pty жив и принимает следующий; из хоста и из вида; число живых pty освобождается выходом и выключением; COLORTERM от ядра', async () => {
  await using s = await setup({ term: shell, other: shell }, true, { ptyInput: 8, ptys: 2 });
  const a = await s.pty('term').spawn({ program: '/bin/bash', persist: true });
  const proc = s.backend.procs[0]!;
  assert.equal(proc.options.env.COLORTERM, 'truecolor', 'терминал вида - truecolor без объявления в правах');
  await assert.rejects(a.write('123456789'), { code: 'Invalid', message: /больше 8 байт/ });
  await assert.rejects(a.write('ёёёёё'), { code: 'Invalid' }, 'пять символов - десять байт UTF-8');
  await a.write('12345678');
  const view = fakeView();
  await s.k.openTerminal('term', await a.share(), view.channel);
  assert.match((await view.write('x'.repeat(9))).error ?? '', /больше 8 байт/);
  assert.deepEqual(await view.write('ok'), { ok: true });
  assert.deepEqual(proc.writes, ['12345678', 'ok']);

  const own = await s.pty('term').spawn({ program: '/bin/bash', env: { COLORTERM: '24bit' } });
  assert.equal(s.backend.procs[1]!.options.env.COLORTERM, '24bit', 'плагин с правом на переменную задаёт своё');
  await assert.rejects(s.pty('term').spawn({ program: '/bin/bash' }), { code: 'Invalid', message: /живых pty больше 2/ });
  await s.pty('other').spawn({ program: '/bin/bash' });
  assert.equal(s.backend.procs.length, 3, 'отказ не запустил процесс; предел у каждого плагина свой');

  s.backend.procs[1]!.exit(0);
  await waitFor('вышедший pty не числится у плагина', async () => (await s.pty('term').list()).find((p) => p.id === own.id) === undefined);
  await s.pty('term').spawn({ program: '/bin/bash' });
  await s.k.disable('term');
  await s.k.enable('term');
  await s.pty('term').spawn({ program: '/bin/bash' });
  await s.pty('term').spawn({ program: '/bin/bash' });
});

test('ST-1008/6: пределы pty по умолчанию (PL-01): ввод ровно 1 МиБ проходит, на байт больше - Invalid; размер 1 и 1000 проходит, 0 и 1001 нет - из хоста плагина и из вида', async () => {
  const MIB = 1024 * 1024;
  await using s = await setup({ term: shell });
  const a = await s.pty('term').spawn({ program: '/bin/bash', persist: true });
  const proc = s.backend.procs[0]!;
  // Предел считается в байтах UTF-8: 524288 двухбайтных символов - ровно 1 МиБ, на символ больше - уже нет.
  await a.write('x'.repeat(MIB));
  await a.write('я'.repeat(MIB / 2));
  await assert.rejects(a.write('x'.repeat(MIB + 1)), { code: 'Invalid', message: new RegExp(`больше ${String(MIB)} байт`) });
  await assert.rejects(a.write('я'.repeat(MIB / 2 + 1)), { code: 'Invalid', message: /больше 1048576 байт/ });
  await a.write('после');
  assert.deepEqual(proc.writes.map((w) => w.length), [MIB, MIB / 2, 'после'.length], 'отклонённый ввод дошёл до pty, а следующий не прошёл');

  await a.resize(1000, 1000);
  await a.resize(1, 1);
  for (const [cols, rows] of [[0, 24], [80, 0], [1001, 24], [80, 1001], [1.5, 24], [80, Number.NaN]] as const) await assert.rejects(a.resize(cols, rows), { code: 'Invalid' }, `${String(cols)}x${String(rows)}`);
  assert.deepEqual(proc.resizes, [[1000, 1000], [1, 1]], 'неверный размер дошёл до pty');

  // Вид пишет в порт мимо хоста плагина: те же числа проверяет pty-хост.
  const b = await s.pty('term').spawn({ program: '/bin/bash', persist: true });
  const other = s.backend.procs[1]!;
  const view = fakeView();
  await s.k.openTerminal('term', await b.share(), view.channel);
  assert.deepEqual(await view.write('x'.repeat(MIB)), { ok: true });
  assert.match((await view.write('x'.repeat(MIB + 1))).error ?? '', /больше 1048576 байт/);
  assert.deepEqual(await view.resize(1000, 1000), { ok: true });
  for (const [cols, rows] of [[0, 24], [80, 0], [1001, 24], [80, 1001]] as const) assert.match((await view.resize(cols, rows)).error ?? '', /целые 1\.\.1000/, `${String(cols)}x${String(rows)}`);
  assert.deepEqual([other.writes.length, other.writes[0]?.length, other.resizes], [1, MIB, [[1000, 1000]]]);

  const c = await s.pty('term').spawn({ program: '/bin/bash', persist: true });
  const out = 'x'.repeat(100 * 1024) + 'y'.repeat(200 * 1024);
  s.backend.procs[2]!.emit(out);
  s.handles.get('term')!.kill();
  await s.k.idle();
  const { backlog } = await s.pty('term').attach(c.id);
  assert.equal(backlog.length, 256 * 1024, 'хвост по умолчанию - 256 КиБ');
  assert.equal(backlog, `$ ${out}`.slice(-256 * 1024));
});

test('pty.write из хоста плагина: pty молчит - сверх ptyQueue Invalid сразу в вызове, вывод процесса снимает отказ (#167)', async () => {
  await using s = await setup({ term: shell }, true, { ptyInput: 1024, ptyInputBurst: 1 << 30, ptyInputRate: 1 << 30, ptyQueue: 2500 });
  const pty = await s.pty('term').spawn({ program: '/bin/bash' });
  const seen: string[] = [];
  pty.onData((d) => void seen.push(d));
  // Подделка выводит приглашение после запуска: оно тоже вывод и обнуляет счёт, поэтому ввод начинается после него.
  await waitFor('приглашение дошло до плагина', () => seen.length > 0);
  const chunk = 'x'.repeat(1000);
  await pty.write(chunk);
  await pty.write(chunk);
  await assert.rejects(pty.write(chunk), { code: 'Invalid', message: /не читает ввод/ });
  s.backend.procs[0]!.emit('вывод');
  await waitFor('вывод дошёл до таблицы', () => pty.write(chunk).then(() => true, () => false));
  await pty.write(chunk);
  await waitFor('очередь процесса получила принятое', () => s.backend.procs[0]!.writes.join('').length === 4000);
});

test('pty.write из хоста плагина: сверх запаса ввода Invalid сразу в вызове, pty жив и принимает ввод по мере пополнения; у соседнего pty свой запас (#134)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  await using s = await setup({ term: shell }, true, { ptyInput: 1024, ptyInputBurst: 2048, ptyInputRate: 1000 });
  const a = await s.pty('term').spawn({ program: '/bin/bash' });
  const b = await s.pty('term').spawn({ program: '/bin/bash' });
  const chunk = 'x'.repeat(1000);
  await a.write(chunk);
  await a.write(chunk);
  await assert.rejects(a.write(chunk), { code: 'Invalid', message: /ввод быстрее 1000 Б\/с/ });
  await b.write(chunk);
  assert.equal(s.backend.procs[0]!.writes.join('').length, 2000, 'отказанный ввод дошёл до процесса');
  t.mock.timers.setTime(1_000_000 + 1000);
  await a.write(chunk);
  assert.equal(s.backend.procs[0]!.writes.join('').length, 3000);
});
