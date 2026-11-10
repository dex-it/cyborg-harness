// Замер #211: насколько рекурсивное слежение шлюза задерживает цикл событий главного потока, пока другой процесс (git) меняет дерево.
// Запуск: node playground/scripts/watch-lag.mjs --repo <путь> --rev <коммит> [--mode=worker|thread|none] [--runs=2] [--floor=15000] [--json=<файл>]
//   --floor - сколько имён ждать от слежения на один checkout, прежде чем считать лавину законченной (для ai-kit 14 744 файла; для малого репозитория поставьте меньше).
//   worker - как в ядре (слежение в потоке worker_threads); thread - прежнее поведение (`env.watch`, то есть `fs.watch` в главном потоке); none - без слежения (контроль).
// Репозиторий клонируется во временный каталог (git clone --local), исходный не трогается. Цикл меряется таймером в 10 мс: берётся самое долгое опоздание.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { promisify } from 'node:util';
import { inlineHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';

const run = promisify(execFile);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const source = opt('repo');
const rev = opt('rev');
const mode = opt('mode', 'worker');
const runs = Number(opt('runs', '2'));
const FLOOR = Number(opt('floor', '15000'));
if (!source || !rev || !['worker', 'thread', 'none'].includes(mode)) throw new Error('нужны --repo <путь> --rev <коммит> и --mode=worker|thread|none');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const tmp = mkdtempSync(path.join(tmpdir(), 'cyborg-watch-lag-'));
const repo = path.join(tmp, 'repo');
git(tmp, 'clone', '-q', '--local', '--no-hardlinks', source, repo);
const home = git(repo, 'rev-parse', 'HEAD');
const dirs = git(repo, 'ls-files').split('\n').reduce((set, f) => set.add(path.dirname(f)), new Set()).size;

let ctx;
const kernel = await load({
  apiVersion: PLUGIN_API_VERSION,
  spawnHost: inlineHosts(async () => ({ activate: (c) => void (ctx = c) })),
  enabled: ['reader'],
  manifests: [{ id: 'reader', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'fs.read': [tmp] } }],
  os: { dataDir: path.join(tmp, 'data'), tempDir: path.join(tmp, 'temp'), ...(mode === 'thread' && { watch }) },
});

const results = [];
try {
  for (let i = 0; i < runs * 2; i++) {
    const target = i % 2 === 0 ? rev : home;
    const direction = i % 2 === 0 ? 'туда' : 'обратно';
    let events = 0;
    let firstAt = 0;
    let lastAt = 0;
    const started = performance.now();
    const sub = mode === 'none' ? undefined : await ctx.os.fs.watch(repo, (names) => {
      events += names.length;
      lastAt = performance.now();
      if (firstAt === 0) firstAt = lastAt;
    }, (reason) => console.log(`слежение закрыто: ${reason}`), { recursive: true });
    const setupMs = performance.now() - started;
    // Слежение начинает доставку не сразу (FSEvents): пробная запись, пока не отзовётся.
    for (let n = 0; sub && events === 0 && n < 400; n++) {
      writeFileSync(path.join(repo, '.armed'), String(n));
      await sleep(25);
    }
    await sleep(300);
    let maxLag = 0;
    let expected = performance.now() + 10;
    const ticker = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - expected);
      expected = now + 10;
    }, 10);
    const before = events;
    firstAt = 0;
    const t0 = performance.now();
    await run('git', ['checkout', '-q', '--force', target], { cwd: repo });
    const checkoutMs = performance.now() - t0;
    // Лавина закончилась, когда пришло не меньше FLOOR имён (или прошло 60 с) и 2 с новых нет: слежение разбирает удаление тысяч каталогов дольше, чем длится сам checkout.
    lastAt = performance.now();
    while (mode !== 'none' && performance.now() - t0 < 60_000 && (events - before < FLOOR || performance.now() - lastAt < 2000)) await sleep(50);
    clearInterval(ticker);
    await sub?.dispose();
    const row = { direction, dirs, checkoutMs: Math.round(checkoutMs), events: events - before, firstEventMs: firstAt === 0 ? null : Math.round(firstAt - t0), lastEventMs: firstAt === 0 ? null : Math.round(lastAt - t0), maxLagMs: Math.round(maxLag), setupMs: Math.round(setupMs) };
    results.push(row);
    console.log(JSON.stringify({ mode, ...row }));
  }
} finally {
  await kernel.unload();
  rmSync(tmp, { recursive: true, force: true });
}
const jsonOut = opt('json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ mode, results }, null, 2));
