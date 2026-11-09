// Дымовой тест собранного playground по DevTools Protocol; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPlugin } from 'cyborg-plugin';
import { transformSync } from 'esbuild';

const repo = resolve(import.meta.dirname, '..', '..');
const electronArgs = process.argv.slice(2);
const TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (text) => console.log(`smoke: ${text}`);
const userData = mkdtempSync(join(tmpdir(), 'cyborg-playground-smoke-'));

// Перезапуск приложения из окна smoke не отслеживает: relaunch и quit подменены, проверяются аргументы нового запуска.
// quit подменён на один вызов: before-quit сам зовёт app.quit, и вечная подмена не дала бы закрыть приложение в конце.
const STUB_RELAUNCH = `(() => {
  const { app, dialog } = process.mainModule.require('electron');
  globalThis.smokeRelaunch = undefined;
  app.relaunch = (options) => { globalThis.smokeRelaunch = options.args; };
  const quit = app.quit;
  app.quit = () => { app.quit = quit; };
  dialog.showMessageBox = async () => ({ response: 0 });
})()`;

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

const liveClaude = process.env.CYBORG_SMOKE_CLAUDE === '1';
// Без живого claude оболочка входа находит подставной (fake-claude.mjs): профиль человека с его PATH в smoke не нужен.
const fakeBin = join(userData, 'fake-bin');
mkdirSync(fakeBin);
writeFileSync(join(fakeBin, 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${join(repo, 'playground', 'scripts', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
writeFileSync(join(fakeBin, 'login-shell'), `#!/bin/sh\nPATH='${fakeBin}':"$PATH"; export PATH\nif [ "$1" = -lc ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n`, { mode: 0o755 });

// P-06: плагин с npm-зависимостью собирает cyborg-plugin в пользовательский каталог плагинов; в конце smoke его включают правкой plugins.enabled.
// Зависимость - настоящий пакет в node_modules исходников; в собранном каталоге её нет, значит и главная часть, и вид несут её код внутри.
const builtSource = join(userData, 'built-dep-src');
const builtFiles = {
  'node_modules/tiny-dep/package.json': '{"name":"tiny-dep","version":"1.0.0","main":"index.js"}',
  'node_modules/tiny-dep/index.js': "module.exports = { shout: (text) => String(text).toUpperCase() + '!' };\n",
  'manifest.json': JSON.stringify({ id: 'built-dep', version: '1.0.0', engines: { cyborg: '^1' }, ui: { views: { main: './ui/ui.js' } } }),
  'index.ts': "import { shout } from 'tiny-dep';\nexport default { activate(ctx) { ctx.log(`зависимость внутри бандла: ${shout('бандл')}`); } };\n",
  'ui/ui.ts':
    "import { shout } from 'tiny-dep';\nexport function mount(root) {\n  const out = document.createElement('div');\n  out.id = 'out';\n  out.textContent = shout('вид');\n  root.append(out);\n  return { dispose() {} };\n}\n",
};
for (const [name, text] of Object.entries(builtFiles)) {
  mkdirSync(join(builtSource, name, '..'), { recursive: true });
  writeFileSync(join(builtSource, name), text);
}
const builtReport = await buildPlugin(builtSource, { out: join(userData, 'plugins', 'built-dep') });
assert.ok(builtReport.ok, `cyborg-plugin build: ${builtReport.problems.map((p) => p.message).join('; ')}`);
// Плагин, которого не было при старте, ядро включает только после перезапуска, поэтому он входит в plugins.enabled заранее: настройки по умолчанию берутся из main.ts стенда.
// Ветку первого запуска (main.ts записывает DEFAULT_CONFIG сам) проходит bareWindow: у него cyborg.json заранее нет, и он сверяет записанное с DEFAULT_CONFIG.
/** DEFAULT_CONFIG из main.ts: текст объекта идёт через esbuild, который снимает типы (аннотация в объекте не ломает разбор). */
function defaultConfig() {
  const text = /const DEFAULT_CONFIG(?::[^=]+)? = (\{[\s\S]*?\n\});/.exec(readFileSync(join(repo, 'playground', 'src', 'main', 'main.ts'), 'utf8'))?.[1];
  assert.ok(text, 'в main.ts не найден DEFAULT_CONFIG');
  return new Function(`return ${transformSync(`(${text})`, { loader: 'ts' }).code}`)();
}
const userConfig = defaultConfig();
userConfig.plugins.enabled.push('built-dep');
writeFileSync(join(userData, 'cyborg.json'), JSON.stringify(userConfig, null, 2));

// --inspect=0 - инспектор главного процесса: нажатие оттуда идёт через before-input-event, как с клавиатуры.
const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', ...electronArgs], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: liveClaude ? process.env : { ...process.env, SHELL: join(fakeBin, 'login-shell') },
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
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result?.value;
  };
  return Object.assign(evaluate, { send });
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
  // Ввод как с клавиатуры через протокол DevTools страницы: он идёт во фрейм с фокусом и не зависит от фокуса окна в оконной системе.
  const typeText = (text) => ev.send('Input.insertText', { text });
  const KEY_CODES = { Enter: 13, ArrowDown: 40 };
  const tap = async (key) => {
    const base = { key, code: key, windowsVirtualKeyCode: KEY_CODES[key], ...(key === 'Enter' && { text: '\r' }) };
    await ev.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
    await ev.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  // Строки экрана xterm: в #screen лежат ещё его <style>, их текст в проверку не берём.
  const sessionScreen = () => inView('sessions', "[...document.querySelectorAll('#screen .xterm-rows > div')].map((d) => d.textContent).join('\\n')");
  const clickIn = async (id, selector, clickCount = 1) => {
    const frame = await ev(`(() => { const r = document.querySelector('.views [data-plugin="${id}"] iframe').getBoundingClientRect(); return [r.left, r.top]; })()`);
    const inner = await inView(id, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    const at = { x: frame[0] + inner[0], y: frame[1] + inner[1], button: 'left', clickCount };
    await ev.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await ev.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  };
  const feed = () => ev(`[...document.querySelectorAll('#feed .log-line')].map((l) => l.textContent)`);
  const feedHas = async (pattern) => (await feed()).some((l) => pattern.test(l));
  const pid = (id) => ev(`/pid (\\d+)/.exec(document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}] .plugin-host')?.textContent ?? '')?.[1] ?? ''`);
  // Состояние и pid - одним чтением одной строки: между двумя запросами список перерисуется, и active старой строки сложится с пустым pid новой.
  const restartedFrom = (id, oldPid) =>
    ev(`(() => {
      const r = document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}]');
      const p = /pid (\\d+)/.exec(r?.querySelector('.plugin-host')?.textContent ?? '')?.[1];
      return r?.dataset.state === 'active' && p !== undefined && p !== ${JSON.stringify(oldPid)};
    })()`);
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
  // Под замком у pin-lock два документа: вид и экран замка; экран - по ?view=overlay.
  const inOverlay = (id, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://${id}' && f.url.includes('view=overlay'));
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  const viewLog = (id) => inView(id, "[...document.querySelectorAll('#log li')].map((l) => l.textContent).join('\\n')");
  // Вид плагина - пара «плагин/вид»: у panels два вида в разных областях.
  const views = () => ev("[...document.querySelectorAll('.views iframe')].map((f) => { const v = f.closest('[data-plugin]').dataset; return v.plugin + '/' + v.view; }).sort().join(',')");
  const viewVar = (id, name) => inView(id, `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
  const theme = (source) => main(`process.mainModule.require('electron').nativeTheme.themeSource = ${JSON.stringify(source)}`);
  const states = async (expected) => {
    for (const [id, want] of Object.entries(expected)) if ((await state(id)) !== want) return false;
    return true;
  };

  await waitFor('демо-плагины работают, flaky выключен с причиной', async () =>
    (await states({ echo: 'active', chat: 'active', alice: 'active', bob: 'active', flaky: 'stopped', 'agent-claude-code': 'active', 'agent-shell': 'active', 'session-isolation': 'active', 'next-actions': 'active', sessions: 'active', panels: 'active' })) &&
    /всегда падает/.test(await text('#plugins-list [data-plugin="flaky"] .plugin-reason')),
  );
  await waitFor('alice и bob подписаны на чат', () => lines().includes('[plugins] chat: подписчиков: 2'));
  // Строка плагина показывает pid позже, чем становится active: чем больше плагинов стартует, тем заметнее разрыв (с built-dep он стал виден).
  const [echoPid, chatPid, bobPid, alicePid] = await waitFor('pid хостов в строках плагинов', async () => {
    const pids = [await pid('echo'), await pid('chat'), await pid('bob'), await pid('alice')];
    return pids.every(Boolean) && pids;
  });
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

  await waitFor('виды echo, alice и bob во фреймах', async () => (await views()) === 'alice/main,bob/main,built-dep/main,echo/main,editor/main,panels/bar,panels/panel,pin-lock/main,sessions/main' && (await inView('bob', "document.readyState")) === 'complete' && (await inView('alice', "!!document.getElementById('hello')")) === true);
  // Область вида задаёт манифест, окно раскладывает по раскладке ядра: оба вида panels на своих местах, у каждого свой ctx.view.
  const area = (selector) => ev(`[...document.querySelectorAll(${JSON.stringify(selector + ' [data-plugin]')})].map((f) => f.dataset.plugin + '/' + f.dataset.view).sort().join(',')`);
  assert.equal(await area('#main-view'), 'sessions/main', 'основная область не по манифесту');
  assert.equal(await area('#toolbar-view'), 'panels/bar', 'панель инструментов не по манифесту');
  assert.equal(await area('#views'), 'alice/main,bob/main,built-dep/main,echo/main,editor/main,panels/panel,pin-lock/main', 'боковая колонка не по манифесту');
  const panelsText = () =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frames = page.mainFrame.framesInSubtree.filter((f) => f.origin === 'cyborg-plugin://panels');
      return (await Promise.all(frames.map((f) => f.executeJavaScript("document.getElementById('which')?.textContent ?? ''")))).sort().join('|');
    })()`);
  await waitFor('оба вида panels показаны, каждый со своим именем', async () => (await panelsText()) === 'panels/bar: панель инструментов|panels/panel: боковая колонка');
  assert.equal(await inView('alice', 'typeof window.playground'), 'undefined', 'вид получил мост окна');
  await inView('alice', "document.getElementById('hello').click()");
  await waitFor('вид alice → чат → вид bob', async () => /→ привет, bob/.test(await viewLog('alice')) && /← alice: привет, bob/.test(await viewLog('bob')));
  await inView('bob', "document.getElementById('foreign').click()");
  await waitFor('чужая команда из вида bob отклонена', async () => /отказ: alice\.hello: не команда плагина bob/.test(await viewLog('bob')));
  assert.equal(await inView('bob', 'window.cyborgView.drop()'), null, 'вид получил путь без перетаскивания');
  log('виды во фреймах: свой мост, лента плагина, чужая команда отклонена');

  assert.match(await viewVar('alice', '--cy-scheme'), /^(light|dark)$/, 'токены темы не дошли до вида');
  // Тема рабочего стола бывает тёмной: без шага через светлую смена на dark не случится, и onChange не позовётся.
  await theme('light');
  await waitFor('светлая тема в виде alice', async () => (await viewVar('alice', '--cy-bg')) === '#ffffff');
  await theme('dark');
  await waitFor('тёмная тема в виде alice, onChange в его модуле', async () => (await viewVar('alice', '--cy-bg')) === '#0d1117' && /тема: dark/.test(await viewLog('alice')));
  await theme('light');
  await waitFor('светлая тема в виде bob', async () => (await viewVar('bob', '--cy-bg')) === '#ffffff');
  await inView('bob', "document.getElementById('echo').click()");
  await waitFor('вид bob вызвал demo.echo через ядро', async () => /вид: из вида bob \(эхо из \d+\)/.test(await viewLog('bob')));
  const toggle = () => ev(`document.querySelector('#views [data-plugin="bob"] .view-toggle').click()`);
  await inView('bob', "document.getElementById('field').value = 'набрано до сворачивания'");
  await toggle();
  await waitFor('свёрнутый вид получил onVisibilityChange', async () => /вид скрыт, DOM жив/.test(await viewLog('bob')));
  await toggle();
  await waitFor('развёрнутый вид получил onVisibilityChange', async () => /вид снова показан/.test(await viewLog('bob')));
  assert.equal(await inView('bob', "document.getElementById('field').value"), 'набрано до сворачивания', 'сворачивание размонтировало вид');
  log('UiContext: тема до mount и при смене, контракт из вида, сворачивание без размонтирования');

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
  await waitFor('на месте вида снятой alice - заглушка с причиной', async () => (await views()) === 'bob/main,built-dep/main,echo/main,editor/main,panels/bar,panels/panel,pin-lock/main,sessions/main' && /выгружен вместе с chat/.test(await text('#views [data-plugin="alice"] .view-reason')));
  assert.ok(await ev(`[...document.querySelectorAll('#views [data-plugin="alice"] button')].some((b) => b.textContent === 'Журнал')`), 'у заглушки нет «Журнал»');
  assert.equal((await keyRow(combo('A')))?.live, 'false');
  await press(combo('A'));
  await waitFor('сочетание выгруженной alice дошло до окна', () => feedHas(re('A', 'до окна дошло')));
  assert.equal(await button('chat', 'Загрузить'), true, 'у выгруженного chat нет «Загрузить»');
  await waitFor('chat и alice вернулись, bob переподписался', async () =>
    (await states({ chat: 'active', alice: 'active' })) && lines().includes('[plugins] bob: чат вернулся, подписываюсь снова'),
  );
  assert.notEqual(await pid('chat'), chatPid, 'после выгрузки chat должен подняться в новом процессе');
  await waitFor('вид alice вернулся', async () => (await views()) === 'alice/main,bob/main,built-dep/main,echo/main,editor/main,panels/bar,panels/panel,pin-lock/main,sessions/main');
  await waitFor('новый документ alice помнит приветы из state воркспейса', async () => (await inView('alice', "document.getElementById('greeted')?.textContent")) === 'приветов: 1');
  log('выгрузка с зависимыми, загрузка в новый процесс, переподписка');

  const chatPid2 = await pid('chat');
  assert.equal(await button('chat', 'Уронить хост'), true);
  await waitFor('хост b упал и поднялся', async () => /хост b упал/.test(await text('#plugins-journal')) && (await restartedFrom('chat', chatPid2)));
  const screen = () => inView('echo', "document.getElementById('screen').textContent");
  const type = (command) => inView('echo', `(() => { const l = document.getElementById('line'); l.value = ${JSON.stringify(command)}; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await waitFor('вид echo открыл pty по билету главной части', async () => /^pty \d+$/.test(await inView('echo', "document.getElementById('term-state').textContent")));
  await type('echo до-$((6*7))');
  await waitFor('терминал вида ответил', async () => /до-42/.test(await screen()));

  const windows = () => main("process.mainModule.require('electron').BrowserWindow.getAllWindows().length");
  assert.equal(await inView('echo', "window.open('https://example.com/login') === null"), true, 'window.open вида вернул окно');
  await sleep(500);
  assert.equal(await windows(), 1, 'вид открыл новое окно');
  await inView('echo', "location.href = 'https://example.com/away'; true");
  await waitFor('переход фрейма вида отклонён и записан в журнал echo', () =>
    lines().some((l) => l.includes('"pluginId":"echo","kind":"denied","method":"navigate"') && l.includes('https://example.com/away')),
  );
  assert.equal(await inView('echo', 'location.protocol'), 'cyborg-plugin:', 'фрейм вида ушёл со своего адреса');
  await type('echo на-месте-$((2*21))');
  await waitFor('вид после отказа работает', async () => /на-месте-42/.test(await screen()));
  // CSP окна пропускает data: во фрейм, поэтому решает только will-frame-navigate: переход отклонён, вид остаётся.
  await inView('echo', "location.href = 'data:text/html,%3Cb%3Ex%3C/b%3E'; true");
  await waitFor('переход фрейма вида на data: отклонён и записан в журнал echo', () =>
    lines().some((l) => l.includes('"pluginId":"echo","kind":"denied","method":"navigate"') && l.includes('data:text/html')),
  );
  assert.equal(await inView('echo', 'location.protocol'), 'cyborg-plugin:', 'фрейм вида ушёл на data:');
  const windowUrl = await ev('location.href');
  await ev("location.href = 'https://example.com/'; true");
  await sleep(500);
  assert.equal(await ev('location.href'), windowUrl, 'окно ушло на внешний адрес');
  assert.equal(await windows(), 1);
  log('окно не открывает новых окон и не уходит со своих адресов: отказ виду - в журнал его плагина');

  if (process.platform !== 'win32') {
    const hung = await pid('echo');
    assert.equal(await button('echo', 'Повесить хост'), true);
    await waitFor('хост echo остановлен SIGSTOP', async () => /^T/.test(await main(`process.mainModule.require('child_process').execSync('ps -o stat= -p ${hung}').toString().trim()`)));
    await type('echo завис-$((7*8))');
    await waitFor('хост echo стоит, а терминал вида работает', async () => /завис-56/.test(await screen()));
    await waitFor('сторож признал хост a зависшим и перезапустил', async () => /хост a завис/.test(await text('#plugins-journal')) && (await restartedFrom('echo', echoPid)));
    await type('echo после-$((8*9))');
    await waitFor('после перезапуска хоста терминал вида тот же', async () => /после-72/.test(await screen()));
    log('терминал вида: билет share(), вывод и ввод мимо хоста - работают при зависшем хосте и после его перезапуска');

    const sh = /^pty (\d+)$/.exec(await inView('echo', "document.getElementById('term-state').textContent"))[1];
    const alive = (p) => main(`(() => { try { process.kill(${p}, 0); return true; } catch { return false; } })()`);
    const ask = () => ev("document.querySelector('dialog.pty-dialog[open]')?.textContent ?? ''");
    const choose = (choice) => ev(`(() => { const b = document.querySelector('dialog.pty-dialog[open] button[data-choice=${JSON.stringify(choice)}]'); b?.click(); return !!b; })()`);
    const load = async () => (await button('echo', 'Загрузить')) || button('echo', 'Включить снова');
    assert.equal(await button('echo', 'Выгрузить'), true);
    await waitFor('выключение echo спрашивает о его процессах', async () => (await ask()).includes(`/bin/sh - pid ${sh}`));
    assert.equal(await ev("document.activeElement?.dataset.choice ?? ''"), 'keep', 'фокус вопроса не на безопасном ответе');
    assert.equal(await choose('keep'), true);
    await waitFor('echo выгружен, процесс оставлен', async () => (await state('echo')) === 'stopped' && /оставлено: 1/.test(await text('#plugins-journal')));
    assert.equal(await alive(sh), true, 'оставленный процесс завершён');
    const kept = () => text('#plugins-list [data-plugin="echo"] .plugin-kept');
    await waitFor('строка echo показывает оставленный процесс', async () => (await kept()).includes(`/bin/sh - pid ${sh}`));
    assert.equal(await load(), true);
    await waitFor('вернувшийся echo подхватил тот же процесс', async () => (await state('echo')) === 'active' && (await inView('echo', "document.getElementById('term-state').textContent")) === `pty ${sh}` && /после-72/.test(await screen()));
    assert.equal(await kept(), '', 'подхваченный процесс остался в списке оставленных');
    await type('echo снова-$((9*9))');
    await waitFor('терминал ожил', async () => /снова-81/.test(await screen()));
    assert.equal(await button('echo', 'Выгрузить'), true);
    await waitFor('второй вопрос', async () => (await ask()).includes(`pid ${sh}`));
    assert.equal(await choose('kill'), true);
    await waitFor('процесс echo завершён', async () => (await state('echo')) === 'stopped' && !(await alive(sh)));
    assert.equal(await load(), true);
    await waitFor('echo с новым терминалом', async () => (await state('echo')) === 'active' && /^pty \d+$/.test(await inView('echo', "document.getElementById('term-state').textContent")));
    const sh2 = /^pty (\d+)$/.exec(await inView('echo', "document.getElementById('term-state').textContent"))[1];
    assert.equal(await button('echo', 'Выгрузить'), true);
    await waitFor('третий вопрос', async () => (await ask()).includes(`pid ${sh2}`));
    assert.equal(await choose('keep'), true);
    await waitFor('второй процесс оставлен', async () => (await kept()).includes(`pid ${sh2}`));
    assert.equal(await ev(`(() => { const b = document.querySelector('#plugins-list [data-plugin="echo"] .kept-row button'); b?.click(); return !!b; })()`), true);
    await waitFor('человек завершил оставленный процесс из строки плагина', async () => !(await alive(sh2)) && (await kept()) === '');
    assert.equal(await load(), true);
    await waitFor('echo снова активен', async () => (await state('echo')) === 'active' && /^pty \d+$/.test(await inView('echo', "document.getElementById('term-state').textContent")));
    log('выключение спрашивает о pty: оставленный процесс виден в строке плагина и ждёт его, завершённый уходит, оставленный завершается человеком');
  }
  log('падение и зависание хоста: сторож перезапускает');

  await inView('bob', "window.beforeCrash = 'документ до сбоя'");
  await ev(`(() => {
    window.plaqueSeen = false;
    const views = document.getElementById('views');
    new MutationObserver(() => {
      if (views.querySelector('[data-plugin="bob"][data-state="restarting"] iframe[inert]') && views.querySelector('[data-plugin="bob"] .view-plaque:not([hidden])')) window.plaqueSeen = true;
    }).observe(views, { subtree: true, attributes: true, childList: true });
  })()`);
  const bobPid2 = await pid('bob');
  assert.equal(await button('bob', 'Уронить хост'), true);
  await waitFor('хост c поднялся, bob снова работает', () => restartedFrom('bob', bobPid2));
  assert.equal(await ev('window.plaqueSeen'), true, 'на время перезапуска вид не закрыт плашкой');
  assert.equal(await inView('bob', 'window.beforeCrash'), 'документ до сбоя', 'перезапуск хоста пересоздал документ вида');
  const statuses = async () => (await viewLog('bob')).split('\n').filter((l) => /чат есть/.test(l)).length;
  const before = await statuses();
  await inView('bob', "document.getElementById('status').click()");
  await waitFor('вид после перезапуска зовёт новый хост', async () => (await statuses()) > before);
  log('перезапуск хоста: вид под плашкой без ввода, документ вида жив, мост ходит в новый хост');

  const answer = () => inView('pin-lock', "document.getElementById('answer').textContent");
  await waitFor('вид pin-lock знает своё сочетание', async () => ((await inView('pin-lock', "document.getElementById('lock')?.textContent")) ?? '').endsWith(`(${combo('L')})`));
  await inView('pin-lock', "document.getElementById('ask').click()");
  await waitFor('диалог ask в слое окна, поверх фреймов', () => ev("document.querySelector('dialog.layer-ask[data-plugin=\"pin-lock\"]')?.open === true"));
  await ev("document.querySelector('dialog.layer-ask button[data-choice=\"yes\"]').click()");
  await waitFor('ответ ask дошёл до вида', async () => (await answer()) === 'yes');
  await inView('pin-lock', "document.getElementById('menu').click()");
  await waitFor('меню у кнопки вида', () => ev("(() => { const d = document.querySelector('dialog.layer-menu'); return d?.open === true && d.style.top !== ''; })()"));
  await ev("document.querySelector('dialog.layer-menu').click()");
  await waitFor('клик мимо меню - отмена', async () => (await answer()) === 'отмена');
  log('слой окна: ask и menu вида поверх фреймов, ответ и отмена, ctx.keys.of');

  await press(combo('L'));
  await waitFor('окно закрыто замком pin-lock', () => ev("document.body.dataset.locked === 'true' && document.getElementById('playground').inert && !!document.querySelector('#lock-layer [data-plugin=\"pin-lock\"] iframe')"));
  await waitFor('экран замка загружен', async () => (await inOverlay('pin-lock', "document.getElementById('status')?.textContent")) === 'Окно закрыто');
  await press(combo('A'));
  await waitFor('чужое сочетание под замком не перехвачено', () => feedHas(re('A', 'до окна дошло')));
  const submit = (pin) => inOverlay('pin-lock', `(() => { document.getElementById('pin').value = ${JSON.stringify(pin)}; document.getElementById('unlock').click(); })()`);
  await submit('1234');
  await waitFor('неверный PIN не открывает', async () => (await inOverlay('pin-lock', "document.getElementById('status').textContent")) === 'Неверный PIN');
  assert.equal(await ev('document.body.dataset.locked'), 'true', 'окно открылось по неверному PIN');
  await submit('0000');
  await waitFor('окно открыто по PIN', () => ev("document.body.dataset.locked === 'false' && !document.getElementById('playground').inert && document.getElementById('lock-layer').hidden"));
  log('замок: виды скрыты, экран замка, чужие сочетания не перехвачены, открытие по PIN');

  const focusedArea = () => ev("(() => { const a = document.activeElement; return a?.tagName === 'IFRAME' ? 'вид ' + a.closest('[data-plugin]').dataset.plugin : [...(a?.classList ?? [])].join(' '); })()");
  await ev('document.activeElement?.blur()');
  await press('F6');
  await waitFor('F6: фокус на первой панели', async () => /pane-plugins/.test(await focusedArea()));
  await press('F6');
  // Порядок обхода - порядок окна: панель инструментов основной области (вид bar плагина panels) стоит над основной областью.
  await waitFor('F6: скрытые вкладки пропущены, следом первый вид окна - панель инструментов', async () => (await focusedArea()) === 'вид panels');
  await press('Shift+F6');
  await press('Shift+F6');
  await waitFor('Shift+F6 с первой панели - на последний вид', async () => /^вид /.test(await focusedArea()));
  const last = (await focusedArea()).slice('вид '.length);
  await waitFor('фокус вида лёг на его элемент, а не на body', async () => !['BODY', null].includes(await inView(last, 'document.activeElement?.tagName ?? null')));
  log(`порядок фокуса: F6 по панелям, Shift+F6 по кругу на вид ${last}, внутри вида - первый элемент`);

  const agentButtons = () => inView('sessions', "[...document.querySelectorAll('#agents cy-button')].map((b) => b.dataset.agent + (b.disabled ? '-' : '+')).sort().join(',')");
  await waitFor('sessions видит обоих поставщиков cyborg.agent', async () => /^claude-code[+-],shell\+$/.test(await agentButtons()));
  await inView('sessions', "document.querySelector('#agents cy-button[data-agent=\"shell\"]').click()");
  await waitFor('сессия агента shell открыта', async () => /^Оболочка: pid \d+$/.test(await inView('sessions', "document.getElementById('session-state').textContent")));
  await inView('sessions', `(() => { const l = document.getElementById('line'); l.value = 'echo агент-$((5*5))'; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await waitFor('терминал сессии ответил', async () => /агент-25/.test(await sessionScreen()));
  assert.ok(await inView('sessions', "document.getElementById('screen').contains(document.activeElement)"), 'открытая сессия не забрала фокус на экран');
  await clickIn('sessions', '#screen');
  await typeText('echo экран-$((6*7))');
  await tap('Enter');
  await waitFor('клавиши с экрана дошли до сессии', async () => /экран-42/.test(await sessionScreen()));
  await inView('sessions', `(() => { const l = document.getElementById('line'); l.value = 'echo размер-$(stty size | tr " " x)'; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  let ptySize = '';
  await waitFor('pty сообщил размер', async () => (ptySize = /размер-(\d+x\d+)/.exec(await sessionScreen())?.[1] ?? '') !== '');
  assert.notEqual(ptySize, '32x120', 'размер pty не подогнан под экран вида');
  log(`cyborg.agent: два поставщика (${await agentButtons()}), sessions запускает pty по описанию агента; клавиши с экрана уходят в сессию, pty по экрану ${ptySize}`);

  // PL-05: Monaco и xterm в одном окне, каждый во фрейме на своём origin cyborg-plugin://; воркеры, шрифт и таблицы - файлы того же origin под CSP вида.
  await ev("document.getElementById('tab-views').click()");
  const editorData = (name) => inView('editor', `document.getElementById('cyborg-view').dataset.${name} ?? ''`);
  const editorText = () => inView('editor', "[...document.querySelectorAll('.monaco-editor .view-line')].map((l) => l.textContent).join('\\n').replaceAll('\\u00a0', ' ')");
  const editorState = () => inView('editor', "document.getElementById('editor-state')?.textContent ?? ''");
  await waitFor('Monaco открыл settings.json во фрейме', async () => /settings\.json: открыт/.test(await editorState()) && /fontSize/.test(await editorText()));
  await waitFor('подсветка: токены разных классов', async () => (await inView('editor', "new Set([...document.querySelectorAll('.monaco-editor .view-line span span')].map((s) => s.className)).size")) >= 3);
  await waitFor('воркеры Monaco (общий и json) подняты из файлов', async () => /json/.test(await editorData('workers')) && /editor/.test(await editorData('workers')));
  assert.equal(await editorData('violations'), '', 'CSP вида отклонила ресурс Monaco');
  assert.equal(await inView('editor', "document.fonts.load('16px codicon').then((f) => f.length)"), 1, 'шрифт значков Monaco (.ttf) не загрузился');
  await inView('sessions', `(() => { const l = document.getElementById('line'); l.value = 'echo оба-$((7*7))'; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await waitFor('xterm отвечает, пока открыт Monaco', async () => /оба-49/.test(await sessionScreen()));
  assert.notEqual(await inView('editor', 'location.origin'), await inView('sessions', 'location.origin'), 'Monaco и xterm в одном origin');
  const openFile = async (file) => {
    await inView('editor', `document.querySelector('cy-button[data-file="${file}"]').click()`);
    await waitFor(`${file} открыт`, async () => (await editorState()).startsWith(`${file}: открыт`) && (await editorText()).length > 10);
  };
  // Маркеры воркеров языка без ввода: в файлах нарочно ошибки.
  await openFile('broken.json');
  await waitFor('воркер json прислал маркер синтаксической ошибки', async () => /json:2:/.test(await editorData('markers')));
  await openFile('sample.ts');
  await waitFor('воркер TypeScript прислал маркер ошибки типа', async () => /typescript:7:/.test(await editorData('markers')), 40_000);
  await openFile('settings.json');
  // Правка и проверка владельца: двойной щелчок по числу, ввод, ответ editor.check приходит маркером; сохранение уходит в файл плагина.
  const focusEditor = async () => {
    // Окно на машине разработчика бывает не на переднем плане: щелчок CDP тогда не фокусирует кадр, и фокус ставится программно.
    await ev('document.querySelector(\'.views [data-plugin="editor"] iframe\').focus()');
    await main("process.mainModule.require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'window').focus()");
    await inView('editor', "document.querySelector('.monaco-editor .native-edit-context, .monaco-editor textarea').focus()");
  };
  await ev.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Кадр в сетке узкий, число может лежать за его краем: выделение клавишами, а не мышью.
  const mac = process.platform === 'darwin';
  const press1 = async (key, windowsVirtualKeyCode, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp']) await ev.send('Input.dispatchKeyEvent', { type, modifiers, key, code: key, windowsVirtualKeyCode });
  };
  await focusEditor();
  await press1(mac ? 'ArrowUp' : 'Home', mac ? 38 : 36, mac ? 4 : 2);
  await press1('ArrowDown', 40);
  await press1('End', 35);
  await press1('ArrowLeft', 37);
  await press1('ArrowLeft', 37, 8);
  await press1('ArrowLeft', 37, 8);
  await typeText('99');
  await waitFor('замечание владельца к fontSize стоит маркером Monaco', async () => /owner:2:fontSize - число от 8 до 32/.test(await editorData('markers')));
  await inView('editor', "document.getElementById('save').click()");
  await waitFor('файл сохранён командой editor.save', async () => /settings\.json: сохранён/.test(await editorState()));
  await openFile('sample.ts');
  await openFile('settings.json');
  await waitFor('settings.json открыт заново и несёт правку', async () => /"fontSize": 99/.test(await editorText()));
  assert.equal(await editorData('violations'), '', 'CSP вида отклонила ресурс Monaco при работе');
  log('PL-05: Monaco (воркеры и шрифт из файлов своего origin, без нарушений CSP) и xterm работают в одном окне; проверка схемы - у владельца, правка сохраняется');

  // Буфер обмена: role copy/paste меню Edit действует на сфокусированный фрейм; Monaco и xterm получают события copy/paste.
  const roleItem = (role) =>
    main(`(() => {
      const { Menu, BrowserWindow } = process.mainModule.require('electron');
      const win = BrowserWindow.getAllWindows()[0];
      const find = (items) => items.flatMap((i) => (i.role === ${JSON.stringify(role)} ? [i] : i.submenu ? find(i.submenu.items) : []));
      const item = find(Menu.buildFromTemplate([{ role: 'editMenu' }]).items)[0];
      item?.click(undefined, win, win.webContents);
      return !!item;
    })()`);
  const clipboardText = () => main("process.mainModule.require('electron').clipboard.readText()");
  const setClipboard = (text) => main(`process.mainModule.require('electron').clipboard.writeText(${JSON.stringify(text)})`);
  // Что делает role меню: на macOS - действие первого ответчика AppKit, оно без нативного ключевого окна может не дойти;
  // на Linux и Windows - webContents.copy()/paste() сфокусированного кадра. Считаем и то и другое: меню-role, затем сам вызов.
  const viaRole = {};
  const edit = async (action, done) => {
    assert.equal(await roleItem(action), true, `в меню Edit нет role ${action}`);
    const worked = await waitFor(`role ${action} через меню`, done, 1500).then(() => true, () => false);
    if (!worked) await main(`process.mainModule.require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'window').${action}()`);
    viaRole[action] = (viaRole[action] ?? true) && worked;
  };
  // На macOS в CI окно не ключевое для ОС: webContents.copy()/paste() не доходят до вложенного кадра (на Linux в CI и на macOS локально - доходят).
  // Там отказ канала copy/paste не валит smoke, а пишется в журнал; локально (без CI) шаг строгий.
  let clipboardSkipped = '';
  try {
    await setClipboard('');
    await focusEditor();
    await clickIn('editor', '.monaco-editor .view-lines');
    // Без выделения Monaco копирует строку с кареткой (emptySelectionClipboard): выделение клавишами в окне CI ненадёжно, а проверяется канал copy.
    const copied = async () => {
      const text = (await clipboardText()).trim();
      return text !== '' && (await editorText()).includes(text) ? text : '';
    };
    await edit('copy', async () => (await copied()) !== '');
    await waitFor('copy: в буфере строка Monaco', async () => (await copied()) !== '');
    await setClipboard('// из буфера');
    await edit('paste', async () => /\/\/ из буфера/.test(await editorText()));
    await waitFor('paste: текст из буфера вставлен в Monaco', async () => /\/\/ из буфера/.test(await editorText()));
    const row = await inView('sessions', "[...document.querySelectorAll('#screen .xterm-rows > div')].findIndex((d) => /оба-49/.test(d.textContent)) + 1");
    assert.ok(row > 0, 'строка оба-49 не найдена на экране xterm');
    await setClipboard('');
    await clickIn('sessions', `#screen .xterm-rows > div:nth-child(${row})`, 3);
    await edit('copy', async () => /оба-49/.test(await clipboardText()));
    await waitFor('copy: выделенная строка xterm в буфере', async () => /оба-49/.test(await clipboardText()));
    await setClipboard('echo из-буфера-$((8*8))\n');
    await clickIn('sessions', '#screen');
    await edit('paste', async () => /из-буфера-64/.test(await sessionScreen()));
    await waitFor('paste: текст из буфера ушёл в pty через xterm', async () => /из-буфера-64/.test(await sessionScreen()));
  } catch (error) {
    if (process.platform !== 'darwin' || process.env.CI === undefined) throw error;
    clipboardSkipped = error instanceof Error ? error.message : String(error);
  }
  // navigator.clipboard из фрейма на другом origin: политика разрешений фрейма решает, пустят ли.
  await setClipboard('до');
  const nav = JSON.parse(await inView('sessions', `(async () => {
    const out = { focused: document.hasFocus(), policy: { write: document.featurePolicy?.allowsFeature('clipboard-write'), read: document.featurePolicy?.allowsFeature('clipboard-read') } };
    try { await navigator.clipboard.writeText('после'); out.write = 'записал'; } catch (e) { out.write = e.name + ': ' + e.message; }
    try { out.read = await navigator.clipboard.readText(); } catch (e) { out.read = e.name + ': ' + e.message; }
    return JSON.stringify(out);
  })()`));
  log(`буфер обмена на ${process.platform}: ${clipboardSkipped ? 'copy/paste в Monaco и xterm не проверены' : 'copy/paste в Monaco и xterm работают'} (role меню Edit сама сработала: ${JSON.stringify(viaRole)}, иначе - webContents.copy()/paste()); navigator.clipboard из фрейма xterm - ${JSON.stringify(nav)}, в буфере ОС после записи «${await clipboardText()}»${clipboardSkipped ? `; причина (macOS в CI): ${clipboardSkipped}` : ''}`);
  await ev.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await ev("document.getElementById('tab-plugins').click()");

  // Элементы ядра: оболочка определила их до mount; клавиши шлём в тень, как их шлёт браузер с фокусом там.
  const kit = await inView('sessions', `(() => {
    const seen = [];
    const box = document.createElement('div');
    document.body.append(box);
    const list = document.createElement('cy-list');
    list.items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', detail: 'вторая' }];
    const tree = document.createElement('cy-tree');
    tree.items = [{ id: 'src', label: 'src', children: [{ id: 'x', label: 'x.ts' }] }];
    const tabs = document.createElement('cy-tabs');
    tabs.tabs = [{ id: 'one', label: 'Один' }, { id: 'two', label: 'Два' }];
    const off = document.createElement('cy-button');
    off.disabled = true;
    off.addEventListener('click', () => seen.push('click'));
    box.append(list, tree, tabs, off);
    for (const e of [list, tree, tabs]) for (const t of ['cy-select', 'cy-activate', 'cy-toggle']) box.addEventListener(t, (ev) => ev.target === e && seen.push(e.localName + ' ' + t + ' ' + ev.detail.id));
    const key = (e, role, k) => e.shadowRoot.querySelector('[role="' + role + '"]').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true }));
    for (const k of ['ArrowDown', 'ArrowDown', 'Enter']) key(list, 'listbox', k);
    for (const k of ['ArrowDown', 'ArrowRight', 'ArrowRight']) key(tree, 'tree', k);
    key(tabs, 'tablist', 'ArrowRight');
    off.click();
    try { list.items = [{ id: '', label: 'пусто' }]; } catch (e) { seen.push(e.name); }
    const styled = getComputedStyle(list).display === 'block' && getComputedStyle(off).display === 'inline-block';
    const defined = ['cy-button', 'cy-field', 'cy-list', 'cy-tree', 'cy-tabs', 'cy-empty', 'cy-spinner'].every((t) => customElements.get(t));
    box.remove();
    return JSON.stringify({ seen, styled, defined, selected: [list.selected, tree.selected, tabs.selected] });
  })()`);
  assert.deepEqual(JSON.parse(kit), {
    seen: ['cy-list cy-select a', 'cy-list cy-select b', 'cy-list cy-activate b', 'cy-tree cy-select src', 'cy-tree cy-toggle src', 'cy-tree cy-select x', 'cy-tabs cy-select two', 'TypeError'],
    styled: true,
    defined: true,
    selected: ['b', 'x', 'two'],
  });
  log('элементы ядра: определены до mount, стили под CSP вида, клавиши и события списка, дерева и вкладок, disabled у кнопки');

  const docRows = () => ev("[...document.querySelectorAll('#documents-list .document-row')].map((r) => r.querySelector('.document-owner').textContent + ':' + r.dataset.available).join(',')");
  await waitFor('вкладка сессии в панели «Документы»', async () => (await docRows()) === 'sessions · session:true');
  await ev("document.querySelector('#documents-list .document-row button').click()");
  await waitFor('человек закрыл вкладку - сессия завершена, строки нет', async () => (await docRows()) === '' && /вышла/.test(await inView('sessions', "document.getElementById('session-state').textContent")));
  log('документы: вкладка сессии в окне, «Закрыть» уводит onClose владельцу и завершает его сессию');

  // Живой claude нужен с входом в аккаунт и сетью: шаг по CYBORG_SMOKE_CLAUDE=1, в CI его нет.
  if (liveClaude) {
    assert.match(await agentButtons(), /claude-code\+/, 'CYBORG_SMOKE_CLAUDE=1, а claude не найден в PATH оболочки входа');
    await inView('sessions', "document.querySelector('#agents cy-button[data-agent=\"claude-code\"]').click()");
    const screen = () => sessionScreen();
    // Новый каталог сессий claude сначала спрашивает о доверии; уже доверенный сразу начинает сессию.
    await waitFor('живой claude: вопрос о доверии к каталогу или начало сессии', async () => /trust\s*this\s*folder/.test(await screen()) || lines().some((l) => /claude-code s\S+: сессия агента/.test(l)), 60_000);
    let reached = 'хук SessionStart дошёл событием session';
    if (/trust\s*this\s*folder/.test(await screen())) {
      // По умолчанию выбрано «No, exit» (Enter - выход claude с 1), а Enter на «Yes» записал бы временный каталог в доверенные ~/.claude.json.
      const chosen = async () => /❯\s*Yes,\s*I\s*trust/.test((await screen()).slice(-400));
      // Ink выводит диалог раньше, чем принимает клавиши.
      for (let i = 0; i < 5 && !(await chosen()); i++) {
        await tap('ArrowDown');
        await waitFor('выбор в диалоге claude', chosen, 2000).catch(() => undefined);
      }
      assert.ok(await chosen(), 'стрелка с экрана не дошла до диалога claude');
      reached = 'вопрос о доверии к каталогу, стрелка с экрана меняет выбор';
    }
    await waitFor('вкладка сессии claude в панели «Документы»', async () => (await docRows()) === 'sessions · session:true');
    await ev("document.querySelector('#documents-list .document-row button').click()");
    await waitFor('сессия claude закрыта', async () => (await docRows()) === '' && /вышла/.test(await inView('sessions', "document.getElementById('session-state').textContent")));
    log(`живой claude: оболочка входа по праву launch поставщика, ${reached}; вкладка закрывает сессию`);
  } else {
    await inView('sessions', "document.querySelector('#agents cy-button[data-agent=\"claude-code\"]').click()");
    await waitFor('подставной claude запущен', async () => /fake claude: готов/.test(await sessionScreen()));
    // Подписка на файл событий начинается с его конца: хук до неё не дошёл бы.
    await sleep(500);
    const say = (text) => inView('sessions', `(() => { const l = document.getElementById('line'); l.value = ${JSON.stringify(text)}; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    const action = () => inView('sessions', "(() => { const b = document.querySelector('#actions cy-button'); const r = b?.querySelector('.reply'); return b && !b.closest('[hidden]') && r.getBoundingClientRect().height > 0 ? `${b.querySelector('.label').textContent}/${r.textContent}/${b.getAttribute('variant') === 'primary' ? 'отправит' : 'в строку'}` : ''; })()");
    const received = async () => (await sessionScreen()).split('получено: smoke-reply').length - 1;
    await say('go');
    await waitFor('ход кончился: кнопка с репликой второй строкой отправляет сразу', async () => (await action()) === 'Продолжить/smoke-reply/отправит');
    await inView('sessions', "document.querySelector('#actions cy-button').click()");
    await waitFor('реплика кнопки ушла агенту с Enter', async () => (await received()) === 1);
    await say('ask');
    await waitFor('агент спрашивает: кнопка ставит реплику в строку', async () => (await action()) === 'Продолжить/smoke-reply/в строку' && /просит разрешение/.test(await sessionScreen()));
    await inView('sessions', "document.querySelector('#actions cy-button').click()");
    assert.equal(await inView('sessions', "document.getElementById('line').value"), 'smoke-reply', 'реплика не встала в строку ввода');
    await sleep(300);
    assert.equal(await received(), 1, 'кнопка ответила на вопрос агента за человека');
    await waitFor('вкладка сессии подставного claude в панели «Документы»', async () => (await docRows()) === 'sessions · session:true');
    await ev("document.querySelector('#documents-list .document-row button').click()");
    await waitFor('сессия подставного claude закрыта', async () => (await docRows()) === '');
    log('кнопки агента: реплика на кнопке второй строкой; Enter за человека - только после конца хода, при вопросе агента реплика встаёт в строку ввода');
  }

  assert.equal(await button('flaky', 'Журнал'), true, 'у flaky нет кнопки «Журнал»');
  assert.equal(await text('#plugins-journal-title'), 'Журнал: flaky');
  assert.equal(await ev("document.getElementById('tab-journal').getAttribute('aria-selected') + ':' + document.getElementById('panel-journal').hidden"), 'true:false', '«Журнал» плагина не открыл вкладку журнала');
  assert.doesNotMatch(await text('#plugins-journal'), /\bchat\b/, 'журнал flaky показал чужие записи');
  assert.equal(await button('flaky', 'Включить снова'), true, 'у выключенного flaky нет «Включить снова»');
  await waitFor('flaky включён снова', async () => (await state('flaky')) === 'active');
  log('окно: заглушка с причиной, журнал плагина, «Включить снова»');

  // Плагин, собранный cyborg-plugin (каталог пользователя, enabled заранее): главная часть из index.mjs и вид из ui/ui.js исполняют код npm-зависимости, которой в каталоге нет.
  assert.equal(await state('built-dep'), 'active', 'собранный плагин не включился');
  assert.ok(lines().includes('[plugins] built-dep: зависимость внутри бандла: БАНДЛ!'), 'главная часть из index.mjs не исполнила код зависимости');
  assert.equal(await inView('built-dep', "document.getElementById('out')?.textContent"), 'ВИД!', 'вид из ui/ui.js не исполнил код зависимости');
  log('cyborg-plugin: собранный каталог с npm-зависимостью (manifest.json, index.mjs, ui/ui.js) загружен стендом, вид открыт');

  const lock = JSON.parse(readFileSync(join(userData, 'workspace.cyborg.json.lock'), 'utf8'));
  assert.equal(typeof lock.pid, 'number', 'замок воркспейса без pid');
  const second = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--user-data-dir=${userData}`, ...electronArgs], { stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => second.once('exit', r)), sleep(15000).then(() => 'висит')]);
  if (code === 'висит') second.kill('SIGKILL');
  assert.equal(code, 0, 'второй экземпляр на том же воркспейсе не ушёл сам');
  assert.equal(app.exitCode, null, 'первый экземпляр закрылся вместе со вторым');
  assert.equal(await state('echo'), 'active');
  assert.match(await text('#workspace-current'), /workspace\.cyborg\.json$/);
  const recent = JSON.parse(readFileSync(join(userData, 'recent.json'), 'utf8')).recent;
  assert.ok(recent.some((f) => f.endsWith('workspace.cyborg.json')), 'открытый воркспейс не попал в «Недавние»');
  log('воркспейс: замок с pid, второй запуск отдаёт фокус первому и уходит, открытый - в «Недавних»');

  await main(STUB_RELAUNCH);
  assert.equal(await ev("document.getElementById('safe-mode').hidden"), true, 'плашка безопасного режима без флага');
  await ev("document.getElementById('safe-mode-enter').click()");
  const relaunched = await waitFor('перезапуск в безопасном режиме', () => main('globalThis.smokeRelaunch'));
  assert.ok(relaunched.includes('--safe-mode'), `перезапуск без --safe-mode: ${relaunched.join(' ')}`);
  log('безопасный режим: пункт окна перезапускает приложение с --safe-mode');

  await bareWindow();
  await safeWindow();
}

/** Безопасный режим: свой userData, сторонний плагин с замком на старте; код плагинов не запускается, окно не закрыто. */
async function safeWindow() {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-playground-safe-'));
  const locker = join(dir, 'plugins', 'locker');
  mkdirSync(join(locker, 'ui'), { recursive: true });
  writeFileSync(join(locker, 'manifest.json'), JSON.stringify({ id: 'locker', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'ui.lock': true }, ui: { overlay: './ui/lock.js' }, lock: { onStart: true } }));
  writeFileSync(join(locker, 'index.js'), 'export default { activate() {} };\n');
  writeFileSync(join(locker, 'ui', 'lock.js'), 'export default { mount() {} };\n');
  writeFileSync(join(dir, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['echo', 'pin-lock', 'locker'] } }));
  const safe = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--safe-mode', ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  safe.stderr.on('data', (d) => (err += d));
  try {
    const port = await waitFor('порт DevTools окна в безопасном режиме', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)?.[1]);
    const page = await waitFor('окно в безопасном режиме', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    const ev = await connect(page.webSocketDebuggerUrl);
    const main = await connect(await waitFor('инспектор главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(err)?.[1]));
    await waitFor('сводка безопасного режима', async () => /^Безопасный режим:/.test(await ev("document.getElementById('plugins-summary').textContent")));
    assert.equal(await ev("!document.getElementById('safe-mode').hidden && document.getElementById('safe-mode-enter').hidden"), true, 'нет плашки безопасного режима');
    const rows = await ev("[...document.querySelectorAll('#plugins-list [data-plugin]:not([data-state=\"disabled\"])')].map((r) => `${r.dataset.plugin}:${r.dataset.state}:${r.querySelector('.plugin-reason')?.textContent}`)");
    assert.deepEqual(rows.sort(), ['echo', 'locker', 'pin-lock'].map((id) => `${id}:stopped:безопасный режим: код плагинов не запускается`));
    const journal = err.split('\n').filter((l) => l.startsWith('[plugins] {'));
    assert.deepEqual(journal.filter((l) => /"kind":"safe-mode"/.test(l)).length, 3, 'не у каждого плагина запись safe-mode');
    assert.ok(!journal.some((l) => /"kind":"(activated|failed)"/.test(l)), 'в безопасном режиме поднялся хост');
    assert.equal(await ev("document.body.dataset.locked !== 'true' && document.getElementById('lock-layer').hidden"), true, 'lock.onStart закрыл окно в безопасном режиме');
    await ev("[...document.querySelectorAll('#plugins-list [data-plugin=\"echo\"] button')].find((b) => b.textContent === 'Включить снова').click()");
    const refusal = await waitFor('отказ «Включить» в безопасном режиме', () => ev("document.querySelector('#plugins-list [data-plugin=\"echo\"] .plugin-error')?.textContent"));
    assert.match(refusal, /безопасный режим/);
    await main(STUB_RELAUNCH);
    await ev("document.getElementById('safe-mode-exit').click()");
    const relaunched = await waitFor('перезапуск без безопасного режима', () => main('globalThis.smokeRelaunch'));
    assert.ok(!relaunched.includes('--safe-mode'), `выход из безопасного режима оставил флаг: ${relaunched.join(' ')}`);
    log(`безопасный режим: хосты не подняты, lock.onStart не закрыл окно, «Включить» - отказ (${refusal}), выход перезапускает без флага`);
  } finally {
    safe.kill('SIGTERM');
    await Promise.race([new Promise((r) => safe.once('exit', r)), sleep(8000)]);
    if (safe.exitCode === null) safe.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Окно без воркспейса: свой userData, плагины не грузятся, «Недавние» - кнопками. */
async function bareWindow() {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-playground-bare-'));
  const other = join(dir, 'team.cyborg.json');
  writeFileSync(other, '{}');
  writeFileSync(join(dir, 'recent.json'), JSON.stringify({ recent: [other, join(dir, 'пропал.cyborg.json')] }));
  const bare = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--no-workspace', ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  bare.stderr.on('data', (d) => (err += d));
  try {
    const port = await waitFor('порт DevTools окна без воркспейса', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)?.[1]);
    const page = await waitFor('окно без воркспейса', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    const ev = await connect(page.webSocketDebuggerUrl);
    await waitFor('надпись «Воркспейс не открыт»', async () => /Воркспейс не открыт:/.test(await ev("document.getElementById('plugins-summary').textContent")));
    assert.equal(await ev("document.getElementById('workspace-current').textContent"), 'Воркспейс не открыт');
    assert.deepEqual(await ev("[...document.querySelectorAll('#workspace-recent button')].map((b) => b.title)"), [other], 'пропавший файл в «Недавних»');
    assert.equal(await ev("document.querySelectorAll('#plugins-list [data-plugin]').length"), 0, 'плагины загрузились без воркспейса');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cyborg.json'), 'utf8')), defaultConfig(), 'первый запуск: main.ts не записал DEFAULT_CONFIG');
    log('окно без воркспейса: плагины не грузятся, «Недавние» без пропавших файлов, первый запуск записал настройки по умолчанию');
  } finally {
    bare.kill('SIGTERM');
    await Promise.race([new Promise((r) => bare.once('exit', r)), sleep(8000)]);
    if (bare.exitCode === null) bare.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
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
