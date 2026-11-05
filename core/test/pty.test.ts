import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, PtyExit } from '@cyborg/contracts';
import { load } from '../src/loader.ts';
import { describePermissions } from '../src/permissions.ts';
import type { PtyBackend, PtyProcess } from '../src/pty.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';

interface FakeProc extends PtyProcess {
  readonly file: string;
  readonly args: string[];
  readonly options: { cwd?: string; env: Record<string, string>; cols: number; rows: number };
  readonly writes: string[];
  readonly resizes: [number, number][];
  killed?: string;
  emit(data: string): void;
  exit(code: number): void;
}

/** Псевдотерминал без ОС: тест сам пишет вывод и завершает процесс. */
function fakePty(): PtyBackend & { procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  return {
    procs,
    spawn(file, args, options) {
      const data = new Set<(d: string) => void>();
      const exits = new Set<(e: { exitCode: number; signal?: number }) => void>();
      const proc: FakeProc = {
        pid: 1000 + procs.length,
        file,
        args,
        options,
        writes: [],
        resizes: [],
        onData: (l) => (data.add(l), { dispose: () => data.delete(l) }),
        onExit: (l) => (exits.add(l), { dispose: () => exits.delete(l) }),
        write: (d) => void proc.writes.push(d),
        resize: (c, r) => void proc.resizes.push([c, r]),
        kill(signal) {
          proc.killed = signal ?? 'SIGHUP';
        },
        emit: (d) => {
          for (const l of data) l(d);
        },
        exit: (code) => {
          for (const l of exits) l({ exitCode: code });
        },
      };
      procs.push(proc);
      // Вывод сразу после запуска: проверяет, что хост не теряет его до подписки плагина.
      setImmediate(() => proc.emit('$ '));
      return proc;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

async function setup(plugins: Record<string, unknown>, withBackend = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-pty-'));
  const work = path.join(root, 'work');
  await mkdir(work);
  const backend = fakePty();
  const contexts = new Map<string, PluginContext>();
  const handles = new Map<string, HostHandle>();
  const spawn = inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) }));
  const k = await load({
    apiVersion: '1.0.0',
    enabled: Object.keys(plugins),
    manifests: Object.entries(plugins).map(([id, permissions]) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...(permissions !== undefined && { permissions }) })),
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: '/usr/bin', HOME: '/h', SECRET: 'x' }, ...(withBackend && { pty: backend }) },
    spawnHost: (id) => {
      const h = spawn(id);
      handles.set(id, h);
      return h;
    },
  });
  const pty = (id: string) => {
    const p = contexts.get(id)?.os.pty;
    assert.ok(p, `${id}: нет ctx.os.pty`);
    return p;
  };
  return { k, backend, pty, handles, work, [Symbol.asyncDispose]: async () => {
      await k.unload();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const shell = { pty: [{ program: '/bin/bash', args: [], env: ['COLORTERM'] }], 'fs.read': [] as string[] };

test('pty.spawn: программа, окружение и cwd по праву; вывод до подписки не теряется; ввод, размер, сигнал и выход', async () => {
  await using s = await setup({ term: { ...shell, 'fs.read': ['/'] }, plain: undefined });
  const h = await s.pty('term').spawn({ program: '/bin/bash', args: ['-l'], cwd: s.work, env: { COLORTERM: 'truecolor' }, cols: 120, rows: 40 });
  const proc = s.backend.procs[0]!;
  assert.deepEqual([proc.file, proc.args, proc.options.cwd, proc.options.cols, proc.options.rows], ['/bin/bash', ['-l'], s.work, 120, 40]);
  assert.deepEqual(proc.options.env, { PATH: '/usr/bin', HOME: '/h', COLORTERM: 'truecolor' }, 'чужое окружение Cyborg дошло до pty');
  assert.equal(h.pid, proc.pid);
  await tick();
  const seen: string[] = [];
  h.onData((c) => seen.push(c));
  proc.emit('ls\r\n');
  await tick();
  assert.deepEqual(seen, ['$ ', 'ls\r\n']);
  await h.write('echo 1\r');
  await h.resize(100, 30);
  await assert.rejects(h.resize(0, 30), { code: 'Invalid' });
  await assert.rejects(h.kill('SIGSTOP' as never), { code: 'Invalid' });
  assert.deepEqual([proc.writes, proc.resizes], [['echo 1\r'], [[100, 30]]]);
  const exits: PtyExit[] = [];
  h.onExit((e) => exits.push(e));
  proc.exit(3);
  await tick();
  assert.deepEqual(exits, [{ code: 3 }]);
  await assert.rejects(h.write('x'), { code: 'NotFound' });

  await assert.rejects(s.pty('term').spawn({ program: '/bin/sh' }), { code: 'PermissionDenied' });
  await assert.rejects(s.pty('term').spawn({ program: '/bin/bash', env: { LD_PRELOAD: '/x.so' } }), { code: 'PermissionDenied' });
  assert.equal(s.backend.procs.length, 1, 'запуск без права дошёл до бэкенда');
});

test('pty: чужие не видны и не трогаются; cwd вне права - отказ; без бэкенда - Unavailable; без права - нет члена', async () => {
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

test('падение хоста: pty с persist живёт и копит вывод, вернувшийся плагин забирает его через attach; без persist - завершён', async () => {
  await using s = await setup({ agent: shell });
  const kept = await s.pty('agent').spawn({ program: '/bin/bash', persist: true, cols: 90, rows: 20 });
  await s.pty('agent').spawn({ program: '/bin/bash' });
  const [keptProc, lostProc] = s.backend.procs as [FakeProc, FakeProc];
  await tick();
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
  await tick();
  assert.deepEqual(seen, ['дальше']);

  await s.k.disable('agent');
  assert.equal(keptProc.killed, 'SIGHUP', 'выключенный плагин оставил pty');
});

test('pty завершился без владельца: list показывает выход, attach отдаёт хвост и выход и убирает запись', async () => {
  await using s = await setup({ agent: shell });
  const kept = await s.pty('agent').spawn({ program: '/bin/bash', persist: true });
  const proc = s.backend.procs[0]!;
  await tick();
  s.handles.get('agent')!.kill();
  await s.k.idle();
  proc.emit('bye');
  proc.exit(0);
  assert.deepEqual((await s.pty('agent').list()).map((i) => i.exit), [{ code: 0 }]);
  const h = await s.pty('agent').attach(kept.id);
  assert.equal(h.backlog, '$ bye');
  const exits: PtyExit[] = [];
  h.onExit((e) => exits.push(e));
  await tick();
  assert.deepEqual(exits, [{ code: 0 }]);
  assert.deepEqual(await s.pty('agent').list(), []);
});
