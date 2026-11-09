import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load, type LoadOptions } from '../src/loader.ts';
import type { OsEnvironment } from '../src/os-gateway.ts';
import { groupKilled, type PtyProcess } from '../src/pty.ts';
import { inlineHosts } from '../src/transports.ts';
import type { TestFiles } from './fixtures/contracts.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

const posix = process.platform !== 'win32';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await cond()) return;
    await sleep(20);
  }
  assert.fail(`${what}: не дождались за ${String(ms)} мс`);
}

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-life-')));
  const work = path.join(root, 'work');
  await mkdir(work);
  return { root, work, data: path.join(root, 'data'), temp: path.join(root, 'temp'), [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

async function kernel(plugins: Record<string, unknown>, env: Partial<OsEnvironment> & Pick<OsEnvironment, 'dataDir' | 'tempDir'>, limits?: LoadOptions['limits']) {
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
    enabled: Object.keys(plugins),
    manifests: Object.entries(plugins).map(([id, permissions]) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, permissions })),
    os: env,
    ...(limits && { limits }),
  });
  return { k, ctx: (id: string) => contexts.get(id)! };
}

// Программа пишет свой pid и pid внука, затем оба ждут вечно: внук - то, что программа запустила сама (сборка, MCP-сервер).
const family = (file: string) =>
  `const g=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(file)},process.pid+' '+g.pid);setInterval(()=>{},1e3)`;

async function pidsOf(file: string): Promise<number[]> {
  await until(async () => (await readFile(file, 'utf8').catch(() => '')).includes(' '), 5000, 'pid программы');
  return (await readFile(file, 'utf8')).split(' ').map(Number);
}

test('process.run: выключение плагина и выгрузка ядра завершают программу вместе с её потомками', { skip: !posix && 'группы процессов - POSIX' }, async () => {
  await using box = await sandbox();
  const { k, ctx } = await kernel(
    { a: { process: [{ program: process.execPath, args: ['-e'] }] }, b: { process: [{ program: process.execPath, args: ['-e'] }] } },
    { dataDir: box.data, tempDir: box.temp },
  );
  const pids: number[] = [];
  try {
    const fileA = path.join(box.work, 'a');
    const runA = ctx('a').os.process!.run(process.execPath, ['-e', family(fileA)]).catch(() => undefined);
    pids.push(...(await pidsOf(fileA)));
    const fileB = path.join(box.work, 'b');
    const runB = ctx('b').os.process!.run(process.execPath, ['-e', family(fileB)]).catch(() => undefined);
    pids.push(...(await pidsOf(fileB)));

    await k.disable('a');
    await until(() => !alive(pids[0]!) && !alive(pids[1]!), 3000, 'программа и внук выключенного плагина');
    assert.ok(alive(pids[2]!) && alive(pids[3]!), 'чужая программа не тронута');
    await runA;

    await k.unload();
    await until(() => !alive(pids[2]!) && !alive(pids[3]!), 3000, 'программа и внук при выгрузке ядра');
    await runB;
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('process.run: timeoutMs завершает и потомков программы, а не только её саму', { skip: !posix && 'группы процессов - POSIX' }, async () => {
  await using box = await sandbox();
  const { k, ctx } = await kernel({ a: { process: [{ program: process.execPath, args: ['-e'] }] } }, { dataDir: box.data, tempDir: box.temp });
  const pids: number[] = [];
  try {
    const file = path.join(box.work, 'a');
    const run = ctx('a').os.process!.run(process.execPath, ['-e', family(file)], { timeoutMs: 1500 });
    pids.push(...(await pidsOf(file)));
    assert.equal((await run).signal, 'SIGTERM');
    await until(() => !alive(pids[1]!), 3000, 'внук после тайм-аута');
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await k.unload();
  }
});

test('process.run: signal в options - отмена завершает программу и её потомков, вызывающий получает Cancelled, место в пределе освобождается', { skip: !posix && 'группы процессов - POSIX' }, async () => {
  await using box = await sandbox();
  const { k, ctx } = await kernel({ a: { process: [{ program: process.execPath, args: ['-e'] }] } }, { dataDir: box.data, tempDir: box.temp }, { runs: 1 });
  const pids: number[] = [];
  try {
    const file = path.join(box.work, 'a');
    const abort = new AbortController();
    const run = ctx('a').os.process!.run(process.execPath, ['-e', family(file)], { signal: abort.signal });
    run.catch(() => undefined);
    pids.push(...(await pidsOf(file)));
    abort.abort();
    await assert.rejects(run, { code: 'Cancelled' });
    await until(() => !alive(pids[0]!) && !alive(pids[1]!), 3000, 'программа и внук после отмены');
    const ok = await ctx('a').os.process!.run(process.execPath, ['-e', '0'], { signal: new AbortController().signal });
    assert.equal(ok.code, 0, 'место в пределе runs освободилось, неотменённый сигнал не мешает');
    await assert.rejects(ctx('a').os.process!.run(process.execPath, ['-e', '0'], { signal: AbortSignal.abort() }), { code: 'Cancelled' });
  } finally {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    await k.unload();
  }
});

test('pty: kill бьёт по группе процесса - потомки оболочки агента не остаются сиротами', { skip: !posix && 'группы процессов - POSIX' }, async () => {
  // node-pty делает процесс лидером своей сессии и группы; detached даёт то же без псевдотерминала.
  const leader = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const grand = await new Promise<number>((resolve) => leader.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim()))));
  try {
    const pid = leader.pid!;
    const plain: PtyProcess = {
      pid,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
      write: () => undefined,
      resize: () => undefined,
      kill: (signal) => process.kill(pid, signal),
    };
    groupKilled(plain).kill('SIGTERM');
    await until(() => !alive(grand), 3000, 'потомок оболочки после kill');
  } finally {
    if (alive(grand)) process.kill(grand, 'SIGKILL');
    leader.kill('SIGKILL');
  }
});

test('net.fetch: тело ответа ограничено, бесконечный поток обрывается отказом, а не съедает память', async () => {
  await using box = await sandbox();
  let pulled = 0;
  const endless = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        // Поток конечен (64 МиБ): без предела в шлюзе красный прогон съел бы память машины, а не упал на проверке.
        pull(c) {
          if (++pulled > 64) c.close();
          else c.enqueue(new Uint8Array(1024 * 1024).fill(97));
        },
      }),
    )) as unknown as typeof fetch;
  const { k, ctx } = await kernel({ web: { net: ['api.example.com'] } }, { dataDir: box.data, tempDir: box.temp, fetch: endless });
  await assert.rejects(ctx('web').os.net!.fetch('https://api.example.com/'), (e: Error & { code?: string }) => e.code === 'Remote' && e.message.includes('больше'));
  assert.ok(pulled <= 20, `прочитано ${String(pulled)} МиБ`);
  await k.unload();
});

test('net.fetch: зависший сервер - Timeout по timeoutMs; выгрузка плагина обрывает запрос', async () => {
  await using box = await sandbox();
  const signals: AbortSignal[] = [];
  const hanging = ((_url: URL, init: RequestInit) =>
    new Promise((_, reject) => {
      const signal = init.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason as Error));
    })) as unknown as typeof fetch;
  const { k, ctx } = await kernel({ web: { net: ['api.example.com'] } }, { dataDir: box.data, tempDir: box.temp, fetch: hanging });
  const started = Date.now();
  await assert.rejects(ctx('web').os.net!.fetch('https://api.example.com/', { timeoutMs: 100 }), { code: 'Timeout' });
  assert.ok(Date.now() - started < 2000);
  const pending = ctx('web').os.net!.fetch('https://api.example.com/').catch((e: unknown) => e);
  await until(() => signals.length === 2, 1000, 'второй запрос');
  await k.disable('web');
  assert.ok(signals[1]?.aborted, 'запрос выключенного плагина не оборван');
  await pending;
  await k.unload();
});

test('fs.watch: ошибка наблюдателя (кончились inotify, удалён каталог) - плагин узнаёт о закрытии, а не ждёт событий вечно', async () => {
  await using box = await sandbox();
  const watchers: EventEmitter[] = [];
  const watch = (() => {
    const w = Object.assign(new EventEmitter(), { close: () => undefined });
    watchers.push(w);
    return w as unknown as FSWatcher;
  }) as unknown as NonNullable<OsEnvironment['watch']>;
  const { k, ctx } = await kernel({ reader: { 'fs.read': [box.work] } }, { dataDir: box.data, tempDir: box.temp, watch });
  const closed: string[] = [];
  await ctx('reader').os.fs.watch(box.work, () => undefined, (reason) => closed.push(reason));
  watchers[0]?.emit('error', new Error('ENOSPC: System limit for number of file watchers reached'));
  await until(() => closed.length > 0, 1000, 'весть о закрытии');
  assert.match(closed[0]!, /ENOSPC/);
  await k.unload();
});

test('вызов контракта: зависший поставщик - потребителю Timeout, а не вечное ожидание', async () => {
  let consumer!: PluginContext;
  const files: TestFiles = { read: () => new Promise<string>(() => undefined) };
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    callTimeout: 150,
    spawnHost: inlineHosts(async (entry) =>
      entry === 'slow' ? { activate: (ctx: PluginContext) => void ctx.contracts.provide('test.files', '1.0', files) } : { activate: (ctx: PluginContext) => void (consumer = ctx) },
    ),
    enabled: ['slow', 'user'],
    manifests: [
      { id: 'slow', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'test.files': '1.0' } },
      { id: 'user', version: '1.0.0', engines: { cyborg: '^1' }, requires: { 'test.files': '^1' } },
    ],
    hosts: { s: ['slow'], u: ['user'] },
    bundled: ['slow', 'user'],
  });
  const started = Date.now();
  await assert.rejects(consumer.contracts.get('test.files', 1)!.read!('x'), { code: 'Timeout' });
  await assert.rejects(k.callAs('user', 'test.files', 1, 'read', ['y']), { code: 'Timeout' });
  assert.ok(Date.now() - started < 2000);
  await k.unload();
});

test('пределы: одновременных process.run у плагина - Invalid сверх предела, место освобождают выход, тайм-аут и выключение; readText крупнее предела и не обычный файл - Invalid', async () => {
  await using box = await sandbox();
  const node = [{ program: process.execPath, args: ['-e'] }];
  const { k, ctx } = await kernel({ a: { process: node, 'fs.read': [box.work] }, b: { process: node } }, { dataDir: box.data, tempDir: box.temp }, { runs: 2, readText: 16 });
  try {
    const wait = (ms: number) => ['-e', `setTimeout(()=>{},${String(ms)})`];
    const quick = ctx('a').os.process!.run(process.execPath, wait(200));
    const slow = ctx('a').os.process!.run(process.execPath, wait(60_000), { timeoutMs: 600 });
    await assert.rejects(ctx('a').os.process!.run(process.execPath, wait(0)), { code: 'Invalid', message: /уже 2 программ/ });
    assert.equal((await ctx('b').os.process!.run(process.execPath, wait(0))).code, 0, 'предел у каждого плагина свой');
    assert.equal((await quick).code, 0);
    const third = ctx('a').os.process!.run(process.execPath, wait(60_000));
    await assert.rejects(ctx('a').os.process!.run(process.execPath, wait(0)), { code: 'Invalid' });
    assert.equal((await slow).signal, 'SIGTERM');
    assert.equal((await ctx('a').os.process!.run(process.execPath, wait(0))).code, 0, 'тайм-аут освободил место');
    await k.disable('a');
    await third.catch(() => undefined);
    await k.enable('a');
    await Promise.all([ctx('a').os.process!.run(process.execPath, wait(0)), ctx('a').os.process!.run(process.execPath, wait(0))]);

    await writeFile(path.join(box.work, 'ok.txt'), 'x'.repeat(16));
    await writeFile(path.join(box.work, 'big.txt'), 'x'.repeat(17));
    assert.equal(await ctx('a').os.fs.readText(path.join(box.work, 'ok.txt')), 'x'.repeat(16));
    await assert.rejects(ctx('a').os.fs.readText(path.join(box.work, 'big.txt')), { code: 'Invalid', message: /больше 16 байт.*fs\.readSlice/ });
    assert.equal((await ctx('a').os.fs.readSlice(path.join(box.work, 'big.txt'), 0, 64)).size, 17, 'крупный файл читается частями');
    if (posix) {
      const fifo = path.join(box.work, 'pipe');
      execFileSync('mkfifo', [fifo]);
      await assert.rejects(ctx('a').os.fs.readText(fifo), { code: 'Invalid', message: /не обычный файл/ }, 'FIFO без писателя не вешает чтение и не обходит предел');
      await assert.rejects(ctx('a').os.fs.readSlice(fifo, 0, 64), { code: 'Invalid', message: /не обычный файл/ });
    }
  } finally {
    await k.unload();
  }
});
