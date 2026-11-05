// Дымовой тест собранного playground по DevTools Protocol; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const press = (keys) =>
    main(`(() => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const parts = ${JSON.stringify(keys)}.split('+');
      const keyCode = parts.pop();
      const modifiers = parts.map((m) => ({ Ctrl: 'control', Shift: 'shift', Alt: 'alt', Meta: 'meta' })[m]);
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    })()`);
  const feed = () => ev(`[...document.querySelectorAll('#feed .log-line')].map((l) => l.textContent)`);
  const feedHas = async (pattern) => (await feed()).some((l) => pattern.test(l));
  const pid = (id) => ev(`/pid (\\d+)/.exec(document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}] .plugin-host')?.textContent ?? '')?.[1] ?? ''`);
  const keyRow = (keys) => ev(`(() => { const r = document.querySelector('#keys-list [data-key=${JSON.stringify(keys)}]'); return r ? { live: r.dataset.live, text: r.textContent } : null; })()`);
  // Запись ядра: модификаторы в порядке Ctrl, Alt, Shift, Meta - на macOS это Shift+Meta+A.
  const combo = (key) => (process.platform === 'darwin' ? `Shift+Meta+${key}` : `Ctrl+Shift+${key}`);
  const re = (key, rest) => new RegExp(combo(key).replaceAll('+', '\\+') + rest);
  // Вид плагина - во фрейме другого процесса: до его документа достаём из главного процесса.
  const inView = (id, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://${id}');
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  const viewLog = (id) => inView(id, "[...document.querySelectorAll('#log li')].map((l) => l.textContent).join('\\n')");
  const views = () => ev("[...document.querySelectorAll('#views [data-plugin]')].map((v) => v.dataset.plugin).join(',')");
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
  await press(combo('A'));
  await waitFor('alice → чат → bob → эхо → чат → alice', () => feedHas(/alice← bob: ответ: привет, bob \(эхо из \d+\)/));
  assert.ok(await feedHas(re('A', '→ alice\\.hello \\(alice\\)')), 'перехват сочетания не попал в ленту');
  assert.ok(!(await feedHas(re('A', 'до окна дошло'))), 'перехваченное сочетание дошло до страницы');
  await press('F2');
  await waitFor('F2 у bob, а не у echo', () => feedHas(/bobчат есть, эхо есть/));
  await press(combo('Z'));
  await waitFor('свободное сочетание дошло до окна', () => feedHas(re('Z', 'до окна дошло')));
  log('перехват клавиш, конфликт, обмен сообщениями через три хоста');

  await waitFor('виды alice и bob во фреймах', async () => (await views()) === 'alice,bob' && (await inView('bob', "document.readyState")) === 'complete');
  assert.equal(await inView('alice', 'typeof window.playground'), 'undefined', 'вид получил мост окна');
  await inView('alice', "document.getElementById('hello').click()");
  await waitFor('вид alice → чат → вид bob', async () => /→ привет, bob/.test(await viewLog('alice')) && /← alice: привет, bob/.test(await viewLog('bob')));
  await inView('bob', "document.getElementById('foreign').click()");
  await waitFor('чужая команда из вида bob отклонена', async () => /отказ: alice\.hello: не команда плагина bob/.test(await viewLog('bob')));
  assert.equal(await inView('bob', 'window.cyborgView.drop()'), null, 'вид получил путь без перетаскивания');
  log('виды во фреймах: свой мост, лента плагина, чужая команда отклонена');

  assert.match(await text('#plugins-list [data-plugin="echo"] .plugin-permissions'), /читает файлы: проекты воркспейса/, 'права echo словами не показаны');
  assert.ok(await button('echo', 'echo.files'), 'нет кнопки echo.files');
  await waitFor('echo пишет в свой каталог, путь вне прав отклонён и записан', () =>
    lines().some((l) => /echo: свой каталог: .*seen\.txt/.test(l)) &&
    lines().includes('[plugins] echo: /etc/hostname: PermissionDenied') &&
    lines().some((l) => l.includes('"kind":"denied"') && l.includes('"method":"fs.readText"')),
  );
  log('ctx.os: свой каталог без права, отказ вне прав с записью в журнале, права словами');

  assert.ok(await button('echo', 'echo.tty'), 'нет кнопки echo.tty');
  await waitFor('pty: /bin/sh в псевдотерминале ядра ответил своим tty и размером', () => lines().some((l) => /echo: pty \d+ вышел с 0: .*\/dev\/(pts\/|tty).* 10 100/.test(l)));
  log('ctx.os.pty: процесс в главном процессе, вывод в хост плагина, размер дошёл до терминала');

  assert.equal(await state('later'), 'waiting', 'ленивый later поднят при старте');
  assert.ok(await button('later', 'later.hello'), 'нет кнопки later.hello у спящего плагина');
  await waitFor('later проснулся по команде', async () => (await state('later')) === 'active' && lines().includes('[plugins] later: привет по команде'));
  await main("process.mainModule.require('electron').powerMonitor.emit('lock-screen')");
  await waitFor('событие ОС дошло до плагина', () => lines().includes('[plugins] later: экран заблокирован'));
  log('ленивая активация по команде; блокировка экрана из powerMonitor дошла до ctx.system');

  assert.equal(await button('chat', 'Выгрузить'), true, 'у chat нет «Выгрузить»');
  await waitFor('chat выгружен, alice снята с ним, bob живёт без чата', async () =>
    (await states({ chat: 'stopped', alice: 'stopped', bob: 'active' })) && lines().includes('[plugins] bob: чат пропал'),
  );
  assert.match(await text('#plugins-list [data-plugin="alice"] .plugin-reason'), /выгружен вместе с chat/);
  await waitFor('вид снятой alice убран', async () => (await views()) === 'bob');
  assert.equal((await keyRow(combo('A')))?.live, 'false');
  await press(combo('A'));
  await waitFor('сочетание выгруженной alice дошло до окна', () => feedHas(re('A', 'до окна дошло')));
  assert.equal(await button('chat', 'Загрузить'), true, 'у выгруженного chat нет «Загрузить»');
  await waitFor('chat и alice вернулись, bob переподписался', async () =>
    (await states({ chat: 'active', alice: 'active' })) && lines().includes('[plugins] bob: чат вернулся, подписываюсь снова'),
  );
  assert.notEqual(await pid('chat'), chatPid, 'после выгрузки chat должен подняться в новом процессе');
  await waitFor('вид alice вернулся', async () => (await views()) === 'alice,bob');
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

  const lock = JSON.parse(readFileSync(join(userData, 'workspace.cyborg.json.lock'), 'utf8'));
  assert.equal(typeof lock.pid, 'number', 'замок воркспейса без pid');
  const second = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--user-data-dir=${userData}`, ...electronArgs], { stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => second.once('exit', r)), sleep(15000).then(() => 'висит')]);
  if (code === 'висит') second.kill('SIGKILL');
  assert.equal(code, 0, 'второй экземпляр на том же воркспейсе не ушёл сам');
  assert.equal(app.exitCode, null, 'первый экземпляр закрылся вместе со вторым');
  assert.equal(await state('echo'), 'active');
  log('воркспейс: замок с pid, второй запуск отдаёт фокус первому и уходит');
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
