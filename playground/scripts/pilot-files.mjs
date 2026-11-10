// Замер пилота PL-04 (files, git, viewer): дерево репозитория через границу плагинов, fs.watch вместо опроса. Запуск: npm run pilot:files -- --repo <путь> [--repo ...].
// Репозиторий клонируется во временный каталог (git clone --local), исходный не трогается. Ядро и плагины - как в playground/test/pilot-files.test.ts: три хоста-процесса (forkHosts),
// не Electron: цена шлюза здесь - цена канала child_process, а не utilityProcess (разница описана в docs/05-verification/pilot-files-git.md).
// Параметры: --runs=<n> прогонов на репозиторий (3), --samples=<n> вызовов на замер задержки (300), --idle=<с> окно простоя (10), --expand=<n> раскрытых каталогов (48), --control=0 без контрольного
// рекурсивного слежения в checkout (на Linux оно удваивает работу Node по inotify), --json=<файл>.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { sandbox } from '@cyborg-harness/testing';
import { startPilot } from '../test/pilot-kit.ts';

const run = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const raw = args.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? fallback : Number(raw.slice(name.length + 3));
};
const repos = args.flatMap((a, i) => (a === '--repo' ? [args[i + 1]] : a.startsWith('--repo=') ? [a.slice(7)] : []));
if (repos.length === 0) throw new Error('нужен хотя бы один --repo <путь>');
const RUNS = flag('runs', 3);
const SAMPLES = flag('samples', 300);
const WARMUP = 30;
const IDLE_MS = flag('idle', 10) * 1000;
const EXPAND = flag('expand', 48);
const CONTROL = flag('control', 1) !== 0;
const jsonOut = args.find((a) => a.startsWith('--json='))?.slice(7);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const median = (xs) => pct(xs, 50);
const dist = (xs) => ({ n: xs.length, p50: round(pct(xs, 50), 3), p95: round(pct(xs, 95), 3), p99: round(pct(xs, 99), 3), max: round(Math.max(...xs), 3) });

/** Главная часть пробы: те же вызовы через шлюз и «голые» в процессе хоста, время считает плагин. */
const PROBE = `
import { performance } from 'node:perf_hooks';
import { readdir, readFile, stat } from 'node:fs/promises';
export default {
  activate(ctx) {
    ctx.commands.register('bench.latency', async (op, target, n, warm) => {
      const ops = {
        'gateway.list': () => ctx.os.fs.list(target),
        'gateway.stat': () => ctx.os.fs.stat(target),
        'gateway.readText': () => ctx.os.fs.readText(target),
        'bare.list': () => readdir(target, { withFileTypes: true }),
        'bare.stat': () => stat(target),
        'bare.readText': () => readFile(target, 'utf8'),
      };
      const out = [];
      for (let i = 0; i < warm + n; i++) {
        const t = performance.now();
        await ops[op]();
        const d = performance.now() - t;
        if (i >= warm) out.push(d);
      }
      return out;
    });
    return undefined;
  },
};
`;
const BENCH = { id: 'bench', source: PROBE, commands: { 'bench.latency': { args: ['string', 'string', 'number', 'number'] } } };

// --- ЦП: процесс замера (ядро и шлюз) плюс его прямые потомки (хосты плагинов) ---
const clock = (text) => text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) * 1000;
function cpuNow() {
  const own = process.cpuUsage();
  const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,time='], { encoding: 'utf8' });
  let hosts = 0;
  for (const line of ps.split('\n')) {
    const [pid, ppid, time] = line.trim().split(/\s+/);
    if (Number(ppid) === process.pid && time) hosts += clock(time);
    void pid;
  }
  return { kernelMs: (own.user + own.system) / 1000, hostsMs: hosts };
}
const cpuDelta = (a, b) => ({ kernelMs: round(b.kernelMs - a.kernelMs, 0), hostsMs: round(b.hostsMs - a.hostsMs, 0), totalMs: round(b.kernelMs - a.kernelMs + b.hostsMs - a.hostsMs, 0) });

/** CPU дочерней программы по /usr/bin/time -p (user + sys, разрешение 10 мс). */
function childCpu(cwd, gitArgs) {
  const r = spawnSync('/usr/bin/time', ['-p', 'git', ...gitArgs], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  const num = (name) => Number(new RegExp(`${name} ([0-9.]+)`).exec(r.stderr)?.[1] ?? 0);
  return (num('user') + num('sys')) * 1000;
}

const state = (p) => p.k.run('files.state');
async function settle(p, quietMs = 600, limitMs = 60_000) {
  const begin = performance.now();
  let last = begin;
  let key = '';
  for (;;) {
    const st = await state(p);
    const now = `${st.version}/${st.pending}/${p.watches.raw}/${st.counters.markRuns}`;
    if (now !== key) {
      key = now;
      last = performance.now();
    }
    if (!st.pending && performance.now() - last >= quietMs) return last - begin;
    if (performance.now() - begin > limitMs) throw new Error('дерево не устоялось за минуту');
    await sleep(20);
  }
}

/** Каталоги для раскрытия: самые населённые по числу файлов в HEAD вместе с предками; часть их checkout уберёт - так и задумано. */
function pickDirs(repo) {
  const head = git(repo, 'ls-files').split('\n').filter(Boolean).map((f) => path.posix.dirname(f)).filter((d) => d !== '.');
  const count = new Map();
  for (const d of head) count.set(d, (count.get(d) ?? 0) + 1);
  const chosen = new Set();
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  const withParents = (d) => d.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  for (const [d] of ranked) {
    const need = withParents(d).filter((x) => !chosen.has(x));
    if (chosen.size + need.length > EXPAND) continue;
    for (const x of need) chosen.add(x);
  }
  return [...chosen].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** Коммит, переход на который меняет много файлов: глубина растёт, пока различий не станет с тысячу (или история не кончится). */
function pickTarget(repo) {
  const total = Number(git(repo, 'rev-list', '--first-parent', '--count', 'HEAD'));
  let best = { rev: `HEAD~${Math.min(total - 1, 1)}`, files: 0 };
  for (let n = 25; n < total + 400; n = Math.floor(n * 1.6)) {
    const rev = `HEAD~${Math.min(total - 1, n)}`;
    const files = git(repo, 'diff', '--name-only', 'HEAD', rev).split('\n').filter(Boolean).length;
    if (files > best.files) best = { rev, files };
    if (files >= 3000 || n >= total - 1) break;
  }
  return { rev: git(repo, 'rev-parse', best.rev).trim(), files: best.files };
}

/** Узлы дерева, не совпавшие с диском: каталога нет вовсе или состав имён другой. */
function mismatches(st) {
  const bad = [];
  for (const node of Object.values(st.nodes)) {
    let disk;
    try {
      disk = readdirSync(node.dir).filter((n) => n !== '.git').toSorted();
    } catch {
      bad.push(`${path.basename(node.dir)}: каталога нет на диске`);
      continue;
    }
    const tree = node.entries.map((e) => e[0]).toSorted();
    if (disk.length !== tree.length || disk.some((n, i) => n !== tree[i])) bad.push(`${path.basename(node.dir)}: имён на диске ${disk.length}, в дереве ${tree.length}`);
  }
  return bad;
}

async function checkout(p, repo, rev, expandedCount) {
  const before = await state(p);
  const gitBefore = (await p.gitRuns()).length;
  const rawBefore = p.watches.raw;
  // Для сравнения: второе рекурсивное слежение Node за корнем (FSEvents на macOS, обход каталогов и inotify на каждый каталог на Linux); `--control=0` его не открывает.
  let recursive = 0;
  let recursiveLast = 0;
  const t0 = performance.now();
  const rw = CONTROL
    ? watch(repo, { recursive: true }, () => {
        recursive++;
        recursiveLast = performance.now() - t0;
      })
    : undefined;
  await sleep(300);
  // Отставание цикла событий процесса замера - это главный процесс приложения: пока слежение Node разбирает события, он не отвечает.
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const start = performance.now();
  await run('git', ['checkout', '-q', rev], { cwd: repo });
  const checkoutMs = performance.now() - start;
  const settledMs = await settle(p);
  lag.disable();
  rw?.close();
  const after = await state(p);
  const statusCli = git(repo, 'status', '--porcelain=v1').split('\n').filter(Boolean).length;
  return {
    checkoutMs: round(checkoutMs, 0),
    loopLagMaxMs: round(lag.max / 1e6, 0),
    loopLagP99Ms: round(lag.percentile(99) / 1e6, 0),
    lastChangeAfterCheckoutMs: round(settledMs, 0),
    rawEvents: p.watches.raw - rawBefore,
    batches: after.counters.batches - before.counters.batches,
    relists: after.counters.relists - before.counters.relists,
    resyncs: after.counters.resyncs - before.counters.resyncs,
    stats: after.counters.stat - before.counters.stat,
    lists: after.counters.list - before.counters.list,
    markRuns: after.counters.markRuns - before.counters.markRuns,
    gitStatusRuns: (await p.gitRuns()).length - gitBefore,
    recursiveEvents: CONTROL ? recursive : null,
    recursiveLastMs: CONTROL ? round(recursiveLast - (start - t0), 0) : null,
    expanded: expandedCount,
    watchesLive: after.watches,
    treeMismatches: mismatches(after),
    marksLeft: Object.keys(after.marks).length,
    statusCliLines: statusCli,
  };
}

async function runOnce(source, index) {
  await using box = await sandbox('cyborg-pl04-bench-');
  const repo = box.path('repo');
  await run('git', ['clone', '-q', '--local', source, repo]);
  const files = git(repo, 'ls-files').split('\n').filter(Boolean);
  const dirCount = new Set(files.map((f) => path.posix.dirname(f))).size;
  const target = pickTarget(repo);
  const dirs = pickDirs(repo);
  const info = { files: files.length, dirs: dirCount, target: target.rev.slice(0, 8), targetChangedFiles: target.files, expandedDirs: dirs.length, mainBranch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim() };
  const home = git(repo, 'rev-parse', 'HEAD').trim();
  const out = { run: index, ...info, load: loadavg().map((x) => round(x, 2)) };

  await using p = await startPilot({ box, repo, watchdog: { interval: 1000, timeout: 20_000, strikes: 3 }, probes: [{ ...BENCH, permissions: { 'fs.read': [repo] } }] });

  // 1. Задержка вызова шлюза: плагин сам считает время вокруг ctx.os.fs.*; «голое» - то же в его процессе без шлюза.
  const bigDir = [repo, ...dirs.map((d) => path.join(repo, d))].map((d) => [d, readdirSync(d).length]).sort((a, b) => b[1] - a[1])[0];
  const aFile = path.join(repo, files[0]);
  out.latency = {};
  for (const [name, target0] of [['list корня', repo], ['list самого большого каталога', bigDir[0]], ['stat файла', aFile], ['readText файла', aFile]]) {
    const op = name.split(' ')[0];
    const gate = await p.k.run('bench.latency', `gateway.${op}`, target0, SAMPLES, WARMUP);
    const bare = await p.k.run('bench.latency', `bare.${op}`, target0, SAMPLES, WARMUP);
    out.latency[name] = { entries: name.startsWith('list') ? readdirSync(target0).length : undefined, gateway: dist(gate), bare: dist(bare) };
  }

  // 2. Первое открытие дерева и отметок.
  const gitBefore = (await p.gitRuns()).length;
  const t0 = performance.now();
  await p.k.run('files.root', repo);
  const rootMs = performance.now() - t0;
  for (;;) {
    const st = await state(p);
    if (st.counters.markRuns >= 1 && !st.pending) break;
    await sleep(2);
  }
  out.firstOpen = { rootListMs: round(rootMs, 1), untilMarksMs: round(performance.now() - t0, 1), marks: Object.keys((await state(p)).marks).length, gitRuns: (await p.gitRuns()).length - gitBefore };

  // 2б. Повторное открытие корня на тёплых хостах: без стоимости первого вызова (загрузка модулей, первый запуск программы).
  const warmOpen = [];
  for (let i = 0; i < 5; i++) {
    const w0 = performance.now();
    await p.k.run('files.root', repo);
    for (;;) {
      const st = await state(p);
      if (st.counters.markRuns >= 1 && !st.pending) break;
      await sleep(1);
    }
    warmOpen.push(performance.now() - w0);
  }
  out.warmOpen = dist(warmOpen);

  // 3. Раскрытие каталогов (по одному, как кликами).
  const times = [];
  for (const d of dirs) {
    const s = performance.now();
    await p.k.run('files.expand', path.join(repo, d));
    times.push(performance.now() - s);
  }
  out.expand = { count: times.length, total: round(times.reduce((a, b) => a + b, 0), 0), ...dist(times) };
  await sleep(500);
  await settle(p);
  const watched = (await state(p)).watches;
  out.watchesAfterExpand = watched;

  // 3б. Тёплая отметка: правка отслеживаемого файла в раскрытом каталоге -> отметка `modified` в дереве (событие, stat, git status через границу хостов).
  const editable = files.filter((f) => dirs.includes(path.posix.dirname(f))).slice(0, 5);
  const marked = [];
  for (const f of editable) {
    const s0 = performance.now();
    writeFileSync(path.join(repo, f), `${readFileSync(path.join(repo, f), 'utf8')}\n// pilot\n`);
    for (;;) {
      if ((await state(p)).marks[f] === 'modified') break;
      if (performance.now() - s0 > 15_000) throw new Error(`отметка ${f} не появилась за 15 с`);
      await sleep(2);
    }
    marked.push(performance.now() - s0);
  }
  git(repo, 'checkout', '--', '.');
  await settle(p);
  out.warmMark = marked.length > 0 ? { n: marked.length, ...dist(marked) } : null;

  // 4. Простой: слежение против опроса раз в 3 с (git status + rev-parse, как в ai-cyborg/src/renderer/app.ts:959 и tree.ts).
  const idleState = await state(p);
  const c0 = cpuNow();
  const gitIdle = (await p.gitRuns()).length;
  await sleep(IDLE_MS);
  const c1 = cpuNow();
  out.idleWatch = { windowMs: IDLE_MS, ...cpuDelta(c0, c1), gitRuns: (await p.gitRuns()).length - gitIdle, calls: JSON.stringify((await state(p)).counters) === JSON.stringify(idleState.counters) ? 0 : 'сдвиг' };
  const poll0 = cpuNow();
  let childMs = 0;
  let ticks = 0;
  const pollEnd = performance.now() + IDLE_MS;
  while (performance.now() < pollEnd) {
    const tick = performance.now();
    childMs += childCpu(repo, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    childMs += childCpu(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    ticks++;
    await sleep(Math.max(0, 3000 - (performance.now() - tick)));
  }
  const poll1 = cpuNow();
  out.idlePoll = { windowMs: IDLE_MS, ticks, ...cpuDelta(poll0, poll1), gitChildrenMs: round(childMs, 0) };
  out.idlePoll.totalWithChildrenMs = round(out.idlePoll.totalMs + childMs, 0);

  // 5. Стоимость самого git status: плагин (normal) и Cyborg (--untracked-files=all), по 10 запусков.
  const timeGit = (extra) => {
    const xs = [];
    for (let i = 0; i < 10; i++) {
      const s = performance.now();
      execFileSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', ...extra], { cwd: repo, maxBuffer: 1 << 28 });
      xs.push(performance.now() - s);
    }
    return round(median(xs), 1);
  };
  out.gitStatusMs = { normal: timeGit(['--branch']), all: timeGit(['--untracked-files=all']) };

  // 6. Checkout туда и обратно при раскрытых каталогах.
  out.checkoutThere = await checkout(p, repo, target.rev, dirs.length);
  out.checkoutBack = await checkout(p, repo, home, dirs.length);

  // 7. Удаление наблюдаемого каталога.
  const alive = Object.keys((await state(p)).nodes).filter((d) => d !== repo).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
  const victim = alive[0] === undefined ? undefined : path.relative(repo, alive[0]);
  if (victim !== undefined) {
    const s = performance.now();
    rmSync(path.join(repo, victim), { recursive: true });
    const key = path.join(repo, victim);
    for (;;) {
      const st = await state(p);
      if (st.nodes[key] === undefined && !st.pending) break;
      if (performance.now() - s > 30_000) throw new Error('удаление каталога не замечено за 30 с');
      await sleep(5);
    }
    out.removeWatchedDir = { dir: victim, untilGoneMs: round(performance.now() - s, 0), watchesLive: (await state(p)).watches };
  }

  // 8. Симлинки внутри репозитория: ссылка на файл внутри, на каталог внутри и на каталог снаружи.
  const outside = box.path('outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'x.txt'), 'x');
  const s = performance.now();
  symlinkSync(path.join(repo, files[0]), path.join(repo, 'zz-link-file'));
  symlinkSync(repo, path.join(repo, 'zz-link-self'));
  symlinkSync(outside, path.join(repo, 'zz-link-out'));
  let kinds;
  for (;;) {
    const root = (await state(p)).nodes[repo];
    kinds = Object.fromEntries(root.entries.filter((e) => e[0].startsWith('zz-link')).map((e) => [e[0], e[1]]));
    if (Object.keys(kinds).length === 3) break;
    if (performance.now() - s > 30_000) throw new Error('ссылки не появились');
    await sleep(5);
  }
  const expandOut = await p.k.run('files.expand', path.join(repo, 'zz-link-out')).then(() => 'раскрыта', (e) => String(e.message).slice(0, 60));
  out.symlinks = { kinds, appearedMs: round(performance.now() - s, 0), expandOutside: expandOut };
  return out;
}

const results = [];
for (const source of repos) {
  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await runOnce(source, i);
    runs.push(r);
    console.error(`${path.basename(source)}: прогон ${i}/${RUNS} готов (нагрузка ${r.load.join(' ')})`);
  }
  results.push({ repo: source, name: path.basename(source), runs });
}
const report = { when: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, cpus: `${cpus().length}x ${cpus()[0]?.model ?? ''}`, runs: RUNS, samples: SAMPLES, idleMs: IDLE_MS, results };
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
