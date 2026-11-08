// Замер потока pty до вида (K-01): 4 МиБ из настоящего /bin/sh в окне playground до моста вида `window.cyborgView`.
// Мост один и тот же до и после переноса pty в pty-хост, поэтому скрипт мерит оба устройства одним кодом: `npm run spike:pty-stream`.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 5);
const json = process.argv.includes('--json');
const electronArgs = process.argv.slice(2).filter((a) => !a.startsWith('--runs=') && a !== '--json');
const SIZE = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = mkdtempSync(join(tmpdir(), 'cyborg-pty-stream-'));
const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
app.stderr.on('data', (d) => (stderr += d));
const sockets = [];

async function waitFor(what, probe, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // Окно ещё поднимается.
    }
    await sleep(150);
  }
  throw new Error(`не дождались: ${what}`);
}

async function connect(url) {
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
  return async (expression) => {
    const result = await new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
}

// Во фрейме вида echo: свой терминал на общем pty, считаем символы `Q` вывода и время от первого куска до последнего.
const MEASURE = `(async () => {
  const bridge = window.cyborgView;
  const ticket = (await bridge.run('echo.terminal', [])).value;
  const opened = (await bridge.terminalOpen(ticket)).value;
  const tid = opened.tid;
  let seen = 0;
  let first = 0;
  let messages = 0;
  let done;
  const finished = new Promise((r) => (done = r));
  const started = performance.now();
  bridge.onTerminal((event) => {
    if (event.tid !== tid || !('data' in event)) return;
    const q = event.data.split('Q').length - 1;
    if (q === 0) return;
    if (first === 0) first = performance.now();
    messages++;
    seen += q;
    if (seen >= ${SIZE} + 1) done(performance.now());
  });
  await bridge.terminalWrite(tid, "dd if=/dev/zero bs=1048576 count=4 2>/dev/null | tr '\\\\0' 'Q'\\r");
  const last = await Promise.race([finished, new Promise((r) => setTimeout(() => r(0), 60000))]);
  bridge.terminalClose(tid);
  return { total: last - started, stream: last - first, messages, seen };
})()`;

async function main() {
  const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]);
  await waitFor('окно', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
  const main = await connect(await waitFor('инспектор главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1]));
  const inEcho = (expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://echo');
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  await waitFor('вид echo открыл терминал', async () => /^pty \d+$/.test(await inEcho("document.getElementById('term-state').textContent")));
  const results = [];
  for (let i = 0; i < runs + 1; i++) {
    const r = await inEcho(MEASURE);
    if (!r || r.seen < SIZE) throw new Error(`поток не дошёл: ${JSON.stringify(r)}`);
    // Первый прогон разогревочный.
    if (i > 0) results.push(r);
    await sleep(500);
  }
  const med = (xs) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = { runs: results.length, medianStreamMs: +med(results.map((r) => r.stream)).toFixed(1), medianTotalMs: +med(results.map((r) => r.total)).toFixed(1), medianMessages: med(results.map((r) => r.messages)), streamMs: results.map((r) => +r.stream.toFixed(1)) };
  const env = { platform: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, node: process.version };
  console.log(json ? JSON.stringify({ env, ...summary }) : `${JSON.stringify(env)}\n4 МиБ до моста вида: поток ${summary.medianStreamMs} мс (медиана ${summary.runs} прогонов), с командой ${summary.medianTotalMs} мс, сообщений ${summary.medianMessages}; прогоны: ${summary.streamMs.join(', ')}`);
}

try {
  await main();
} finally {
  for (const s of sockets) s.close();
  app.kill('SIGKILL');
  await sleep(300);
  rmSync(userData, { recursive: true, force: true });
  // Трубы потомка держат цикл событий: без явного выхода скрипт висит после замера.
  process.exit(process.exitCode ?? 0);
}
