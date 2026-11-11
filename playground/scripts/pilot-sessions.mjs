// Пилот PL-01 (#17): сессия агента через sessions и agent-claude-code в настоящем окне playground на подставном claude (fake-claude.mjs) под нагрузкой.
// Живого claude нет: цифры задержки, пропускной способности, памяти и ЦП снимаются на подставном, числа сравниваются с базой Cyborg из PL-09 (docs/05-verification/cyborg-baseline.md).
// Запуск: npm run pilot:sessions [-- --runs=5 --json=<файл> --no-scenarios --no-measure --short]. Электрон берёт общий замок /private/tmp/claude-501/smoke.lock (--no-lock - без него).
// --short пропускает ожидание 65 с в сценарии «хост sessions убит» (проверка, что подхваченная сессия пережила льготный срок 60 с).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const num = (name, fallback) => {
  const raw = argv.find((a) => a.startsWith(`--${name}=`));
  return raw === undefined ? fallback : Number(raw.slice(name.length + 3));
};
const RUNS = num('runs', 5);
const jsonOut = argv.find((a) => a.startsWith('--json='))?.slice(7);
const MEASURE = !argv.includes('--no-measure');
const SCENARIOS = !argv.includes('--no-scenarios');
const SHORT = argv.includes('--short');
const CLOSE_ONLY = argv.includes('--only-close');
const LOCK = '/private/tmp/claude-501/smoke.lock';
const FLOOD_LINES = 50_000;
const FLOOD_WIDTH = 100;
const MEM_LINES = 20_000;
const PROBES = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const median = (xs) => pct(xs, 50);

async function waitFor(what, probe, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      // Выражение во фрейме, который перезагружается, может не ответить никогда: каждая проба ограничена.
      last = await Promise.race([probe(), sleep(8000).then(() => { throw new Error('проба не ответила за 8 с'); })]);
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`не дождались: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

// --- замок на тяжёлые прогоны Electron: рядом работают другие агенты ---
let locked = false;
async function takeLock() {
  if (argv.includes('--no-lock')) return;
  while (!locked) {
    try {
      mkdirSync(LOCK);
      locked = true;
    } catch {
      await sleep(5000);
    }
  }
}
const release_ = () => {
  if (locked) rmSync(LOCK, { recursive: true, force: true });
  locked = false;
};
process.on('exit', release_);

// --- подставной claude в PATH оболочки входа, как в smoke ---
const work = mkdtempSync(join(tmpdir(), 'cyborg-pilot-sessions-'));
const fakeBin = join(work, 'fake-bin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${join(repo, 'playground', 'scripts', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
writeFileSync(join(fakeBin, 'login-shell'), `#!/bin/sh\nPATH='${fakeBin}':"$PATH"; export PATH\nif [ "$1" = -lc ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n`, { mode: 0o755 });

/** Сессия протокола DevTools: страница окна или инспектор главного процесса. */
async function connect(url, sockets) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((r, j) => {
    socket.onopen = r;
    socket.onerror = () => j(new Error(`нет соединения с ${url}`));
  });
  let seq = 0;
  const pending = new Map();
  socket.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
  };
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    // Выражение во фрейме, который перезагружается, не отвечает никогда: без предела скрипт висит.
    const result = await Promise.race([send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), sleep(25_000).then(() => { throw new Error(`нет ответа за 25 с: ${expression.slice(0, 160)}`); })]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return Object.assign(evaluate, { send });
}

/** Страница вида в окне перед измерением: свои слушатели на терминал и на экран xterm. Живёт, пока жив документ вида. */
const INSTALL = `(() => {
  if (window.__pl) return 'есть';
  const bridge = window.cyborgView;
  const pl = (window.__pl = { tid: undefined, chunks: 0, bytes: 0, keep: false, kept: '', tail: '', waiters: [], exits: [], lastAt: 0, firstAt: 0 });
  bridge.onTerminal((e) => {
    const now = performance.now();
    if ('exit' in e) {
      pl.exits.push({ at: now, exit: e.exit });
      return;
    }
    pl.tid ??= e.tid;
    // Старый терминал того же pty может ещё жить: считается только текущий.
    if (e.tid !== pl.tid) return;
    pl.chunks++;
    pl.bytes += e.data.length;
    if (pl.firstAt === 0) pl.firstAt = now;
    pl.lastAt = now;
    if (pl.keep) pl.kept += e.data;
    // Маркер может лежать на границе двух кусков.
    const window_ = pl.tail + e.data;
    pl.tail = window_.slice(-64);
    for (const w of pl.waiters.splice(0)) if (window_.includes(w.marker)) w.resolve(now); else pl.waiters.push(w);
  });
  const rows = () => document.querySelector('#screen .xterm-rows');
  const screen = () => [...(rows()?.children ?? [])].map((d) => d.textContent).join('\\n');
  pl.screen = screen;
  pl.chunkAt = (marker) => new Promise((resolve) => pl.waiters.push({ marker, resolve }));
  pl.domAt = (marker) =>
    new Promise((resolve) => {
      if (screen().includes(marker)) return resolve(performance.now());
      const observer = new MutationObserver(() => {
        if (!screen().includes(marker)) return;
        observer.disconnect();
        resolve(performance.now());
      });
      observer.observe(rows(), { subtree: true, childList: true, characterData: true });
    });
  pl.reset = () => {
    pl.chunks = 0;
    pl.bytes = 0;
    pl.kept = '';
    pl.firstAt = 0;
    pl.lastAt = 0;
  };
  // Дрейф таймера 5 мс: самая длинная блокировка потока страницы вида.
  pl.drift = () => {
    let max = 0;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      max = Math.max(max, now - last - 5);
      last = now;
    }, 5);
    return () => (clearInterval(id), max);
  };
  return 'поставлено';
})()`;

/** Эхо: ключ уходит в pty через мост вида, считаются время до куска вывода и до строки на экране. */
const ECHO = (n) => `(async () => {
  const pl = window.__pl;
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const out = [];
  for (let i = 0; i < ${n}; i++) {
    const marker = 'got: [' + alphabet[i % alphabet.length] + ']';
    const chunk = pl.chunkAt(marker);
    const dom = pl.domAt(marker);
    const t0 = performance.now();
    const reply = await window.cyborgView.terminalWrite(pl.tid, alphabet[i % alphabet.length]);
    const ack = performance.now();
    const [c, d] = await Promise.race([Promise.all([chunk, dom]), new Promise((r) => setTimeout(() => r([NaN, NaN]), 2000))]);
    out.push({ ack: ack - t0, chunk: c - t0, dom: d - t0, error: reply?.error });
    await new Promise((r) => setTimeout(r, 40 + (i % 7) * 5));
  }
  return out;
})()`;

/** Вывод: команда flood, время первого и последнего куска, строки на экране, дрейф таймера. */
const FLOOD = (lines, width) => `(async () => {
  const pl = window.__pl;
  pl.reset();
  const marker = 'END-${lines}';
  const last = pl.chunkAt(marker);
  const dom = pl.domAt(marker);
  const stop = pl.drift();
  const t0 = performance.now();
  await window.cyborgView.terminalWrite(pl.tid, 'flood ${lines} ${width}\\r');
  const lastChunk = await Promise.race([last, new Promise((r) => setTimeout(() => r(NaN), 120000))]);
  const onScreen = await Promise.race([dom, new Promise((r) => setTimeout(() => r(NaN), 120000))]);
  return { first: pl.firstAt - t0, lastChunk: lastChunk - t0, dom: onScreen - t0, lag: onScreen - lastChunk, chunks: pl.chunks, bytes: pl.bytes, span: pl.lastAt - pl.firstAt, drift: stop() };
})()`;

async function startApp() {
  const userData = mkdtempSync(join(work, 'user-'));
  const extra = ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
  const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...extra], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, SHELL: join(fakeBin, 'login-shell') },
    detached: true,
  });
  let stderr = '';
  app.stderr.on('data', (d) => (stderr += d));
  const sockets = [];
  const started = Date.now();
  const killGroup = () => {
    try {
      process.kill(-app.pid, 'SIGKILL');
    } catch {
      // Группы уже нет.
    }
  };
  process.once('exit', killGroup);
  const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]);
  const page = await waitFor('окно', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
  const ev = await connect(page.webSocketDebuggerUrl, sockets);
  const main = await connect(await waitFor('инспектор главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1]), sockets);
  const inView = (id, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.url.startsWith('cyborg-plugin://') && new URL(f.url).pathname.split('/')[1] === '${id}');
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  const sess = (expression) => inView('sessions', expression);
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const stop = async () => {
    for (const s of sockets) s.close();
    killGroup();
    await sleep(300);
    rmSync(userData, { recursive: true, force: true });
  };
  await waitFor('вид sessions и кнопка claude-code', async () => (await sess("document.querySelector('#agents cy-button[data-agent=\"claude-code\"]')?.disabled")) === false);
  return { app, ev, main, sess, text, stop, started, stderr: () => stderr, killGroup };
}

// --- память и ЦП: footprint процесса (как в базе PL-09) и счётчики Electron ---
const footprintMib = (pid) => {
  try {
    const out = execFileSync('footprint', ['-p', String(pid), '--format', 'bytes'], { encoding: 'utf8', timeout: 20_000 });
    const bytes = /Footprint:\s+(\d+) B/.exec(out)?.[1];
    return bytes === undefined ? undefined : Number(bytes) / 1048576;
  } catch {
    return undefined;
  }
};
const descendants = (root) => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] }));
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const r of rows) if (r.ppid === parent) (out.push(r), queue.push(r.pid));
  }
  return out;
};
const METRICS = "(() => { const { app } = process.mainModule.require('electron'); return app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? '', cpu: m.cpu.cumulativeCPUUsage })); })()";
const FRAMES = `(() => {
  const { webContents } = process.mainModule.require('electron');
  const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
  const sessions = page.mainFrame.framesInSubtree.find((f) => f.url.startsWith('cyborg-plugin://') && new URL(f.url).pathname.split('/')[1] === 'sessions');
  return { window: page.mainFrame.osProcessId, sessions: sessions?.osProcessId };
})()`;

async function memory(app) {
  const metrics = await app.main(METRICS);
  const frames = await app.main(FRAMES);
  const mainPid = app.app.pid;
  const mib = (pid) => footprintMib(pid) ?? 0;
  const ptyHost = metrics.find((m) => m.name === 'Cyborg pty');
  const family = descendants(mainPid);
  const all = [mainPid, ...family.map((r) => r.pid)];
  const total = all.reduce((sum, pid) => sum + mib(pid), 0);
  const sessionProcess = family.find((r) => /node|fake-claude|sh$/.test(r.comm) && r.ppid === ptyHost?.pid);
  const hosts = metrics.filter((m) => m.type === 'Utility' && m.name !== 'Cyborg pty' && m.name !== 'Network Service');
  return {
    main: mib(mainPid),
    window: mib(frames.window),
    sessionsView: frames.sessions === frames.window ? undefined : mib(frames.sessions),
    ptyHost: ptyHost ? mib(ptyHost.pid) : undefined,
    hosts: hosts.reduce((sum, h) => sum + mib(h.pid), 0),
    hostCount: hosts.length,
    session: sessionProcess ? mib(sessionProcess.pid) : undefined,
    all: total,
  };
}
const cpuNow = async (app) => {
  const own = await app.main('process.cpuUsage()');
  const metrics = await app.main(METRICS);
  const sum = (pred) => metrics.filter(pred).reduce((s, m) => s + m.cpu, 0);
  return { at: performance.now(), main: (own.user + own.system) / 1e6, ptyHost: sum((m) => m.name === 'Cyborg pty'), renderers: sum((m) => m.type === 'Tab'), all: sum(() => true) };
};

async function openSession(app) {
  await app.sess(INSTALL);
  const clicked = performance.now();
  await app.sess("document.querySelector('#agents cy-button[data-agent=\"claude-code\"]').click()");
  const ready = await waitFor('приветствие подставного claude', async () => /fake claude: готов/.test(await app.sess('window.__pl.screen()')));
  void ready;
  const greeted = performance.now();
  await waitFor('терминал сессии открыт', async () => (await app.sess('window.__pl.tid')) !== undefined);
  return greeted - clicked;
}
const keys = (app, data) => app.sess(`window.cyborgView.terminalWrite(window.__pl.tid, ${JSON.stringify(data)})`);
const screenOf = (app) => app.sess('window.__pl.screen()');

// --- серия замеров: запуск на прогон, память в трёх точках, эхо, вывод ---
async function measureRun(index) {
  const app = await startApp();
  try {
    const cold = Date.now() - app.started;
    await sleep(3000);
    const idle = await memory(app);
    const toGreeting = await openSession(app);
    await keys(app, 'raw\r');
    await waitFor('режим клавиш', async () => /fake claude: клавиши/.test(await screenOf(app)));
    await sleep(3000);
    const oneSession = await memory(app);
    const echo = await app.sess(ECHO(PROBES));
    // Вывод для памяти: 20 000 строк, как в базе.
    const before = await cpuNow(app);
    const mem = await app.sess(FLOOD(MEM_LINES, FLOOD_WIDTH));
    const afterMem = await cpuNow(app);
    await sleep(3000);
    const afterLines = await memory(app);
    // Вывод для пропускной способности: 50 000 строк, как в базе.
    const cpu0 = await cpuNow(app);
    const flood = await app.sess(FLOOD(FLOOD_LINES, FLOOD_WIDTH));
    const cpu1 = await cpuNow(app);
    const wall = cpu1.at - cpu0.at;
    const result = {
      run: index,
      coldStartMs: cold,
      toGreetingMs: toGreeting,
      echo: { ack: echo.map((e) => e.ack), chunk: echo.map((e) => e.chunk), dom: echo.map((e) => e.dom), lost: echo.filter((e) => Number.isNaN(e.dom)).length, errors: echo.filter((e) => e.error).length },
      memory: { idle, oneSession, afterLines },
      flood: { ...flood, throughputMBs: flood.bytes / 1048576 / (flood.span / 1000), toScreenMBs: flood.bytes / 1048576 / (flood.dom / 1000), memLines: mem },
      cpu: { windowMs: wall, mainPct: ((cpu1.main - cpu0.main) / (wall / 1000)) * 100, ptyHostPct: ((cpu1.ptyHost - cpu0.ptyHost) / (wall / 1000)) * 100, renderersPct: ((cpu1.renderers - cpu0.renderers) / (wall / 1000)) * 100, memPhaseMainSec: afterMem.main - before.main },
      load: loadavg(),
    };
    return result;
  } finally {
    await app.stop();
  }
}

// --- сценарии: пределы, размеры, скрытый вид, перезагрузка окна, перезапуск хоста, убийство pty-хоста, закрытие окна ---
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'ok     ' : 'ПРОВАЛ '} ${name}${detail === undefined ? '' : ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

/** Нумерованные строки `[000123]` подряд, без дыр и повторов. */
const gaps = (text) => {
  const numbers = (text.match(/\[(\d{6})\]/g) ?? []).map((m) => Number(m.slice(1, -1)));
  let holes = 0;
  let repeats = 0;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] === numbers[i - 1]) repeats++;
    else if (numbers[i] < numbers[i - 1]) repeats++;
    else if (numbers[i] !== numbers[i - 1] + 1) holes += numbers[i] - numbers[i - 1] - 1;
  }
  return { count: numbers.length, first: numbers[0], last: numbers.at(-1), holes, repeats };
};

async function reopenAndRead(app, quietMs) {
  // Программно, как это делает вид: билет от sessions.reopen, терминал по билету, хвост и продолжение.
  await app.sess(INSTALL);
  return app.sess(`(async () => {
    const bridge = window.cyborgView;
    if (window.__pl.tid !== undefined) bridge.terminalClose(window.__pl.tid);
    window.__pl.tid = undefined;
    window.__pl.keep = true;
    window.__pl.reset();
    const running = (await bridge.run('sessions.running', [])).value;
    const ticket = (await bridge.run('sessions.reopen', [running[0].id])).value;
    const opened = (await bridge.terminalOpen(ticket)).value;
    window.__pl.tid = opened.tid;
    await new Promise((r) => setTimeout(r, ${quietMs}));
    return { running, backlog: opened.backlog, live: window.__pl.kept, pid: opened.pid };
  })()`);
}

async function scenarios() {
  const app = await startApp();
  const sessions = (id) => `document.querySelector('#plugins-list [data-plugin="${id}"]')`;
  try {
    await openSession(app);
    check('сессия claude запущена в окне через sessions и agent-claude-code', /fake claude: готов/.test(await screenOf(app)));
    await app.sess(INSTALL);
    steps: {
    if (CLOSE_ONLY) break steps;
    // Ввод с экрана: настоящая клавиатура через CDP.
    await app.sess("document.querySelector('#screen .xterm-helper-textarea').focus()");
    await keys(app, 'raw\r');
    await waitFor('режим клавиш', async () => /fake claude: клавиши/.test(await screenOf(app)));
    await app.ev.send('Input.insertText', { text: 'q' });
    check('ввод с клавиатуры окна доходит до pty и эхо возвращается на экран', await waitFor('эхо клавиши', async () => /got: \[q\]/.test(await screenOf(app)), 5000).catch(() => false));

    // 1. Пределы ввода и размера вживую (через порт вида в pty-хост).
    const MIB = 1048576;
    await keys(app, 'sink\r');
    const exact = await app.sess(`window.cyborgView.terminalWrite(window.__pl.tid, 'x'.repeat(${MIB}))`);
    await waitFor('sink принял 1 МиБ', async () => /sunk: 1048576/.test(await screenOf(app)), 20_000).catch(() => undefined);
    check('ввод ровно 1 МиБ принят pty (программа насчитала 1048576 байт)', /sunk: 1048576/.test(await screenOf(app)) && exact?.error === undefined, exact);
    const over = await app.sess(`window.cyborgView.terminalWrite(window.__pl.tid, 'x'.repeat(${MIB + 1}))`);
    check('ввод 1 МиБ + 1 символ отклонён мостом вида (длина)', /больше 1048576/.test(over?.error ?? ''), over);
    const overBytes = await app.sess(`window.cyborgView.terminalWrite(window.__pl.tid, 'я'.repeat(${MIB / 2 + 1}))`);
    check('ввод 1 МиБ + 2 байта (524289 двухбайтных знаков) отклонён pty-хостом по байтам', /больше 1048576/.test(overBytes?.error ?? ''), overBytes);
    const afterOver = await app.sess(`window.cyborgView.terminalWrite(window.__pl.tid, 'x'.repeat(10))`);
    check('после отказа pty жив и принимает ввод', afterOver?.error === undefined, afterOver);
    await sleep(500);
    const resize = (cols, rows) => app.sess(`window.cyborgView.terminalResize(window.__pl.tid, ${cols}, ${rows})`);
    for (const [cols, rows] of [[1, 1], [1000, 1000], [1000, 1], [1, 1000], [120, 32]]) check(`размер ${cols}x${rows} принят`, (await resize(cols, rows))?.error === undefined);
    for (const [cols, rows] of [[0, 24], [1001, 24], [80, 0], [80, 1001], [1.5, 24]]) check(`размер ${cols}x${rows} отклонён`, /целые 1\.\.1000/.test((await resize(cols, rows))?.error ?? ''));
    await keys(app, 'size\r');
    await waitFor('ответ size', async () => /size: 120x32/.test(await screenOf(app)), 5000).catch(() => undefined);
    const sized = await screenOf(app);
    check('pty после отказов остался 120x32 (программа назвала свой размер)', /size: 120x32/.test(sized), sized.split('\n').filter((l) => /size:/.test(l)).join(' | '));

    // 2. Быстрое изменение размера: 400 запросов подряд без ожидания, затем окно.
    const burst = await app.sess(`(async () => {
      const sizes = [[1, 1], [1000, 1000], [80, 24], [500, 3], [3, 500], [200, 50]];
      const replies = await Promise.all(Array.from({ length: 400 }, (_, i) => window.cyborgView.terminalResize(window.__pl.tid, ...sizes[i % sizes.length])));
      const last = await window.cyborgView.terminalResize(window.__pl.tid, 100, 30);
      return { errors: replies.filter((r) => r?.error).length, last };
    })()`);
    await keys(app, 'size\r');
    await waitFor('ответ size после серии', async () => /size: 100x30/.test(await screenOf(app)), 5000).catch(() => undefined);
    check('400 запросов размера подряд: ошибок нет, итоговый размер 100x30 дошёл до программы', burst.errors === 0 && /size: 100x30/.test(await screenOf(app)), burst);
    for (let i = 0; i < 30; i++) {
      await app.main(`(() => { const { BrowserWindow } = process.mainModule.require('electron'); const w = BrowserWindow.getAllWindows()[0]; const [x, y] = w.getSize(); w.setSize(${i % 2 === 0 ? 700 : 1280}, ${i % 3 === 0 ? 500 : 800}); })()`);
      await sleep(30);
    }
    await sleep(700);
    await keys(app, 'size\r');
    const shownRows = await app.sess("document.querySelectorAll('#screen .xterm-rows > div').length");
    await waitFor('ответ size после окна', async () => new RegExp(`size: \\d+x${shownRows}`).test(await screenOf(app)), 5000).catch(() => undefined);
    check('30 смен размера окна подряд: размер pty совпал с экраном вида', new RegExp(`size: \\d+x${shownRows}\\b`).test((await screenOf(app)).split('\n').slice(-80).join('\n')), `${shownRows} строк на экране`);
    await app.main("(() => { const { BrowserWindow } = process.mainModule.require('electron'); BrowserWindow.getAllWindows()[0].setSize(1280, 800); })()");

    // 3. Скрытый вид не теряет вывод и догоняет.
    await app.ev("document.querySelector('.views [data-plugin=\"sessions\"] iframe').style.display = 'none'");
    const hidden = await app.sess(`(async () => {
      const pl = window.__pl;
      pl.reset();
      pl.keep = true;
      const marker = 'END-${MEM_LINES}';
      const last = pl.chunkAt(marker);
      await window.cyborgView.terminalWrite(pl.tid, 'flood ${MEM_LINES} ${FLOOD_WIDTH}\\r');
      await last;
      // Строка с маркером может закончиться в следующем куске.
      await new Promise((r) => setTimeout(r, 300));
      pl.keep = false;
      const numbers = [...pl.kept.matchAll(/\\x1b\\[3\\dm(?:L(\\d+)|END-(\\d+))x+/g)].map((m) => (m[1] === undefined ? ${MEM_LINES - 1} : Number(m[1])));
      let holes = 0;
      let repeats = 0;
      for (let i = 1; i < numbers.length; i++) {
        if (numbers[i] <= numbers[i - 1]) repeats++;
        else holes += numbers[i] - numbers[i - 1] - 1;
      }
      pl.kept = '';
      return { chunks: pl.chunks, bytes: pl.bytes, lines: numbers.length, holes, repeats };
    })()`);
    const shownAt = Date.now();
    await app.ev("document.querySelector('.views [data-plugin=\"sessions\"] iframe').style.display = ''");
    const caught = await waitFor('экран догнал вывод после показа', async () => /END-20000/.test(await screenOf(app)), 30_000).then(() => Date.now() - shownAt).catch(() => NaN);
    check('скрытый вид получил все 20 000 строк потока по порядку, без дыр и повторов', hidden.lines === MEM_LINES && hidden.holes === 0 && hidden.repeats === 0, hidden);
    check('показанный вид догнал экран', Number.isFinite(caught), `${caught} мс до последней строки на экране после показа`);

    // 4. Перезагрузка окна при идущем потоке: новая страница берёт хвост через reopen и продолжает без дыр и повторов.
    await keys(app, 'tick 5\r');
    await sleep(1500);
    const beforeReload = gaps(await app.sess('(() => { const t = window.__pl.screen(); return t; })()'));
    await app.ev.send('Page.reload');
    await waitFor('вид sessions после перезагрузки окна', async () => (await app.sess("document.querySelector('#agents cy-button[data-agent=\"claude-code\"]')?.disabled")) === false);
    await sleep(500);
    const reopened = await reopenAndRead(app, 2000);
    const seen = gaps(reopened.backlog + reopened.live);
    check('перезагрузка окна под потоком: хвост + продолжение без дыр и повторов', seen.holes === 0 && seen.repeats === 0 && seen.count > 100, { ...seen, backlogChars: reopened.backlog.length });
    check('новое окно продолжило с места, не раньше старого экрана', (seen.last ?? 0) >= (beforeReload.last ?? 0), { before: beforeReload.last, after: seen.last });
    const list = await app.sess("[...document.querySelectorAll('#previous cy-list, #previous')].length");
    void list;

    // 5. Перезапуск хоста sessions при живом pty и идущем потоке.
    const hostPid = Number(await app.ev(`/pid (\\d+)/.exec(${sessions('sessions')}?.querySelector('.plugin-host')?.textContent ?? '')?.[1] ?? 0`));
    const sessionPid = reopened.pid;
    const killedAt = Date.now();
    process.kill(hostPid, 'SIGKILL');
    await waitFor('хост sessions перезапущен', () => app.ev(`(() => { const r = ${sessions('sessions')}; const p = /pid (\\d+)/.exec(r?.querySelector('.plugin-host')?.textContent ?? '')?.[1]; return r?.dataset.state === 'active' && p !== undefined && p !== '${hostPid}'; })()`), 30_000);
    const restartMs = Date.now() - killedAt;
    await sleep(500);
    const adopted = await reopenAndRead(app, 2000);
    const afterHost = gaps(adopted.backlog + adopted.live);
    check('перезапуск хоста sessions: процесс сессии жив и тот же, плагин подхватил его (sessions.running)', adopted.running.length === 1 && adopted.pid === sessionPid, { restartMs, pid: adopted.pid });
    check('перезапуск хоста sessions при потоке: хвост + продолжение без дыр и повторов', afterHost.holes === 0 && afterHost.repeats === 0 && afterHost.count > 100, { ...afterHost, backlogChars: adopted.backlog.length });
    check('процесс сессии не завершён ядром после перезапуска хоста', (() => { try { process.kill(sessionPid, 0); return true; } catch { return false; } })());
    if (!SHORT) {
      await sleep(65_000);
      check('через 65 с (льготный срок ядра 60 с) подхваченная сессия жива, записи pty-expired нет', (() => { try { process.kill(sessionPid, 0); return true; } catch { return false; } })() && !/pty-expired|не подхватил/.test(await app.text('#plugins-journal')));
    }
    // Вкладка открывается из списка «идёт» руками, как это сделает человек.
    await app.ev.send('Page.reload');
    await waitFor('вид sessions после второй перезагрузки', async () => (await app.sess("document.querySelector('#agents cy-button[data-agent=\"claude-code\"]')?.disabled")) === false);
    const row = await waitFor('строка «идёт» в списке сессий', () => app.sess("[...document.querySelectorAll('#previous cy-list')].length >= 0 && document.getElementById('previous') && !document.getElementById('previous').hidden ? (document.getElementById('previous').items ?? []).map((r) => r.detail + ':' + r.id).join(',') : ''"), 10_000).catch(() => '');
    check('после перезагрузки окна идущая сессия видна в списке со словом «идёт»', /^идёт:/.test(row), row);
    await app.sess(INSTALL);
    await app.sess("document.getElementById('previous').dispatchEvent(new CustomEvent('cy-activate', { detail: { id: document.getElementById('previous').items[0].id } }))");
    const filled = await waitFor('экран заполнился потоком по кнопке «идёт»', async () => /\[\d{6}\]/.test(await screenOf(app)), 15_000).catch(async (e) => `${e.message}; состояние: ${await app.sess("document.getElementById('session-state').textContent").catch((x) => x.message)}`);
    check('открытие идущей сессии из списка показывает поток на экране', filled === true, filled);
    await keys(app, 'stop\r');

    // 6. Убийство pty-хоста под потоком: владельцы получают выход, окно живо, новая сессия работает.
    await keys(app, 'tick 5\r');
    await sleep(500);
    const ptyHostPid = Number(await app.main("process.mainModule.require('electron').app.getAppMetrics().find((m) => m.name === 'Cyborg pty')?.pid ?? 0"));
    const t0 = Date.now();
    process.kill(ptyHostPid, 'SIGKILL');
    const responsive = await app.ev('1 + 1');
    await waitFor('pty-хост перезапущен', async () => /pty-хост перезапущен/.test(await app.text('#plugins-journal')) && Number(await app.main("process.mainModule.require('electron').app.getAppMetrics().find((m) => m.name === 'Cyborg pty')?.pid ?? 0")) !== ptyHostPid, 30_000);
    const ptyRestartMs = Date.now() - t0;
    check('убийство pty-хоста: окно отвечает сразу, хост поднят заново', responsive === 2, { ptyRestartMs });
    await waitFor('вид получил конец потерянного pty', async () => /вышла с -1/.test(await app.text('#plugins-journal') + await app.sess("document.getElementById('session-state').textContent")), 10_000).catch(() => undefined);
    check('вид сообщает о выходе потерянной сессии (код -1)', /вышла с -1/.test((await app.sess("document.getElementById('session-state').textContent")) ?? ''), await app.sess("document.getElementById('session-state').textContent"));
    await app.sess(INSTALL).catch(() => undefined);
    await app.sess("window.__pl && (window.__pl.tid = undefined, window.__pl.tail = '')");
    await app.sess("document.querySelector('#agents cy-button[data-agent=\"claude-code\"]').click()");
    await waitFor('новая сессия после перезапуска pty-хоста', async () => (await app.sess('window.__pl.tid')) !== undefined && /fake claude: готов/.test(await screenOf(app)), 15_000);
    check('новая сессия на перезапущенном pty-хосте стартует и отвечает', true);

    }
    // 7. Закрытие окна с живой сессией: приложение завершается, процесс сессии не остаётся.
    await keys(app, 'raw\r');
    await sleep(300);
    const ptyHost = Number(await app.main("process.mainModule.require('electron').app.getAppMetrics().find((m) => m.name === 'Cyborg pty')?.pid ?? 0"));
    const fakePids = descendants(ptyHost).map((r) => r.pid);
    const closedAt = Date.now();
    await app.main("(() => { const { BrowserWindow } = process.mainModule.require('electron'); BrowserWindow.getAllWindows()[0].close(); })()").catch(() => undefined);
    // С --inspect Node перед выходом ждёт отключения отладчика: конец работы приложения - эта строка в stderr, а не выход процесса.
    const exited = await waitFor('приложение завершило работу после закрытия окна', () => /Waiting for the debugger to disconnect/.test(app.stderr()) || app.app.exitCode !== null, 30_000).then(() => Date.now() - closedAt).catch(() => NaN);
    await sleep(1500);
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const survivors = fakePids.filter(alive);
    check('закрытие окна с живой сессией: приложение вышло, процессов сессии не осталось', Number.isFinite(exited) && survivors.length === 0, { exitedMs: exited, watched: fakePids.length, survivors, ...(Number.isFinite(exited) ? {} : { windows: await app.main("process.mainModule.require('electron').BrowserWindow.getAllWindows().length").catch((e) => e.message), journal: (await app.text('#plugins-journal').catch(() => '')).slice(-400), stderr: app.stderr().slice(-600) }) });
  } finally {
    await app.stop();
  }
}

// --- вывод ---
const stat = (runs, pick) => {
  const xs = runs.map(pick).filter(Number.isFinite);
  return { median: round(median(xs), 2), min: round(Math.min(...xs), 2), max: round(Math.max(...xs), 2) };
};
function summarize(runs) {
  const flat = (pick) => runs.flatMap(pick).filter(Number.isFinite);
  const echo = (key) => ({ p50: round(median(flat((r) => r.echo[key])), 2), p95: round(pct(flat((r) => r.echo[key]), 95), 2) });
  const mem = (state, key) => stat(runs, (r) => r.memory[state][key]);
  return {
    runs: runs.length,
    coldStartMs: stat(runs, (r) => r.coldStartMs),
    toGreetingMs: stat(runs, (r) => r.toGreetingMs),
    echoAck: echo('ack'),
    echoChunk: echo('chunk'),
    echoDom: { ...echo('dom'), perRunP50: stat(runs, (r) => median(r.echo.dom.filter(Number.isFinite))), perRunP95: stat(runs, (r) => pct(r.echo.dom.filter(Number.isFinite), 95)) },
    echoLost: runs.reduce((s, r) => s + r.echo.lost, 0),
    floodToScreenMs: stat(runs, (r) => r.flood.dom),
    floodThroughputMBs: stat(runs, (r) => r.flood.throughputMBs),
    floodToScreenMBs: stat(runs, (r) => r.flood.toScreenMBs),
    floodLagMs: stat(runs, (r) => r.flood.lag),
    floodChunks: stat(runs, (r) => r.flood.chunks),
    floodBytes: stat(runs, (r) => r.flood.bytes),
    floodDriftMs: stat(runs, (r) => r.flood.drift),
    cpuMainPct: stat(runs, (r) => r.cpu.mainPct),
    cpuPtyHostPct: stat(runs, (r) => r.cpu.ptyHostPct),
    cpuRenderersPct: stat(runs, (r) => r.cpu.renderersPct),
    memory: Object.fromEntries(['idle', 'oneSession', 'afterLines'].map((state) => [state, Object.fromEntries(['main', 'window', 'sessionsView', 'ptyHost', 'hosts', 'session', 'all'].map((key) => [key, mem(state, key)]))])),
  };
}

try {
  await takeLock();
  const env = { platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, cores: cpus().length, node: process.version, electron: JSON.parse(execFileSync(join(repo, 'node_modules', '.bin', 'electron'), ['--version'], { encoding: 'utf8' }).replace(/^v/, '"').trim() + '"'), load: loadavg() };
  const out = { env, at: new Date().toISOString() };
  if (MEASURE) {
    const runs = [];
    for (let i = 1; i <= RUNS; i++) {
      const r = await measureRun(i);
      console.log(`прогон ${i}/${RUNS}: эхо до экрана p50 ${round(median(r.echo.dom.filter(Number.isFinite)), 1)} мс, 50 000 строк до экрана ${round(r.flood.dom, 0)} мс, отставание экрана ${round(r.flood.lag, 1)} мс, ${round(r.flood.throughputMBs, 1)} МБ/с, нагрузка ${r.load.map((n) => round(n, 1)).join(' ')}`);
      runs.push(r);
      await sleep(1000);
    }
    out.runs = runs;
    out.summary = summarize(runs);
  }
  if (SCENARIOS) {
    await scenarios();
    out.checks = checks;
  }
  console.log(JSON.stringify(out.summary ?? {}, null, 2));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`pilot-sessions: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  release_();
  rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
