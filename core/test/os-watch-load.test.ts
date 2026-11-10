import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { PluginContext } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load as loadKernel } from '../src/loader.ts';
import { inlineHosts } from '../src/transports.ts';
import { trackKernels } from './kernels.ts';
import { waitFor } from './wait-for.ts';

// #211: рекурсивное слежение Node на Linux ставит inotify на каждый каталог и обслуживает их в JavaScript. Если это идёт в главном потоке, checkout, удаляющий тысячи каталогов,
// останавливает его цикл на секунды. Тест удаляет такое дерево другим процессом (как git) и меряет, насколько цикл главного потока опоздал.
const track = trackKernels();

/** Порог отставания цикла главного потока, мс. */
const LAG_LIMIT_MS = 100;
/** Каталогов в дереве: 40 x 10 x 10 листьев и их предки - 4 440 каталогов. */
const TOP = 40;
const MID = 10;
const LEAF = 10;
const DIRS = TOP + TOP * MID + TOP * MID * LEAF;

const run = promisify(execFile);

async function build(root: string): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  for (let a = 0; a < TOP; a++) {
    for (let b = 0; b < MID; b++) {
      for (let c = 0; c < LEAF; c++) jobs.push(mkdir(path.join(root, `a${String(a)}`, `b${String(b)}`, `c${String(c)}`), { recursive: true }));
    }
    if (jobs.length >= 500) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
  await writeFile(path.join(root, 'a0', 'b0', 'c0', 'file.txt'), '1');
}

test(`fs.watch recursive: удаление дерева из ${String(DIRS)} каталогов другим процессом не задерживает цикл главного потока дольше ${String(LAG_LIMIT_MS)} мс (Linux) (#211)`, async (t) => {
  // На macOS слежение идёт через FSEvents и отставание 17-22 мс (docs/05-verification/pilot-files-git.md): порог проверяется только на Linux, там inotify.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-watch-load-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = path.join(root, 'tree');
  await mkdir(tree);
  await build(tree);

  let ctx: PluginContext | undefined;
  track(
    await loadKernel({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
      enabled: ['reader'],
      manifests: [{ id: 'reader', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'fs.read': [root] } }],
      os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
    }),
  );
  assert.ok(ctx);

  const heard = new Set<string>();
  let batches = 0;
  let lastBatchAt = 0;
  const started = performance.now();
  const sub = await ctx.os.fs
    .watch(tree, (names) => {
      batches++;
      lastBatchAt = performance.now();
      for (const name of names) heard.add(name);
    }, undefined, { recursive: true })
    .catch((error: unknown) => {
      // Мало слежений ОС (fs.inotify.max_user_watches) на этом стенде: отказ шлюза назван и ожидаем (раздел 6 pilot-files-git.md), а не ошибка проверки.
      if ((error as { code?: string }).code === 'Unavailable') return undefined;
      throw error;
    });
  if (sub === undefined) {
    t.skip('ОС не дала слежение за деревом (Unavailable): мало fs.inotify.max_user_watches');
    return;
  }
  const watchStartedMs = performance.now() - started;

  // FSEvents начинает доставку не в тот миг, когда watch вернулся: пишем пробный файл, пока слежение не отзовётся.
  for (let n = 0; batches === 0; n++) {
    await writeFile(path.join(tree, '.armed'), String(n));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(performance.now() - started < 30_000, 'слежение не отозвалось на пробную запись');
  }

  // Цикл меряется таймером: самое долгое отставание от срока 10 мс.
  let maxLag = 0;
  let expected = performance.now() + 10;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - expected);
    expected = now + 10;
  }, 10);
  try {
    await new Promise((r) => setTimeout(r, 300));
    expected = performance.now() + 10;
    maxLag = 0;
    const before = batches;
    // Удаляет другой процесс, как `git checkout`: главный поток в нём не участвует.
    await run(process.execPath, ['-e', 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })', tree]);
    await waitFor('события об удалении', () => batches > before);
    // Слежение отдаёт события пачками; лавина закончена, когда новых пачек нет две секунды.
    await waitFor('лавина закончилась', () => performance.now() - lastBatchAt > 2000, { timeout: 60_000 });
  } finally {
    clearInterval(ticker);
    sub.dispose();
  }
  const lagMs = Math.round(maxLag);
  t.diagnostic(`каталогов ${String(DIRS)}; постановка слежения ${String(Math.round(watchStartedMs))} мс; пачек ${String(batches)}, имён ${String(heard.size)}; максимальное отставание цикла ${String(lagMs)} мс (${process.platform})`);
  assert.ok(heard.size > 0, 'удаление дерева дошло до слушателя');
  if (process.platform === 'linux') assert.ok(maxLag <= LAG_LIMIT_MS, `цикл главного потока отстал на ${String(lagMs)} мс при пороге ${String(LAG_LIMIT_MS)} мс`);
});
