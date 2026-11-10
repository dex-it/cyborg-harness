import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load as loadKernel } from '../src/loader.ts';
import { activeTreeWatches, startTreeWatch, type TreeWatch } from '../src/tree-watch.ts';
import { inlineHosts } from '../src/transports.ts';
import { trackKernels } from './kernels.ts';
import { waitFor } from './wait-for.ts';

// #211: рекурсивное слежение живёт в потоке node:worker_threads. Здесь - жизнь потока: закрытие, отказы и выход, отмена до готовности, нарезка пачек.
const track = trackKernels();
const open: TreeWatch[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((w) => w.close()));
  assert.equal(activeTreeWatches(), 0, 'после теста не осталось потоков слежения');
});

async function dir() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-tree-watch-')));
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

/** Код потока вместо настоящего: сообщение о готовности и что-то ещё. */
const fake = (body: string) => `const { parentPort } = require('node:worker_threads'); ${body}`;

async function watchTree(target: string, handlers: { names?: (b: readonly string[]) => void; failed?: (r: string) => void } = {}, options?: Parameters<typeof startTreeWatch>[2]): Promise<TreeWatch> {
  const w = await startTreeWatch(target, { names: handlers.names ?? (() => undefined), failed: handlers.failed ?? (() => undefined) }, options);
  open.push(w);
  return w;
}

/** macOS начинает доставку не сразу после постановки: пишем пробный файл, пока слежение не отзовётся. */
async function armed(root: string, heard: () => boolean): Promise<void> {
  let n = 0;
  await waitFor('слежение отозвалось на пробную запись', async () => {
    if (heard()) return true;
    await writeFile(path.join(root, '.armed'), String(n++));
    return undefined;
  });
}

test('поток слежения отдаёт имена от корня пачками, а закрытие останавливает поток и ничего больше не доставляет', async () => {
  await using box = await dir();
  await mkdir(path.join(box.root, 'a', 'b'), { recursive: true });
  const heard = new Set<string>();
  const w = await watchTree(box.root, { names: (batch) => batch.forEach((n) => heard.add(n)) });
  assert.equal(activeTreeWatches(), 1);
  await armed(box.root, () => heard.size > 0);
  await writeFile(path.join(box.root, 'a', 'b', 'c.txt'), '1');
  await waitFor('имя файла в глубине', () => heard.has(path.join('a', 'b', 'c.txt')));
  await w.close();
  assert.equal(activeTreeWatches(), 0, 'закрытие остановило поток');
  await w.close();
  const after = heard.size;
  await writeFile(path.join(box.root, 'a', 'later.txt'), '1');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(heard.size, after, 'после закрытия имён нет');
});

test('лавина событий уходит сообщениями не длиннее порции, а не одним сообщением на событие', async () => {
  await using box = await dir();
  const batches: number[] = [];
  let names = 0;
  await watchTree(box.root, {
    names: (batch) => {
      batches.push(batch.length);
      names += batch.length;
    },
  });
  await armed(box.root, () => names > 0);
  batches.length = 0;
  names = 0;
  const FILES = 4500;
  await Promise.all(Array.from({ length: FILES }, (_, i) => writeFile(path.join(box.root, `f${String(i)}.txt`), '1')));
  await waitFor('все имена лавины', () => names >= FILES, { timeout: 30_000 });
  assert.ok(Math.max(...batches) <= 2000, `порция не длиннее 2000 имён: ${batches.join(',')}`);
  assert.ok(batches.length < FILES / 10, `сообщений во много раз меньше событий: ${String(batches.length)}`);
});

test('отказ ОС при постановке приходит ошибкой с кодом ОС, поток не остаётся', async () => {
  await using box = await dir();
  await assert.rejects(watchTree(path.join(box.root, 'нет такого')), { code: 'ENOENT' });
  await waitFor('поток остановлен', () => activeTreeWatches() === 0);
});

test('поток упал или вышел до готовности - Unavailable с причиной, поток остановлен', async () => {
  await assert.rejects(watchTree('/', {}, { source: fake(`throw new Error('сломан');`) }), { code: 'Unavailable', message: /упал: сломан/ });
  await assert.rejects(watchTree('/', {}, { source: fake(`process.exit(3);`) }), { code: 'Unavailable', message: /завершился сам/ });
  assert.equal(activeTreeWatches(), 0);
});

test('поток упал, вышел или сообщил об ошибке наблюдателя после готовности - слушатель узнаёт один раз, поток остановлен', async () => {
  const reasons: string[] = [];
  const failed = (r: string) => reasons.push(r);
  await watchTree('/', { failed }, { source: fake(`parentPort.postMessage({ type: 'ready' }); setTimeout(() => { throw new Error('поздний сбой'); }, 20);`) });
  await waitFor('весть о падении', () => reasons.length > 0);
  assert.match(reasons[0] ?? '', /упал: поздний сбой/);
  await watchTree('/', { failed }, { source: fake(`parentPort.postMessage({ type: 'ready' }); setTimeout(() => process.exit(0), 20);`) });
  await waitFor('весть о выходе', () => reasons.length > 1);
  assert.match(reasons[1] ?? '', /завершился сам/);
  await watchTree('/', { failed }, { source: fake(`parentPort.postMessage({ type: 'ready' }); parentPort.postMessage({ type: 'error', message: 'ENOSPC: нет слежений' }); parentPort.postMessage({ type: 'error', message: 'второй раз' });`) });
  await waitFor('весть об ошибке наблюдателя', () => reasons.length > 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(reasons.slice(2), ['ENOSPC: нет слежений'], 'об ошибке один раз');
  await waitFor('потоки остановлены', () => activeTreeWatches() === 0);
});

test('отмена до готовности останавливает поток и отказывает постановке; уже отменённый сигнал - тоже', async () => {
  const stuck = fake('setInterval(() => undefined, 1000);');
  const controller = new AbortController();
  const pending = watchTree('/', {}, { source: stuck, signal: controller.signal });
  await waitFor('поток запущен', () => activeTreeWatches() === 1);
  controller.abort();
  await assert.rejects(pending, { code: 'Unavailable', message: /отменено/ });
  await assert.rejects(watchTree('/', {}, { source: stuck, signal: AbortSignal.abort() }), { code: 'Unavailable' });
  await waitFor('потоки остановлены', () => activeTreeWatches() === 0);
});

test('поток, не откликнувшийся на закрытие, завершается принудительно', async () => {
  const w = await watchTree('/', {}, { source: fake(`parentPort.postMessage({ type: 'ready' }); parentPort.on('message', () => undefined);`) });
  await w.close();
  assert.equal(activeTreeWatches(), 0);
});

test('шлюз: снятие слежения и выгрузка ядра останавливают потоки; выгрузка посреди постановки не оставляет поток', async (t) => {
  await using box = await dir();
  for (let i = 0; i < 300; i++) await mkdir(path.join(box.root, `d${String(i)}`, 'e'), { recursive: true });
  let ctx: PluginContext | undefined;
  const k = track(
    await loadKernel({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
      enabled: ['reader'],
      manifests: [{ id: 'reader', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'fs.read': [box.root] } }],
      os: { dataDir: path.join(box.root, 'data'), tempDir: path.join(box.root, 'temp') },
    }),
  );
  assert.ok(ctx);
  const fs = ctx.os.fs;
  const one = await fs.watch(box.root, () => undefined, undefined, { recursive: true });
  const two = await fs.watch(box.root, () => undefined, undefined, { recursive: true });
  assert.equal(activeTreeWatches(), 2);
  one.dispose();
  await waitFor('снятие остановило поток', () => activeTreeWatches() === 1);
  two.dispose();
  await waitFor('снятие остановило второй поток', () => activeTreeWatches() === 0);

  await fs.watch(box.root, () => undefined, undefined, { recursive: true });
  assert.equal(activeTreeWatches(), 1);
  // Выгрузка в любой миг постановки: вызов либо успел, либо отказал; потока не остаётся.
  const racing = fs.watch(box.root, () => undefined, undefined, { recursive: true }).catch((e: unknown) => e);
  await k.unload();
  const outcome = await racing;
  if (outcome instanceof Error) assert.match((outcome as { code?: string }).code ?? '', /^(Unavailable|HostGone)$/);
  await waitFor('выгрузка остановила все потоки', () => activeTreeWatches() === 0);
  t.diagnostic(`постановка при выгрузке: ${outcome instanceof Error ? 'отказ' : 'успела'}`);
});
