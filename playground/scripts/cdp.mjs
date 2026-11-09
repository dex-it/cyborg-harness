// Запуск собранного playground и разговор с ним по DevTools Protocol: общее для пилотов, которым нужно окно и виды (spike-monaco.mjs).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const repo = resolve(import.meta.dirname, '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(what, probe, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`не дождались: ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

/** Сессия протокола DevTools: страница окна или инспектор главного процесса. */
export async function connect(url, sockets) {
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
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return Object.assign(evaluate, { send });
}

/**
 * Приложение со своим userData. `config` - cyborg.json первого запуска (без него playground пишет свой), `args` - аргументы Electron.
 * Подставной claude из smoke не нужен: сессии открывает агент shell.
 */
export async function launch({ config, args = [] } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'cyborg-pilot-'));
  if (config) {
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, 'cyborg.json'), JSON.stringify(config, null, 2));
  }
  const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  app.stderr.on('data', (d) => (stderr += d));
  const sockets = [];
  // Приложение не должно пережить скрипт ни при отказе подключения, ни при падении самого скрипта.
  const killApp = () => app.kill('SIGKILL');
  process.once('exit', killApp);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(1));
  let ev, main;
  try {
    const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]);
    const page = await waitFor('окно', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    ev = await connect(page.webSocketDebuggerUrl, sockets);
    main = await connect(await waitFor('инспектор главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1]), sockets);
  } catch (error) {
    killApp();
    rmSync(userData, { recursive: true, force: true });
    throw error;
  }
  /** Выражение в документе вида плагина (по origin кадра); кадра нет - null. */
  const inView = (id, expression, match = '') =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://${id}' && f.url.includes(${JSON.stringify(match)}));
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  /** Нажатие мышью в элемент вида: координаты кадра в окне плюс координаты элемента в кадре. */
  const clickIn = async (id, selector, clickCount = 1) => {
    const frame = await ev(`(() => { const r = document.querySelector('.views [data-plugin="${id}"] iframe').getBoundingClientRect(); return [r.left, r.top]; })()`);
    const inner = await inView(id, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const at = { x: frame[0] + inner[0], y: frame[1] + inner[1], button: 'left', clickCount };
    await ev.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await ev.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  };
  /** Фокус на элемент вида программно: на машине, где окно не на переднем плане, щелчок CDP кадр не фокусирует. */
  const focusIn = async (id, selector) => {
    await ev(`document.querySelector('.views [data-plugin="${id}"] iframe').focus()`);
    await main("process.mainModule.require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'window').focus()");
    await inView(id, `document.querySelector(${JSON.stringify(selector)}).focus()`);
  };
  const stop = async () => {
    for (const socket of sockets) socket.close();
    app.kill('SIGTERM');
    await Promise.race([new Promise((r) => app.once('exit', r)), sleep(8000)]);
    if (app.exitCode === null) killApp();
    process.removeListener('exit', killApp);
    rmSync(userData, { recursive: true, force: true });
  };
  return { app, ev, main, inView, clickIn, focusIn, stop, stderr: () => stderr };
}
