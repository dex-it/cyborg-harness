// Дымовой тест собранного playground по DevTools Protocol; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const electronArgs = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (text) => console.log(`smoke: ${text}`);
const userData = mkdtempSync(join(tmpdir(), 'cyborg-playground-smoke-'));

async function waitFor(what, probe, timeout = TIMEOUT_MS) {
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

// --inspect=0 - инспектор главного процесса: нажатие оттуда идёт через before-input-event, как с клавиатуры.
const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...electronArgs], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (d) => (stderr += d));
const sockets = [];

/** Сессия протокола DevTools: страница окна или инспектор главного процесса. */
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
  const send = (method, params) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result)));
      socket.send(JSON.stringify({ id, method, params }));
    });
  return async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
}

async function main() {
  const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1]);
  const page = await waitFor('окно', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
  const ev = await connect(page.webSocketDebuggerUrl);
  const main = await connect(await waitFor('инспектор главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1]));
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const state = (id) => ev(`document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}]')?.dataset.state ?? ''`);
  const button = (id, label) =>
    ev(`(() => {
      const b = [...document.querySelectorAll('#plugins-list [data-plugin=${JSON.stringify(id)}] button')].find((x) => x.textContent === ${JSON.stringify(label)});
      if (b) b.click();
      return !!b;
    })()`);
  const lines = () => stderr.split('\n').filter((l) => l.startsWith('[plugins]'));

  // Как в Electron Accelerator: modifiers - control, shift, meta; клавиша - буква или F1-F24.
  const press = (combo) =>
    main(`(() => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const parts = ${JSON.stringify(combo)}.split('+');
      const keyCode = parts.pop();
      const modifiers = parts.map((m) => ({ Ctrl: 'control', Shift: 'shift', Alt: 'alt', Meta: 'meta' })[m]);
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    })()`);
  const feed = () => ev(`[...document.querySelectorAll('#feed .log-line')].map((l) => l.textContent)`);
  const feedHas = async (pattern) => (await feed()).some((l) => pattern.test(l));
  const pid = (id) => ev(`/pid (\\d+)/.exec(document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}] .plugin-host')?.textContent ?? '')?.[1] ?? ''`);
  const keyRow = (combo) => ev(`(() => { const r = document.querySelector('#keys-list [data-key=${JSON.stringify(combo)}]'); return r ? { live: r.dataset.live, text: r.textContent } : null; })()`);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Ctrl';
  const states = async (expected) => {
    for (const [id, want] of Object.entries(expected)) if ((await state(id)) !== want) return false;
    return true;
  };

  await waitFor('демо-плагины работают, flaky выключен с причиной', async () =>
    (await states({ echo: 'active', chat: 'active', alice: 'active', bob: 'active', flaky: 'stopped' })) &&
    /всегда падает/.test(await text('#plugins-list [data-plugin="flaky"] .plugin-reason')),
  );
  await waitFor('alice и bob подписаны на чат', () => lines().includes('[plugins] chat: подписчиков: 2'));
  const [echoPid, chatPid, bobPid, alicePid] = [await pid('echo'), await pid('chat'), await pid('bob'), await pid('alice')];
  assert.ok(echoPid && chatPid && bobPid, 'у работающих плагинов нет pid хоста');
  assert.equal(alicePid, bobPid, 'alice и bob должны делить хост c');
  assert.equal(new Set([echoPid, chatPid, bobPid]).size, 3, 'хосты a, b, c - разные процессы');
  log('пять плагинов в четырёх хостах utilityProcess');

  const f2 = await keyRow('F2');
  assert.equal(f2?.live, 'true');
  assert.match(f2.text, /bob\.status.*конфликт: echo\.ping \(echo\)/, 'конфликт F2 не показан');
  await press(`${mod}+Shift+A`);
  await waitFor('alice → чат → bob → эхо → чат → alice', () => feedHas(/alice← bob: ответ: привет, bob \(эхо из \d+\)/));
  assert.ok(await feedHas(new RegExp(`${mod}\\+Shift\\+A→ alice\\.hello \\(alice\\)`)), 'перехват сочетания не попал в ленту');
  assert.ok(!(await feedHas(new RegExp(`${mod}\\+Shift\\+Aдо окна дошло`))), 'перехваченное сочетание дошло до страницы');
  await press('F2');
  await waitFor('F2 у bob, а не у echo', () => feedHas(/bobчат есть, эхо есть/));
  await press(`${mod}+Shift+Z`);
  await waitFor('свободное сочетание дошло до окна', () => feedHas(new RegExp(`${mod}\\+Shift\\+Zдо окна дошло`)));
  log('перехват клавиш, конфликт, обмен сообщениями через три хоста');

  assert.equal(await button('chat', 'Выгрузить'), true, 'у chat нет «Выгрузить»');
  await waitFor('chat выгружен, alice снята с ним, bob живёт без чата', async () =>
    (await states({ chat: 'stopped', alice: 'stopped', bob: 'active' })) && lines().includes('[plugins] bob: чат пропал'),
  );
  assert.match(await text('#plugins-list [data-plugin="alice"] .plugin-reason'), /выгружен вместе с chat/);
  assert.equal((await keyRow(`${mod}+Shift+A`))?.live, 'false');
  await press(`${mod}+Shift+A`);
  await waitFor('сочетание выгруженной alice дошло до окна', () => feedHas(new RegExp(`${mod}\\+Shift\\+Aдо окна дошло`)));
  assert.equal(await button('chat', 'Загрузить'), true, 'у выгруженного chat нет «Загрузить»');
  await waitFor('chat и alice вернулись, bob переподписался', async () =>
    (await states({ chat: 'active', alice: 'active' })) && lines().includes('[plugins] bob: чат вернулся, подписываюсь снова'),
  );
  assert.notEqual(await pid('chat'), chatPid, 'после выгрузки chat должен подняться в новом процессе');
  log('выгрузка с зависимыми, загрузка в новый процесс, переподписка');

  const chatPid2 = await pid('chat');
  assert.equal(await button('chat', 'Уронить хост'), true);
  await waitFor('хост b упал и поднялся', async () => /хост b упал/.test(await text('#plugins-journal')) && (await state('chat')) === 'active' && (await pid('chat')) !== chatPid2);
  if (process.platform !== 'win32') {
    assert.equal(await button('echo', 'Повесить хост'), true);
    await waitFor('сторож признал хост a зависшим и перезапустил', async () => /хост a завис/.test(await text('#plugins-journal')) && (await state('echo')) === 'active' && (await pid('echo')) !== echoPid);
  }
  log('падение и зависание хоста: сторож перезапускает');

  assert.equal(await button('flaky', 'Журнал'), true, 'у flaky нет кнопки «Журнал»');
  assert.equal(await text('#plugins-journal-title'), 'Журнал: flaky');
  assert.doesNotMatch(await text('#plugins-journal'), /\bchat\b/, 'журнал flaky показал чужие записи');
  assert.equal(await button('flaky', 'Включить снова'), true, 'у выключенного flaky нет «Включить снова»');
  await waitFor('flaky включён снова', async () => (await state('flaky')) === 'active');
  log('окно: заглушка с причиной, журнал плагина, «Включить снова»');
}

let failed = false;
try {
  await main();
  log('все проверки пройдены');
} catch (error) {
  failed = true;
  console.error(`smoke: ОШИБКА: ${error.stack ?? error}\n${stderr}`);
} finally {
  for (const socket of sockets) socket.close();
  app.kill('SIGTERM');
  await Promise.race([new Promise((r) => app.once('exit', r)), sleep(8000)]);
  if (app.exitCode === null) app.kill('SIGKILL');
  rmSync(userData, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
