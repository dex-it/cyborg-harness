import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext, Subscription } from '@cyborg-harness/contracts';
import { fakePty } from '../../testing/src/fake-pty.ts';
import { memorySecrets } from '../../testing/src/memory.ts';
import { sandbox } from '../../testing/src/sandbox.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type Kernel, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { waitFor } from './wait-for.ts';
import type { ExitRecord, OperationRecord, StreamRecord, TraceRecord } from '../src/trace-record.ts';
import { inlineHosts, type SpawnHost } from '../src/transports.ts';
import { trackKernels } from './kernels.ts';

// K-28 (FR-CH-4001…4008, NFR-CH-1004, NFR-CH-4002): трасса операций на границах Г1 - Г5.

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'trace.files': { 1: TraceFiles };
    'trace.ticker': { 1: { onTick(listener: (n: number) => void): Subscription } };
  }
}

interface TraceFiles {
  read?(path: string): Promise<string>;
  env?(): Promise<string | undefined>;
  fail?(): Promise<never>;
  echo?(text: string): Promise<string>;
}

const track = trackKernels();
const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
const isOp = (r: TraceRecord): r is OperationRecord => r.kind === 'operation';
const isStream = (r: TraceRecord): r is StreamRecord => r.kind === 'stream';
const isExit = (r: TraceRecord): r is ExitRecord => r.kind === 'exit';

interface Rig {
  readonly k: Kernel;
  readonly ctx: Record<string, PluginContext>;
  readonly records: TraceRecord[];
  /** Сообщения ядра хостам, как они уходят по каналу (JSON): плагин видит только их. */
  readonly toHosts: string[];
  readonly logs: string[];
  ops(): OperationRecord[];
  /** Забирает записи операций, накопленные с прошлого вызова. */
  take(): OperationRecord[];
}

/** Ядро с хостами в процессе теста; плагин берёт `ctx` при активации. `trace: false` - без `onTrace`. */
async function rig(table: Record<string, PluginModule>, manifests: unknown[], options: Partial<LoadOptions> & { trace?: boolean; spawn?: SpawnHost } = {}): Promise<Rig> {
  const { trace = true, spawn, ...rest } = options;
  const ctx: Record<string, PluginContext> = {};
  const records: TraceRecord[] = [];
  const toHosts: string[] = [];
  const logs: string[] = [];
  const base =
    spawn ??
    inlineHosts(async (entry) => {
      const mod = table[entry];
      if (!mod) throw new Error(`нет модуля ${entry}`);
      return {
        ...mod,
        activate(c: PluginContext) {
          ctx[entry] = c;
          return mod.activate(c);
        },
      };
    });
  const k = track(
    await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: manifests.map((m) => (m as { id: string }).id),
      manifests,
      spawnHost: (hostId) => {
        const handle = base(hostId);
        const post = (m: unknown, t?: readonly unknown[]) => {
          toHosts.push(JSON.stringify(m));
          handle.port.post(m, t);
        };
        return { ...handle, port: { onMessage: (l) => handle.port.onMessage(l), post } };
      },
      onLog: (id, message) => void logs.push(`${id}: ${message}`),
      ...(trace && { onTrace: (r: TraceRecord) => void records.push(r) }),
      ...rest,
    }),
  );
  let taken = 0;
  return {
    k,
    ctx,
    records,
    toHosts,
    logs,
    ops: () => records.filter(isOp),
    take() {
      const fresh = records.slice(taken).filter(isOp);
      taken = records.length;
      return fresh;
    },
  };
}

const ENV = { TRACE_ENV: 'env-value' };

/** Два плагина в разных хостах: `files` отдаёт контракт и команду, `app` ими пользуется и читает env. */
const pair: Record<string, PluginModule> = {
  files: {
    activate(ctx) {
      ctx.contracts.provide('trace.files', '1.0', {
        read: async (p: string) => `data:${p}`,
        env: async () => ctx.os.env!.get('TRACE_ENV'),
        fail: () => Promise.reject(new Error('отказ поставщика')),
      });
      ctx.commands.register('files.go', (arg) => `go:${String(arg)}`);
    },
  },
  app: { activate: (ctx) => void ctx.commands.register('app.go', () => ctx.contracts.get('trace.files', 1)!.env!()) },
};
const pairManifests = [
  manifest('files', { provides: { 'trace.files': '1.0' }, commands: { 'files.go': { args: ['any'], callers: 'plugins' } }, permissions: { env: ['TRACE_ENV'] } }),
  manifest('app', { requires: { 'trace.files': '^1' }, commands: ['app.go'], permissions: { env: ['TRACE_ENV'] } }),
];
const pairOptions = { hosts: { f: ['files'], a: ['app'] }, os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', env: ENV } } as const;

test('трасса: вызов ctx.os, член контракта, команда и вызов моста дают по одной записи с границами, адресатом и итогом (FR-CH-4001, NFR-CH-1004)', async () => {
  const r = await rig(pair, pairManifests, pairOptions);
  const app = r.ctx.app!;
  r.take();

  assert.equal(await app.os.env!.get('TRACE_ENV'), 'env-value');
  const [os, ...noMore1] = r.take();
  assert.equal(noMore1.length, 0, 'вызов ctx.os - одна запись');
  assert.deepEqual(
    { ...os, id: undefined, chain: undefined, at: undefined, durationMs: undefined },
    {
      kind: 'operation', id: undefined, chain: undefined, at: undefined, caller: 'plugin:app', hostId: 'a', target: 'os:env.get', boundaries: ['host', 'os'],
      right: 'env', durationMs: undefined, argsBytes: 'TRACE_ENV'.length, resultBytes: 'env-value'.length, outcome: 'ok',
    },
  );
  assert.ok(os!.durationMs >= 0 && os!.at > 0);

  await app.contracts.get('trace.files', 1)!.read!('x');
  const [member, ...noMore2] = r.take();
  assert.equal(noMore2.length, 0, 'член контракта другого хоста - одна запись, хотя прошёл Г1, Г3 и снова Г1');
  assert.deepEqual([member!.caller, member!.hostId, member!.target, member!.callee, member!.boundaries, member!.outcome], ['plugin:app', 'a', 'contract:trace.files@1#read', 'plugin:files', ['host', 'contract', 'host'], 'ok']);
  assert.equal(member!.argsBytes, 1);
  assert.equal(member!.resultBytes, 'data:x'.length);

  await app.commands.run('files.go', 'y');
  const [command, ...noMore3] = r.take();
  assert.equal(noMore3.length, 0, 'команда - одна запись');
  assert.deepEqual([command!.caller, command!.target, command!.callee, command!.boundaries, command!.outcome], ['plugin:app', 'command:files.go', 'plugin:files', ['host', 'contract', 'host'], 'ok']);

  await r.k.callAs('app', 'trace.files', 1, 'read', ['z']);
  const [viewMember, ...noMore4] = r.take();
  assert.equal(noMore4.length, 0, 'вызов моста - одна запись');
  assert.deepEqual([viewMember!.caller, viewMember!.hostId, viewMember!.target, viewMember!.callee, viewMember!.boundaries], ['view:app', undefined, 'contract:trace.files@1#read', 'plugin:files', ['bridge', 'contract', 'host']]);

  await r.k.runOwn('files', 'files.go', 'q');
  const [viewCommand, ...noMore5] = r.take();
  assert.equal(noMore5.length, 0);
  assert.deepEqual([viewCommand!.caller, viewCommand!.target, viewCommand!.boundaries], ['view:files', 'command:files.go', ['bridge', 'contract', 'host']]);

  await r.k.run('files.go', 'p');
  const [user, ...noMore6] = r.take();
  assert.equal(noMore6.length, 0);
  assert.deepEqual([user!.caller, user!.target, user!.boundaries, user!.chain], ['user', 'command:files.go', ['contract', 'host'], user!.id]);

  assert.throws(() => r.k.viewState('app', 'main'), { code: 'Invalid' });
  assert.deepEqual(
    r.take().map((x) => [x.caller, x.target, x.boundaries, x.outcome, x.code]),
    [['view:app', 'bridge:view.state', ['bridge'], 'error', 'Invalid']],
    'прочие вызовы моста тоже записаны: вид, которого нет в манифесте, - отказ Invalid',
  );
});

test('итог: исключение поставщика, команда без владельца и вызов ctx.os без права - запись с кодом и причиной на английском; вызов без права не выполняется (FR-CH-4003)', async () => {
  await using box = await sandbox();
  const secretFile = box.path('secret.txt');
  await writeFile(secretFile, 'содержимое');
  const r = await rig(pair, pairManifests, { ...pairOptions, os: { dataDir: box.path('data'), tempDir: box.path('temp'), env: ENV } });
  const app = r.ctx.app!;
  r.take();

  await assert.rejects(app.os.fs.readText(secretFile), { code: 'PermissionDenied' });
  const [denied] = r.take();
  assert.deepEqual([denied!.target, denied!.boundaries, denied!.right, denied!.outcome, denied!.code, denied!.reason, denied!.resultBytes], ['os:fs.readText', ['host', 'os'], 'fs.read', 'error', 'PermissionDenied', 'permission denied', 0]);
  assert.ok(r.k.journal.some((e) => e.kind === 'denied' && e.pluginId === 'app' && e.method === 'fs.readText'), 'запись denied в журнале остаётся');

  await assert.rejects(app.contracts.get('trace.files', 1)!.fail!(), { code: 'Remote' });
  const [thrown] = r.take();
  assert.deepEqual([thrown!.target, thrown!.outcome, thrown!.code, thrown!.reason, thrown!.boundaries], ['contract:trace.files@1#fail', 'error', 'Remote', 'remote error', ['host', 'contract', 'host']]);

  await assert.rejects(app.commands.run('nobody.home'), { code: 'CommandNotFound' });
  const [none] = r.take();
  assert.deepEqual([none!.target, none!.code, none!.boundaries], ['command:nobody.home', 'CommandNotFound', ['host', 'contract']]);

  const text = JSON.stringify(r.records);
  assert.ok(!text.includes('отказ поставщика') && !text.includes(secretFile), 'текст исключения и путь в запись не идут: причина - по коду');
});

test('цепочка: клик вида -> команда -> член контракта другого плагина -> ctx.os несут номер первой записи; сочетание строит цепочку так же (FR-CH-4002)', async () => {
  const r = await rig(pair, pairManifests, pairOptions);
  r.take();

  await r.k.runOwn('app', 'app.go');
  const fromView = r.take();
  assert.deepEqual(fromView.map((x) => x.target).sort(), ['command:app.go', 'contract:trace.files@1#env', 'os:env.get']);
  const first = fromView.find((x) => x.target === 'command:app.go')!;
  assert.deepEqual([first.caller, first.chain], ['view:app', first.id], 'цепочку начинает вызов моста: номер равен id его записи');
  assert.ok(first.id < Math.min(...fromView.filter((x) => x !== first).map((x) => x.id)));
  assert.deepEqual([...new Set(fromView.map((x) => x.chain))], [first.id]);
  assert.equal(fromView.find((x) => x.target === 'os:env.get')?.caller, 'plugin:files', 'ctx.os вызвал поставщик члена');

  await r.k.run('app.go');
  const fromKeys = r.take();
  const start = fromKeys.find((x) => x.caller === 'user')!;
  assert.deepEqual([...new Set(fromKeys.map((x) => x.chain))], [start.id]);
  assert.equal(fromKeys.length, 3);
  assert.notEqual(start.chain, first.chain, 'вторая цепочка - другая');
});

test('цепочка: событие контракта начинает цепочку, колбэк потребителя с вызовом ctx.os идёт в ней (FR-CH-4001, 4002)', async () => {
  let fire: (n: number) => void = () => undefined;
  const table: Record<string, PluginModule> = {
    ticker: {
      activate(ctx) {
        const listeners = new Set<(n: number) => void>();
        fire = (n) => listeners.forEach((l) => l(n));
        ctx.contracts.provide('trace.ticker', '1.0', {
          onTick(listener: (n: number) => void) {
            listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
        });
      },
    },
    user: {
      activate(ctx) {
        ctx.contracts.get('trace.ticker', 1)!.onTick(() => void ctx.os.env!.get('TRACE_ENV'));
      },
    },
  };
  const r = await rig(
    table,
    [manifest('ticker', { provides: { 'trace.ticker': '1.0' } }), manifest('user', { optional: { 'trace.ticker': '^1' }, permissions: { env: ['TRACE_ENV'] } })],
    { hosts: { t: ['ticker'], u: ['user'] }, os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', env: ENV } },
  );
  await sleep(30);
  r.take();

  fire(1);
  await sleep(60);
  const [event, os, ...rest] = r.take().sort((a, b) => a.id - b.id);
  assert.equal(rest.length, 0, 'событие и вызов из колбэка - две записи');
  assert.deepEqual([event!.caller, event!.hostId, event!.target, event!.callee, event!.boundaries, event!.outcome], ['plugin:ticker', 't', 'event:trace.ticker@1#onTick', 'plugin:user', ['host', 'contract', 'host'], 'ok']);
  assert.equal(event!.chain, event!.id, 'событие вне другой операции начинает цепочку');
  assert.deepEqual([os!.target, os!.caller, os!.chain], ['os:env.get', 'plugin:user', event!.id]);
});

test('содержимое: маркер в аргументе и в результате, значение секрета и путь в записи не попадают, размеры - да (FR-CH-4004, NFR-CH-4002)', async () => {
  await using box = await sandbox();
  const marker = `МАРКЕР-${randomUUID()}`;
  const secret = `s3cr3t-${randomUUID()}`;
  await mkdir(box.path('work'));
  await writeFile(box.path('work', `${marker}.txt`), marker);
  const table: Record<string, PluginModule> = { files: { activate: (ctx) => void ctx.contracts.provide('trace.files', '1.0', { echo: async (s: string) => s }) }, app: { activate() {} } };
  const secrets = memorySecrets();
  const r = await rig(
    table,
    [
      manifest('files', { provides: { 'trace.files': '1.0' } }),
      manifest('app', { requires: { 'trace.files': '^1' }, permissions: { 'fs.read': [box.path('work')], 'secrets.ref': ['vault://x/*'] } }),
    ],
    { hosts: { f: ['files'], a: ['app'] }, os: { dataDir: box.path('data'), tempDir: box.path('temp'), secrets } },
  );
  const app = r.ctx.app!;
  r.take();

  assert.equal(await app.contracts.get('trace.files', 1)!.echo!(marker), marker);
  await app.os.secrets.set('token', secret);
  assert.equal(await app.os.secrets.get('token'), secret);
  assert.equal(await app.os.fs.readText(box.path('work', `${marker}.txt`)), marker);

  const ops = r.take();
  assert.equal(ops.length, 4);
  const echo = ops.find((x) => x.target.startsWith('contract:'))!;
  assert.deepEqual([echo.argsBytes, echo.resultBytes], [Buffer.byteLength(marker), Buffer.byteLength(marker)], 'размеры вместо содержимого');
  const text = JSON.stringify(r.records);
  for (const leak of [marker, secret, box.root, 'work']) assert.ok(!text.includes(leak), `в трассе есть ${leak.slice(0, 12)}…`);
});

test('содержимое: значение секрета, полученное через secrets.resolve, и ссылка на внешний источник в трассу не попадают, запись операции есть (NFR-CH-4002, #168)', async () => {
  const secret = `s3cr3t-${randomUUID()}`;
  const ref = `vault://x/${randomUUID()}`;
  const secrets = memorySecrets();
  const r = await rig({ app: { activate() {} } }, [manifest('app', { permissions: { 'secrets.ref': ['vault://x/*'] } })], { os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', secrets } });
  const app = r.ctx.app!;
  await app.os.secrets.set('token', secret);
  r.take();

  assert.deepEqual(await app.secrets.resolve({ $secret: 'token' }), { value: secret });
  assert.deepEqual(await app.secrets.resolve('token'), { value: secret });
  await assert.rejects(app.secrets.resolve(ref), { code: 'Unavailable' });
  await assert.rejects(app.secrets.resolve('vault://elsewhere/y'), { code: 'PermissionDenied' });

  const ops = r.take().filter((op) => op.target.startsWith('os:secrets.resolve'));
  assert.deepEqual(
    ops.map((op) => [op.caller, op.target, op.boundaries, op.right, op.outcome, op.code]),
    [
      ['plugin:app', 'os:secrets.resolve', ['host', 'os'], 'secrets.ref', 'ok', undefined],
      ['plugin:app', 'os:secrets.resolve', ['host', 'os'], 'secrets.ref', 'ok', undefined],
      ['plugin:app', 'os:secrets.resolve', ['host', 'os'], 'secrets.ref', 'error', 'Unavailable'],
      ['plugin:app', 'os:secrets.resolve', ['host', 'os'], 'secrets.ref', 'error', 'PermissionDenied'],
    ],
    'каждый вызов resolve - запись операции с границами хоста и ОС и правом secrets.ref',
  );
  assert.deepEqual(ops.map((op) => op.resultBytes > 0), [true, true, false, false], 'размер результата есть, содержимого нет');
  const text = JSON.stringify(r.records);
  for (const leak of [secret, ref, 'elsewhere']) assert.ok(!text.includes(leak), `в трассе есть ${leak.slice(0, 12)}…`);
});

test('поток: 5000 сообщений pty за интервал дают одну запись-счётчик с числом сообщений и байт, а не запись на сообщение (FR-CH-4005)', async () => {
  const pty = fakePty();
  const r = await rig(
    { term: { activate() {} } },
    [manifest('term', { permissions: { pty: [{ program: '/bin/bash', args: [] }] } })],
    { os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', pty }, limits: { ptyFlushMs: 0, traceStreamMs: 60_000 } },
  );
  const handle = await r.ctx.term!.os.pty!.spawn({ program: '/bin/bash', args: [] });
  const seen: string[] = [];
  handle.onData((chunk) => seen.push(chunk));
  await sleep(30);
  const proc = pty.procs[0]!;
  for (let i = 0; i < 5000; i++) proc.emit('0123456789');
  // Доставка 5000 кусков хосту идёт по каналу; на занятом раннере она дольше любой фиксированной паузы.
  await waitFor('плагин получил приглашение и 5000 кусков', () => seen.length === 5001);
  assert.equal(seen.length, 5001, 'плагин получил приглашение и 5000 кусков');
  assert.deepEqual(r.records.filter(isStream), [], 'интервал не кончился: счётчик ещё считает');

  await r.k.unload();
  const streams = r.records.filter(isStream);
  assert.equal(streams.length, 1);
  assert.deepEqual([streams[0]!.stream, streams[0]!.pluginId, streams[0]!.hostId, streams[0]!.messages, streams[0]!.bytes], ['pty-output', 'term', 'term', 5001, 50_002]);
  assert.ok(r.ops().length < 10, 'операций на сообщение нет');
});

test('поток: счётчик закрывается по истечении интервала, следующий интервал считается заново (FR-CH-4005)', async () => {
  const pty = fakePty();
  const r = await rig(
    { term: { activate() {} } },
    [manifest('term', { permissions: { pty: [{ program: '/bin/bash', args: [] }] } })],
    { os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', pty }, limits: { ptyFlushMs: 0, traceStreamMs: 80 } },
  );
  await r.ctx.term!.os.pty!.spawn({ program: '/bin/bash', args: [] });
  const proc = pty.procs[0]!;
  await sleep(150);
  r.records.length = 0;
  for (let i = 0; i < 20; i++) proc.emit('ab');
  await sleep(200);
  const first = r.records.filter(isStream);
  assert.deepEqual(first.map((s) => [s.messages, s.bytes, s.intervalMs]), [[20, 40, 80]]);
  for (let i = 0; i < 5; i++) proc.emit('abc');
  await sleep(200);
  assert.deepEqual(r.records.filter(isStream).map((s) => [s.messages, s.bytes]), [[20, 40], [5, 15]]);
});

test('поток: события fs.watch пишутся счётчиком за интервал, а не записью на событие (FR-CH-4005)', async () => {
  await using box = await sandbox();
  const dir = box.path('watched');
  await mkdir(dir);
  const r = await rig({ w: { activate() {} } }, [manifest('w', { permissions: { 'fs.read': [dir] } })], { os: { dataDir: box.path('data'), tempDir: box.path('temp') }, limits: { traceStreamMs: 60_000 } });
  const seen: string[][] = [];
  await r.ctx.w!.os.fs.watch(dir, (names) => void seen.push([...names]));
  for (let i = 0; i < 3; i++) {
    await writeFile(`${dir}/f${String(i)}.txt`, 'x');
    await sleep(120);
  }
  assert.ok(seen.length >= 1, 'событие дошло до плагина');
  await r.k.unload();
  const [stream, ...rest] = r.records.filter(isStream);
  assert.equal(rest.length, 0);
  assert.deepEqual([stream!.stream, stream!.pluginId, stream!.messages], ['fs-watch', 'w', seen.length]);
  assert.equal(stream!.bytes, seen.flat().reduce((n, name) => n + Buffer.byteLength(name), 0));
  assert.ok(!r.ops().some((x) => x.target.includes('change')), 'записи на событие нет');
});

test('вызывающий в общем хосте: запись несёт id хоста и имя плагина по отметке канала (FR-CH-4006)', async () => {
  const r = await rig(
    { x: { activate() {} }, y: { activate() {} } },
    [manifest('x', { permissions: { env: ['TRACE_ENV'] } }), manifest('y', { permissions: { env: ['TRACE_ENV'] } })],
    { hosts: { shared: ['x', 'y'] }, bundled: ['x', 'y'], os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', env: ENV } },
  );
  r.take();
  await r.ctx.x!.os.env!.get('TRACE_ENV');
  await r.ctx.y!.os.env!.get('TRACE_ENV');
  assert.deepEqual(r.take().map((x) => [x.caller, x.hostId]), [['plugin:x', 'shared'], ['plugin:y', 'shared']]);
});

test('запуск программы: process.run даёт запись с правом и запись выхода с кодом без вывода программы; pty.spawn - запись запуска и запись выхода (FR-CH-4007)', async () => {
  const pty = fakePty();
  const marker = `ВЫВОД-${randomUUID()}`;
  const r = await rig(
    { p: { activate() {} } },
    [manifest('p', { permissions: { process: [{ program: process.execPath, args: ['-e'] }], pty: [{ program: '/bin/bash', args: [] }] } })],
    { os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', pty } },
  );
  r.take();
  const run = await r.ctx.p!.os.process!.run(process.execPath, ['-e', `console.log(${JSON.stringify(marker)}); process.exit(3)`]);
  assert.deepEqual([run.code, run.stdout.trim()], [3, marker]);
  const [launch, ...rest] = r.take();
  assert.equal(rest.length, 0);
  assert.deepEqual([launch!.target, launch!.right, launch!.boundaries, launch!.outcome], ['os:process.run', 'process', ['host', 'os'], 'ok']);
  const [exit] = r.records.filter(isExit);
  assert.deepEqual([exit!.pluginId, exit!.target, exit!.right, exit!.code, exit!.chain], ['p', 'os:process.run', 'process', 3, launch!.chain]);

  const handle = await r.ctx.p!.os.pty!.spawn({ program: '/bin/bash', args: [] });
  const [spawned] = r.take();
  assert.deepEqual([spawned!.target, spawned!.right, spawned!.boundaries], ['os:pty.spawn', 'pty', ['host', 'os']]);
  handle.onExit(() => undefined);
  pty.procs[0]!.exit(7);
  await sleep(50);
  const exits = r.records.filter(isExit);
  assert.deepEqual(exits.map((e) => [e.target, e.right, e.code]), [['os:process.run', 'process', 3], ['os:pty.spawn', 'pty', 7]]);
  assert.ok(!JSON.stringify(r.records).includes(marker), 'вывод программы в записях не появляется');
});

test('трасса недоступна плагину: в ctx нет члена с трассой, а сообщения ядра хостам не несут ни записей, ни их полей (FR-CH-4008)', async () => {
  const r = await rig(pair, pairManifests, pairOptions);
  await r.ctx.app!.os.env!.get('TRACE_ENV');
  await r.ctx.app!.contracts.get('trace.files', 1)!.read!('x');
  await r.ctx.app!.commands.run('files.go', 1);
  await r.k.runOwn('app', 'app.go');
  assert.ok(r.ops().length >= 4, 'записи есть');

  const members = (value: object, depth = 0): string[] => (depth > 2 ? [] : Object.entries(value).flatMap(([key, v]: [string, unknown]) => [key, ...(typeof v === 'object' && v !== null ? members(v, depth + 1) : [])]));
  const names = members(r.ctx.app!);
  assert.ok(names.length > 10 && !names.some((n) => /trace|journal/i.test(n)), `в ctx есть член про трассу: ${names.join(', ')}`);
  for (const message of r.toHosts) for (const field of ['"boundaries"', '"durationMs"', '"argsBytes"', '"operation"']) assert.ok(!message.includes(field), `хосту ушла запись трассы: ${message.slice(0, 120)}`);
  const keys = Object.keys(r.k);
  assert.ok(!keys.some((n) => /trace/i.test(n)), 'ядро для встраивающего приложения трассу не отдаёт: её читает окно ядра через onTrace');
});

test('сообщение хоста неверной формы и подмена имени плагина - запись на границе Г1 с кодом (FR-CH-4001)', async () => {
  const toKernel = new Map<string, (m: unknown) => void>();
  const base = inlineHosts(async () => ({ activate() {} }));
  const spawn: SpawnHost = (hostId) => {
    const real = base(hostId);
    const onMessage = (l: (m: unknown) => void) => {
      toKernel.set(hostId, l);
      real.port.onMessage(l);
    };
    return { ...real, port: { post: (m, t) => real.port.post(m, t), onMessage } };
  };
  const r = await rig({}, [manifest('x'), manifest('y')], { spawn, hosts: { hx: ['x'], hy: ['y'] } });
  r.take();
  const send = (host: string, m: string, p: unknown) => toKernel.get(host)!(structuredClone({ t: 'req', id: 9_000_000, m, p }));

  send('hx', 'os', { pluginId: 5, method: 'env.get', args: [] });
  send('hx', 'os', { pluginId: 'y', method: 'env.get', args: ['A'] });
  await sleep(50);
  const [malformed, forged] = r.take();
  assert.deepEqual([malformed!.caller, malformed!.hostId, malformed!.target, malformed!.boundaries, malformed!.code], ['host:hx', 'hx', 'host:os', ['host'], 'Invalid']);
  assert.deepEqual([forged!.caller, forged!.hostId, forged!.boundaries, forged!.code], ['plugin:y', 'hx', ['host'], 'Unavailable'], 'названное имя записано как заявленное, отказ - Unavailable');
});

test('без onTrace трасса выключена: записей нет, и сообщения хостам не несут номера цепочки', async () => {
  const off = await rig(pair, pairManifests, { ...pairOptions, trace: false });
  assert.equal(await off.ctx.app!.os.env!.get('TRACE_ENV'), 'env-value');
  await off.k.runOwn('app', 'app.go');
  assert.deepEqual(off.records, []);
  assert.ok(!off.toHosts.some((m) => /"c":\d/.test(m)), 'номер цепочки уходит только при включённой трассе');

  const on = await rig(pair, pairManifests, pairOptions);
  await on.k.runOwn('app', 'app.go');
  assert.ok(on.toHosts.some((m) => /"c":\d/.test(m)), 'с трассой номер цепочки идёт вместе с запросом');
});

test('onTrace бросил: операция идёт как шла, ядро один раз называет сбой в onLog', async () => {
  let calls = 0;
  const r = await rig(pair, pairManifests, {
    ...pairOptions,
    trace: false,
    onTrace: () => {
      calls++;
      throw new Error('приёмник упал');
    },
  });
  assert.equal(await r.ctx.app!.os.env!.get('TRACE_ENV'), 'env-value');
  assert.equal(await r.ctx.app!.contracts.get('trace.files', 1)!.read!('x'), 'data:x');
  assert.ok(calls >= 2, 'приёмник звался на каждую запись');
  assert.deepEqual(r.logs.filter((l) => l.includes('onTrace')), ['хост трасса: onTrace бросил, записи трассы могут теряться: приёмник упал']);
});

test('мост вида (K-13): канал, модальное окно, его данные, размер и закрытие - по записи Г2 от имени вида; обращение главной части к виду выходит на мост (FR-CH-4001)', async () => {
  const r = await rig(
    { v: { activate: (ctx) => void ctx.commands.register('v.form', () => ctx.views.modal('form', { title: 'Форма', data: { имя: 'черновик' } })) } },
    [manifest('v', { commands: { 'v.form': {} }, ui: { views: { form: { module: './form.js', area: 'modal', title: 'Форма' }, main: './ui.js' } } })],
    { bundled: ['v'], os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t' } },
  );
  r.take();
  const result = r.k.run('v.form');
  for (let i = 0; i < 200 && r.k.window.modal === undefined; i++) await sleep(5);
  assert.ok(r.k.window.modal, 'модальное окно показано');

  r.k.modalFor('v', 'form');
  r.k.resizeModal('v', 'form', { height: 320 });
  await r.k.viewPost('v', 'main', 'привет');
  r.k.closeModal('v', 'form', { имя: 'Проект' });
  assert.deepEqual(await result, { имя: 'Проект' });
  await sleep(20);

  const ops = r.take();
  const byTarget = (target: string) => ops.filter((x) => x.target === target);
  for (const target of ['bridge:view.modal', 'bridge:view.post', 'bridge:view.modal.resize', 'bridge:view.modal.close']) {
    const [op, ...rest] = byTarget(target);
    assert.equal(rest.length, 0, `${target}: одна запись`);
    assert.deepEqual([op!.caller, op!.boundaries, op!.outcome], ['view:v', ['bridge'], 'ok'], target);
  }
  const [modal] = byTarget('bridge:views.modal');
  assert.deepEqual([modal!.caller, modal!.hostId, modal!.boundaries, modal!.outcome], ['plugin:v', 'builtin', ['host', 'bridge'], 'ok'], 'ctx.views.modal: Г1 и мост, запись кончается закрытием окна');
  const [command] = byTarget('command:v.form');
  assert.equal(modal!.chain, command!.chain, 'окно открыла команда: одна цепочка');
});
