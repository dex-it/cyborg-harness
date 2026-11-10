// Дымовой тест собранного playground по DevTools Protocol; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { workspaceKey } from '@cyborg-harness/core';
import { buildPlugin } from 'cyborg-plugin';
import { transformSync } from 'esbuild';
import { crashOf } from './crash-reports.mjs';

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
// P-05: шаблон плагина (templates/plugin) собирается тем же инструментом, как его собрал бы автор, и ложится в каталог пользователя рядом.
const templateReport = await buildPlugin(join(repo, 'templates', 'plugin'), { out: join(userData, 'plugins', 'example') });
assert.ok(templateReport.ok, `cyborg-plugin build templates/plugin: ${templateReport.problems.map((p) => p.message).join('; ')}`);
// Плагин, которого не было при старте, ядро включает только после перезапуска, поэтому он входит в plugins.enabled заранее: настройки по умолчанию берутся из main.ts стенда.
// Ветку первого запуска (main.ts записывает DEFAULT_CONFIG сам) проходит bareWindow: у него cyborg.json заранее нет, и он сверяет записанное с DEFAULT_CONFIG.
/** DEFAULT_CONFIG из main.ts: текст объекта идёт через esbuild, который снимает типы (аннотация в объекте не ломает разбор). */
function defaultConfig() {
  const text = /const DEFAULT_CONFIG(?::[^=]+)? = (\{[\s\S]*?\n\});/.exec(readFileSync(join(repo, 'playground', 'src', 'main', 'main.ts'), 'utf8'))?.[1];
  assert.ok(text, 'в main.ts не найден DEFAULT_CONFIG');
  return new Function(`return ${transformSync(`(${text})`, { loader: 'ts' }).code}`)();
}
const userConfig = defaultConfig();
userConfig.plugins.enabled.push('built-dep', 'example');
// K-04: сторонний built-dep назван в группе duo к alice и bob - группа ему не достаётся (запись group-isolated, предупреждение в строке плагина).
userConfig.plugins.uiGroups.duo.push('built-dep');
writeFileSync(join(userData, 'cyborg.json'), JSON.stringify(userConfig, null, 2));

// --inspect=0 - инспектор главного процесса: нажатие оттуда идёт через before-input-event, как с клавиатуры.
// Собранный плагин лежит в каталоге пользователя (P-06), а он читается только с флагом (K-17).
const startedAt = Date.now();
const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', '--user-plugins', ...electronArgs], {
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

  // K-08: меню приложения собрано из снимка ядра (contributes.menus плагина echo); читаем его и нажимаем пункты тем же путём, что нажал бы человек в меню ОС.
  const menuItems = async () =>
    JSON.parse(
      await main(`(() => {
        const { Menu } = process.mainModule.require('electron');
        const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu.items) : [])]);
        return JSON.stringify(flat(Menu.getApplicationMenu()?.items ?? []).filter((i) => i.label.startsWith('Echo:')).map((i) => ({ label: i.label, enabled: i.enabled, type: i.type, checked: i.checked, accelerator: i.accelerator ?? null })));
      })()`),
    );
  const menuItem = async (label) => (await menuItems()).find((i) => i.label === label);
  const clickMenu = (label) =>
    main(`(() => {
      const { Menu } = process.mainModule.require('electron');
      const flat = (items) => items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu.items) : [])]);
      const item = flat(Menu.getApplicationMenu().items).find((i) => i.label === ${JSON.stringify(label)});
      item?.click();
      return !!item;
    })()`);

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
  const KEY_CODES = { Enter: 13, ArrowDown: 40, Tab: 9 };
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
      const frame = page.mainFrame.framesInSubtree.find((f) => f.url.startsWith('cyborg-plugin://') && new URL(f.url).pathname.split('/')[1] === '${id}');
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  // Origin и процесс рендера первого кадра плагина: виды одной группы делят их.
  const frameOf = (id) =>
    main(`(() => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.url.startsWith('cyborg-plugin://') && new URL(f.url).pathname.split('/')[1] === '${id}');
      return frame ? { origin: frame.origin, pid: frame.osProcessId, url: frame.url } : null;
    })()`);
  // Под замком у pin-lock два документа: вид и экран замка; экран - по ?view=overlay.
  const inOverlay = (id, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.url.startsWith('cyborg-plugin://') && new URL(f.url).pathname.split('/')[1] === '${id}' && f.url.includes('view=overlay'));
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

  // Меню окна из вкладов плагина (K-08): пункты на месте, у «отметки» галочка из контракта echo, нажатие выполняет команду и галочка идёт за состоянием.
  await waitFor('меню приложения несёт пункты echo', async () => (await menuItems()).length === 2);
  assert.deepEqual(await menuItem('Echo: пинг'), { label: 'Echo: пинг', enabled: true, type: 'normal', checked: false, accelerator: 'CmdOrCtrl+Alt+E' });
  assert.deepEqual(await menuItem('Echo: отметка'), { label: 'Echo: отметка', enabled: true, type: 'checkbox', checked: false, accelerator: null });
  const pings = async () => (await feed()).filter((l) => /echo жив/.test(l)).length;
  const pinged = await pings();
  assert.equal(await clickMenu('Echo: пинг'), true);
  await waitFor('пункт меню выполнил команду echo.ping', async () => (await pings()) > pinged);
  assert.equal(await clickMenu('Echo: отметка'), true);
  await waitFor('галочка пункта «отметка» пошла за состоянием echo', async () => (await menuItem('Echo: отметка'))?.checked === true);
  assert.equal(await clickMenu('Echo: отметка'), true);
  await waitFor('галочка снята вместе с состоянием', async () => (await menuItem('Echo: отметка'))?.checked === false);
  log('меню приложения: пункты плагина из снимка ядра, нажатие выполняет команду, галочка следует состоянию');

  await waitFor('виды echo, alice и bob во фреймах', async () => (await views()) === 'alice/main,bob/main,built-dep/main,echo/main,editor/main,example/main,panels/bar,panels/panel,pin-lock/main,sessions/main' && (await inView('bob', "document.readyState")) === 'complete' && (await inView('alice', "!!document.getElementById('hello')")) === true);
  // Область вида задаёт манифест, окно раскладывает по раскладке ядра: оба вида panels на своих местах, у каждого свой ctx.view.
  const area = (selector) => ev(`[...document.querySelectorAll(${JSON.stringify(selector + ' [data-plugin]')})].map((f) => f.dataset.plugin + '/' + f.dataset.view).sort().join(',')`);
  assert.equal(await area('#main-view'), 'sessions/main', 'основная область не по манифесту');
  assert.equal(await area('#toolbar-view'), 'panels/bar', 'панель инструментов не по манифесту');
  assert.equal(await area('#views'), 'alice/main,bob/main,built-dep/main,echo/main,editor/main,example/main,panels/panel,pin-lock/main', 'боковая колонка не по манифесту');
  const panelsText = () =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frames = page.mainFrame.framesInSubtree.filter((f) => f.url.startsWith('cyborg-plugin://panels/panels/'));
      return (await Promise.all(frames.map((f) => f.executeJavaScript("document.getElementById('which')?.textContent ?? ''")))).sort().join('|');
    })()`);
  await waitFor('оба вида panels показаны, каждый со своим именем', async () => (await panelsText()) === 'panels/bar: панель инструментов|panels/panel: боковая колонка');
  // T-14: два вида одного плагина - два фрейма со своими адресами ?view=<имя>; фрейм вида находим по адресу, а не по порядку в окне.
  const inPanels = (view, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://panels' && new URL(f.url).searchParams.get('view') === ${JSON.stringify(view)});
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  const panelsUrls = () =>
    main(`(() => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      return page.mainFrame.framesInSubtree.filter((f) => f.origin === 'cyborg-plugin://panels').map((f) => f.url).sort().join('|');
    })()`);
  assert.equal(await panelsUrls(), 'cyborg-plugin://panels/panels/?view=bar|cyborg-plugin://panels/panels/?view=panel', 'у видов panels нет своих адресов ?view=<имя>');
  assert.equal(await inPanels('bar', 'document.getElementById("which").textContent'), 'panels/bar: панель инструментов', 'во фрейме ?view=bar не вид bar');
  assert.equal(await inPanels('panel', 'document.getElementById("which").textContent'), 'panels/panel: боковая колонка', 'во фрейме ?view=panel не вид panel');
  // Свёртка одного вида не прячет другой: кнопка в подписи своей обёртки, документ свёрнутого жив и получает onVisibilityChange.
  const panelsBody = (view) => ev(`document.querySelector('[data-plugin="panels"][data-view="${view}"] .view-body').hidden`);
  const panelsToggle = (view) => ev(`document.querySelector('[data-plugin="panels"][data-view="${view}"] .view-toggle').click()`);
  const visibility = (view) => inPanels(view, 'document.getElementById("visibility").textContent');
  assert.deepEqual([await panelsBody('bar'), await panelsBody('panel')], [false, false], 'виды panels свёрнуты до свёртки');
  await panelsToggle('bar');
  await waitFor('свёрнутый bar получил onVisibilityChange', async () => (await visibility('bar')) === 'скрыт');
  assert.deepEqual([await panelsBody('bar'), await panelsBody('panel')], [true, false], 'свёртка bar спрятала panel или не спрятала bar');
  assert.equal(await visibility('panel'), 'показан', 'свёртка bar дошла до panel');
  await panelsToggle('bar');
  await waitFor('развёрнутый bar снова показан', async () => (await visibility('bar')) === 'показан');
  await panelsToggle('panel');
  await waitFor('свёрнутый panel получил onVisibilityChange', async () => (await visibility('panel')) === 'скрыт');
  assert.deepEqual([await panelsBody('bar'), await panelsBody('panel')], [false, true], 'свёртка panel спрятала bar или не спрятала panel');
  assert.equal(await visibility('bar'), 'показан', 'свёртка panel дошла до bar');
  await panelsToggle('panel');
  await waitFor('развёрнутый panel снова показан', async () => (await visibility('panel')) === 'показан');
  // Диалог из второго вида встаёт у фрейма своего вида: меню bar отвечает bar, а положение считается от его фрейма (первый по порядку вид тут - bar, поэтому panel проверяем отдельно).
  const menuAt = () =>
    ev(`(() => {
      const d = document.querySelector('dialog.layer-menu[open]');
      return d ? { plugin: d.dataset.plugin, left: parseFloat(d.style.left), top: parseFloat(d.style.top), width: d.getBoundingClientRect().width, height: d.getBoundingClientRect().height } : null;
    })()`);
  const frameBox = (view) => ev(`(() => { const r = document.querySelector('[data-plugin="panels"][data-view="${view}"] iframe').getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
  const innerSize = () => ev('({ width: window.innerWidth, height: window.innerHeight })');
  // Вкладка «Виды» закрыта по умолчанию: у скрытого фрейма положение нулевое, и привязку к нему не отличить от отсутствия. Открываем её на время проверки.
  await ev("document.getElementById('tab-views').click()");
  for (const view of ['panel', 'bar']) {
    await inPanels(view, 'document.getElementById("menu").click()');
    const shown = await waitFor(`меню вида ${view} в слое окна`, async () => (await menuAt())?.plugin === 'panels' && (await menuAt()));
    const base = await frameBox(view);
    const inner = await innerSize();
    // Как в слое окна: точка (4, 4) вида плюс положение фрейма именно этого вида, не дальше края окна.
    const wantLeft = Math.max(0, Math.min(base.left + 4, inner.width - shown.width));
    const wantTop = Math.max(0, Math.min(base.top + 4, inner.height - shown.height));
    assert.ok(Math.abs(shown.left - wantLeft) < 1 && Math.abs(shown.top - wantTop) < 1, `меню вида ${view} встало не у его фрейма: ${JSON.stringify(shown)}, ждали ${wantLeft},${wantTop}`);
    await ev("document.querySelector('dialog.layer-menu[open] button[data-choice=\"copy\"]').click()");
    await waitFor(`ответ меню дошёл до вида ${view}, а не до соседа`, async () => (await inPanels(view, 'document.getElementById("answer").textContent')) === 'copy');
  }
  const barBox = await frameBox('bar');
  const panelBox = await frameBox('panel');
  assert.ok(barBox.left !== panelBox.left || barBox.top !== panelBox.top, 'фреймы bar и panel стоят в одной точке: привязку диалога к фрейму вида не отличить');
  assert.ok(panelBox.left > 0 || panelBox.top > 0, 'фрейм panel скрыт (положение 0, 0): привязку диалога к нему не отличить');
  await ev("document.getElementById('tab-plugins').click()");
  log('panels: два вида во фреймах со своими ?view=, независимая свёртка, меню у фрейма своего вида');
  assert.equal(await inView('alice', 'typeof window.playground'), 'undefined', 'вид получил мост окна');
  await inView('alice', "document.getElementById('hello').click()");
  await waitFor('вид alice → чат → вид bob', async () => /→ привет, bob/.test(await viewLog('alice')) && /← alice: привет, bob/.test(await viewLog('bob')));
  // K-04: alice и bob в одной группе, но лента каждого вида - только его плагина.
  assert.ok(!/← alice: привет, bob/.test(await viewLog('alice')), 'строка bob попала в вид alice');
  assert.ok(!/→ привет, bob/.test(await viewLog('bob')), 'строка alice попала в вид bob');
  await inView('bob', "document.getElementById('foreign').click()");
  await waitFor('чужая команда из вида bob отклонена', async () => /отказ: alice\.hello: не команда плагина bob/.test(await viewLog('bob')));
  assert.equal(await inView('bob', 'window.cyborgView.drop()'), null, 'вид получил путь без перетаскивания');
  log('виды во фреймах: свой мост, лента плагина, чужая команда отклонена');

  // K-04: группы рендера. alice и bob - один origin и один процесс рендера, echo - другая группа и другой процесс; сторонний built-dep группу не получил.
  const [aliceFrame, bobFrame, echoFrame, builtFrame] = await Promise.all([frameOf('alice'), frameOf('bob'), frameOf('echo'), frameOf('built-dep')]);
  assert.deepEqual([aliceFrame?.origin, bobFrame?.origin, echoFrame?.origin, builtFrame?.origin], ['cyborg-plugin://duo', 'cyborg-plugin://duo', 'cyborg-plugin://echo', 'cyborg-plugin://solo_built-dep']);
  assert.match(aliceFrame.url, /^cyborg-plugin:\/\/duo\/alice\/\?view=main$/, 'адрес вида не несёт плагина в пути');
  assert.ok(aliceFrame.pid && aliceFrame.pid === bobFrame.pid, `виды одной группы в разных процессах рендера: ${String(aliceFrame.pid)} и ${String(bobFrame.pid)}`);
  assert.ok(echoFrame.pid !== aliceFrame.pid && builtFrame.pid !== aliceFrame.pid && echoFrame.pid !== builtFrame.pid, 'виды разных групп делят процесс рендера');
  // Адрес кадра можно сменить без загрузки (history.pushState): плагин вне группы кадра мост не признаёт, сосед по группе - признаёт (граница доверия - группа).
  const asAt = (path, command) =>
    inView('alice', `(async () => { history.pushState({}, '', ${JSON.stringify(path)}); try { return await window.cyborgView.run(${JSON.stringify(command)}); } finally { history.replaceState({}, '', '/alice/?view=main'); } })()`);
  assert.deepEqual(await asAt('/echo/', 'echo.ping'), { error: 'не вид плагина' }, 'вид группы вызвал команду плагина вне группы подменой адреса');
  assert.deepEqual(await asAt('/built-dep/', 'echo.ping'), { error: 'не вид плагина' }, 'вид группы назвался сторонним плагином');
  assert.equal((await asAt('/bob/', 'alice.hello'))?.error, 'alice.hello: не команда плагина bob', 'вид alice, назвавшийся bob, прошёл как alice');
  assert.equal(await inView('alice', 'location.pathname'), '/alice/', 'адрес кадра не вернулся');
  assert.match(await text('#plugins-list [data-plugin="built-dep"] .plugin-group-note'), /сторонний плагин не делит группу рендера: группа duo не действует, работает в своей built-dep/, 'нет предупреждения о группе у built-dep');
  assert.equal(await text('#plugins-list [data-plugin="alice"] .plugin-group'), 'группа duo');
  assert.equal(await ev(`document.querySelector('#plugins-list [data-plugin="echo"] .plugin-group') === null`), true, 'у плагина в своей группе метка группы');
  assert.ok(lines().some((l) => l.includes('"pluginId":"built-dep","kind":"group-isolated","group":"duo","renderGroup":"built-dep"')), 'нет записи group-isolated у built-dep');
  log('группы рендера: alice и bob в одном процессе рендера, echo и built-dep в своих; подмена адреса вне группы отклонена; предупреждение у стороннего');

  // K-05: закрытая CSP вида и флаг ui.inlineStyles. echo, alice и bob флага не объявили, sessions и editor объявили (xterm и Monaco).
  const viewCspHeader = (id) => inView(id, 'fetch(location.href).then((r) => r.headers.get("content-security-policy"))');
  const STRICT = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'";
  const WITH_INLINE = STRICT.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
  for (const id of ['echo', 'alice', 'bob']) assert.equal(await viewCspHeader(id), STRICT, `${id}: CSP вида без флага не строгая`);
  for (const id of ['sessions', 'editor']) assert.equal(await viewCspHeader(id), WITH_INLINE, `${id}: с флагом CSP не несёт инлайн-стилей`);
  assert.equal(await viewCspHeader('built-dep'), STRICT, 'сторонний плагин без флага: строгая CSP');
  // Инлайн-стиль: <style> и атрибут style в разметке без флага не применяются, с флагом - применяются; запись через CSSOM CSP не касается.
  const inlineStyle = (id) =>
    inView(id, `(() => {
      const box = document.createElement('div');
      document.body.append(box);
      const sheet = document.createElement('style');
      sheet.textContent = 'div.k05-probe { margin-left: 7px; }';
      box.className = 'k05-probe';
      document.head.append(sheet);
      const byElement = getComputedStyle(box).marginLeft;
      sheet.remove();
      box.setAttribute('style', 'margin-left: 9px');
      const byAttribute = getComputedStyle(box).marginLeft;
      box.removeAttribute('style');
      box.style.marginLeft = '11px';
      const byCssom = getComputedStyle(box).marginLeft;
      box.remove();
      return JSON.stringify({ byElement, byAttribute, byCssom });
    })()`);
  assert.deepEqual(JSON.parse(await inlineStyle('echo')), { byElement: '0px', byAttribute: '0px', byCssom: '11px' }, 'вид без флага применил инлайн-стиль');
  assert.deepEqual(JSON.parse(await inlineStyle('alice')), { byElement: '0px', byAttribute: '0px', byCssom: '11px' }, 'вид без флага применил инлайн-стиль');
  assert.deepEqual(JSON.parse(await inlineStyle('sessions')), { byElement: '7px', byAttribute: '9px', byCssom: '11px' }, 'вид с флагом не применил инлайн-стиль');
  // #160: отказ CSP не молчит - строка с подсказкой про ui.inlineStyles в журнале плагина-владельца (echo и alice без флага, sessions с флагом не отказан).
  // Цикл вставок не раздувает журнал: одинаковые отказы склеиваются в одну запись с repeats.
  await waitFor(
    'в журнале echo отказ CSP с подсказкой про ui.inlineStyles',
    () => lines().some((l) => l.includes('"pluginId":"echo","kind":"denied","method":"csp"') && l.includes('"reason":"csp"') && l.includes('inlineStyles')),
  );
  await inView('echo', `(() => { for (let i = 0; i < 200; i++) { const sheet = document.createElement('style'); sheet.textContent = 'div { margin: 1px; }'; document.head.append(sheet); sheet.remove(); } return 1; })()`);
  await sleep(500);
  assert.ok(lines().filter((l) => l.includes('"pluginId":"echo","kind":"denied","method":"csp"')).length <= 3, 'поток отказов CSP раздул журнал echo');
  assert.ok(!lines().some((l) => l.includes('"pluginId":"sessions","kind":"denied","method":"csp"') && l.includes('inlineStyles')), 'sessions с флагом получил отказ на инлайн-стиль');
  // Встроенный скрипт не выполняется ни с флагом, ни без.
  for (const id of ['echo', 'sessions'])
    assert.equal(await inView(id, "(() => { const s = document.createElement('script'); s.textContent = 'window.k05Inline = 1'; document.head.append(s); s.remove(); return typeof window.k05Inline; })()"), 'undefined', `${id}: встроенный скрипт выполнился`);
  // Запросы наружу и на чужой origin блокирует CSP, а не сеть: на стороне сервера ни одного запроса.
  let outside = 0;
  const server = createServer((_request, response) => {
    outside++;
    response.writeHead(200, { 'access-control-allow-origin': '*' }).end('x');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const outsideUrl = `http://127.0.0.1:${server.address().port}/k05`;
  const reach = (id, url) =>
    inView(id, `(async () => {
      const seen = [];
      document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
      const result = await fetch(${JSON.stringify(url)}, { mode: 'no-cors' }).then(() => 'ушёл', (e) => e.name);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return JSON.stringify({ result, seen });
    })()`);
  try {
    for (const id of ['echo', 'sessions']) {
      assert.deepEqual(JSON.parse(await reach(id, outsideUrl)), { result: 'TypeError', seen: ['connect-src'] }, `${id}: запрос в сеть не заблокирован CSP`);
      assert.deepEqual(JSON.parse(await reach(id, 'cyborg-plugin://duo/alice/ui/ui.js')), { result: 'TypeError', seen: ['connect-src'] }, `${id}: запрос на origin чужой группы не заблокирован CSP`);
    }
    assert.equal(
      await inView('echo', `new Promise((resolve) => { const i = new Image(); i.onerror = () => resolve('блок'); i.onload = () => resolve('загрузилась'); i.src = ${JSON.stringify(outsideUrl)}; })`),
      'блок',
      'картинка из сети загрузилась',
    );
    assert.equal(await inView('echo', 'fetch(location.href).then((r) => r.status)'), 200, 'свой origin вид читает');
    // #161: default-src не покрывает base-uri и form-action, они закрыты явно. <base href> не меняет адрес относительных запросов вида,
    // отправка формы отклонена CSP (form-action), и сервер снаружи запроса не получает (счёт outside проверяется ниже).
    assert.deepEqual(
      JSON.parse(
        await inView('echo', `new Promise((resolve) => {
          const seen = [];
          document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
          const before = document.baseURI;
          const base = document.createElement('base');
          base.href = 'http://127.0.0.1:1/k161/';
          document.head.append(base);
          const baseChanged = document.baseURI !== before || new URL('x.js', document.baseURI).origin !== location.origin;
          base.remove();
          const form = document.createElement('form');
          form.method = 'get';
          form.action = ${JSON.stringify(outsideUrl)};
          document.body.append(form);
          form.submit();
          setTimeout(() => { form.remove(); resolve(JSON.stringify({ baseChanged, seen: [...new Set(seen)].sort() })); }, 300);
        })`),
      ),
      { baseChanged: false, seen: ['base-uri', 'form-action'] },
      '<base href> сменил адреса вида или форма ушла наружу',
    );
    await sleep(300);
    assert.equal(outside, 0, 'запрос вида дошёл до сервера снаружи');
  } finally {
    server.close();
  }
  // Сосед по группе в <iframe> не встраивается: frame-src берётся из default-src 'none'. Но CSP по плагину границей внутри группы не является (K-04, #150):
  // кадры группы делят origin, и вид читает и меняет документ соседа через parent.frames - граница доверия группа, а не CSP плагина.
  assert.deepEqual(
    JSON.parse(
      await inView('alice', `(async () => {
        const seen = [];
        document.addEventListener('securitypolicyviolation', (e) => seen.push(e.effectiveDirective));
        const frame = document.createElement('iframe');
        frame.src = '/bob/?view=main';
        document.body.append(frame);
        await new Promise((resolve) => setTimeout(resolve, 600));
        const embedded = (() => { try { return frame.contentWindow.location.pathname === '/bob/'; } catch { return false; } })();
        frame.remove();
        return JSON.stringify({ seen, embedded });
      })()`),
    ),
    { seen: ['frame-src'], embedded: false },
    'вид встроил соседа по группе в <iframe>',
  );
  const neighbour = JSON.parse(
    await inView('alice', `(() => {
      const names = [];
      for (let i = 0; i < parent.length; i++) {
        try { names.push(parent.frames[i].location.pathname); } catch { names.push('закрыт'); }
      }
      const bob = [...Array(parent.length).keys()].map((i) => parent.frames[i]).find((w) => { try { return w.location.pathname === '/bob/'; } catch { return false; } });
      const title = bob?.document.title;
      return JSON.stringify({ names, title, echoHidden: names.includes('/echo/') });
    })()`),
  );
  assert.equal(neighbour.title, 'bob: main', 'вид alice не дотянулся до документа соседа bob: группа не граница?');
  assert.ok(neighbour.names.includes('/bob/') && neighbour.names.includes('закрыт'), `кадры окна: ${neighbour.names.join(', ')}`);
  assert.equal(neighbour.echoHidden, false, 'вид группы duo дотянулся до echo из другой группы');
  log('K-05: CSP вида default-src \'none\' на ответе, инлайн-стили только у sessions и editor, встроенный скрипт и запросы наружу и на чужой origin заблокированы, сосед по группе не встраивается, но его документ из группы доступен');

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
  assert.ok(!/вид alice/.test(await viewLog('alice')), 'свёрнутый вид bob дошёл до кадров alice в той же группе');
  await toggle();
  await waitFor('развёрнутый вид получил onVisibilityChange', async () => /вид снова показан/.test(await viewLog('bob')));
  assert.ok(!/вид alice/.test(await viewLog('alice')), 'развёрнутый вид bob дошёл до кадров alice в той же группе');
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
  log('ctx.os.pty: процесс в pty-хосте, вывод в хост плагина, размер дошёл до терминала');

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
  await waitFor('на месте вида снятой alice - заглушка с причиной', async () => (await views()) === 'bob/main,built-dep/main,echo/main,editor/main,example/main,panels/bar,panels/panel,pin-lock/main,sessions/main' && /выгружен вместе с chat/.test(await text('#views [data-plugin="alice"] .view-reason')));
  assert.ok(await ev(`[...document.querySelectorAll('#views [data-plugin="alice"] button')].some((b) => b.textContent === 'Журнал')`), 'у заглушки нет «Журнал»');
  assert.equal((await keyRow(combo('A')))?.live, 'false');
  await press(combo('A'));
  await waitFor('сочетание выгруженной alice дошло до окна', () => feedHas(re('A', 'до окна дошло')));
  assert.equal(await button('chat', 'Загрузить'), true, 'у выгруженного chat нет «Загрузить»');
  await waitFor('chat и alice вернулись, bob переподписался', async () =>
    (await states({ chat: 'active', alice: 'active' })) && lines().includes('[plugins] bob: чат вернулся, подписываюсь снова'),
  );
  assert.notEqual(await pid('chat'), chatPid, 'после выгрузки chat должен подняться в новом процессе');
  await waitFor('вид alice вернулся', async () => (await views()) === 'alice/main,bob/main,built-dep/main,echo/main,editor/main,example/main,panels/bar,panels/panel,pin-lock/main,sessions/main');
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

  // Г2 (FR-CH-4001): вызов моста из вида в окне попадает в трассу и в файл диагностики; сам вид (`ctx.commands.run('echo.terminal')` и `ctx.terminal.open`) вызывает мост при подключении терминала.
  const bridgeOps = () =>
    existsSync(join(userData, 'diagnostics'))
      ? readdirSync(join(userData, 'diagnostics')).flatMap((dir) => {
          const file = join(userData, 'diagnostics', dir, 'diagnostics.log');
          if (!existsSync(file)) return [];
          return readFileSync(file, 'utf8')
            .split('\n')
            .flatMap((line) => {
              try {
                const stored = JSON.parse(line);
                return stored.src === 'trace' && stored.record.kind === 'operation' && stored.record.caller === 'view:echo' && stored.record.boundaries.includes('bridge') ? [stored.record] : [];
              } catch {
                return [];
              }
            });
        })
      : [];
  const viaBridge = await waitFor('запись трассы с границей bridge от вида echo в файле диагностики', () => bridgeOps().find((r) => r.target === 'command:echo.terminal'));
  assert.equal(viaBridge.outcome, 'ok');
  assert.ok(viaBridge.boundaries.includes('bridge') && viaBridge.chain > 0, `границы: ${viaBridge.boundaries.join(',')}`);
  assert.ok(bridgeOps().some((r) => r.target === 'bridge:view.terminal'), 'открытие терминала видом - тоже запись Г2');
  log('трасса Г2: вызов моста из вида echo в окне записан с границей bridge в файл диагностики');

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
    // Выгруженный плагин: пункты в меню остаются, но недоступны.
    await waitFor('пункты echo недоступны, но не убраны', async () => (await menuItems()).length === 2 && (await menuItems()).every((i) => !i.enabled));
    assert.equal(await alive(sh), true, 'оставленный процесс завершён');
    const kept = () => text('#plugins-list [data-plugin="echo"] .plugin-kept');
    await waitFor('строка echo показывает оставленный процесс', async () => (await kept()).includes(`/bin/sh - pid ${sh}`));
    assert.equal(await load(), true);
    await waitFor('пункты echo снова доступны', async () => (await menuItems()).every((i) => i.enabled));
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

    // pty-хост (K-01) - процесс ядра, а не хост плагинов: зависание node-pty не замораживает окно и виды, сторож убивает его, владельцы получают выход.
    const ptyHostPid = async () => Number(await main("process.mainModule.require('electron').app.getAppMetrics().find((m) => m.name === 'Cyborg pty')?.pid ?? 0"));
    const stat = (p) => main(`(() => { try { return process.mainModule.require('child_process').execSync('ps -o stat= -p ${p}').toString().trim(); } catch { return ''; } })()`);
    const frozen = await waitFor('pty-хост запущен', ptyHostPid);
    await main(`process.kill(${frozen}, 'SIGSTOP')`);
    await waitFor('pty-хост остановлен SIGSTOP', async () => /^T/.test(await stat(frozen)));
    const asked = Date.now();
    assert.equal(await ev('1 + 1'), 2, 'окно не отвечает при остановленном pty-хосте');
    assert.equal(await main('1 + 1'), 2, 'главный процесс не отвечает при остановленном pty-хосте');
    assert.equal(await inView('alice', 'document.readyState'), 'complete', 'вид другого плагина не отвечает при остановленном pty-хосте');
    assert.ok(Date.now() - asked < 1500, `остановленный pty-хост задержал окно на ${String(Date.now() - asked)} мс`);
    await waitFor('сторож признал pty-хост зависшим', async () => /pty-хост завис/.test(await text('#plugins-journal')));
    await waitFor('pty-хост перезапущен', async () => /pty-хост перезапущен/.test(await text('#plugins-journal')) && (await ptyHostPid()) !== frozen && (await ptyHostPid()) > 0);
    assert.equal(await stat(frozen), '', 'зависший pty-хост не убит');
    await waitFor('владелец терминала получил выход потерянного pty', async () => /вышел с -1/.test(await inView('echo', "document.getElementById('term-state').textContent")));
    await inView('echo', "document.getElementById('connect').click()");
    await waitFor('новый терминал echo на перезапущенном pty-хосте', async () => /^pty \d+$/.test(await inView('echo', "document.getElementById('term-state').textContent")));
    await type('echo после-pty-хоста-$((3*5))');
    await waitFor('новый spawn после перезапуска pty-хоста работает', async () => /после-pty-хоста-15/.test(await screen()));
    log('pty-хост: SIGSTOP не замораживает окно, главный процесс и виды; сторож убил и перезапустил его, владелец получил выход, новый терминал работает');

    // Поток 4 МиБ до моста вида: порт из pty-хоста во фрейм, без главного процесса на пути (замер - npm run spike:pty-stream).
    const stream = await inView(
      'echo',
      `(async () => {
        const bridge = window.cyborgView;
        const ticket = (await bridge.run('echo.terminal', [])).value;
        const opened = (await bridge.terminalOpen(ticket)).value;
        let seen = 0;
        let messages = 0;
        let first = 0;
        let done;
        const finished = new Promise((r) => (done = r));
        bridge.onTerminal((event) => {
          if (event.tid !== opened.tid || !('data' in event)) return;
          const q = event.data.split('Q').length - 1;
          if (q === 0) return;
          if (first === 0) first = performance.now();
          messages++;
          seen += q;
          if (seen >= 4194305) done(performance.now());
        });
        await bridge.terminalWrite(opened.tid, "dd if=/dev/zero bs=1048576 count=4 2>/dev/null | tr '\\\\0' 'Q'\\r");
        const last = await Promise.race([finished, new Promise((r) => setTimeout(() => r(0), 30000))]);
        bridge.terminalClose(opened.tid);
        return { seen, messages, ms: last - first };
      })()`,
    );
    assert.ok(stream.seen >= 4194305, `до вида дошло ${String(stream.seen)} из 4194305 символов потока`);
    log(`поток 4 МиБ до моста вида по порту: ${stream.ms.toFixed(0)} мс, ${String(stream.messages)} сообщений`);
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
  // Кросс-доменный фрейм вне видимой части колонки Chromium не рисует (Monaco не выкладывает строки): вида стало больше, и на небольшом окне CI редактор оказывается ниже края.
  await ev(`document.querySelector('#views [data-plugin="editor"]')?.scrollIntoView({ block: 'start' })`);
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
      const item = find(Menu.getApplicationMenu()?.items ?? [])[0];
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
  const kit = await inView('echo', `(() => {
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
  log('элементы ядра (вид echo без флага инлайн-стилей): определены до mount, стили под CSP вида, клавиши и события списка, дерева и вкладок, disabled у кнопки');

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
    // #194: просьба плагина активировать вкладку (ctx.documents.reveal) доходит до окна по каналу documents:reveal. Ядро и службу проверяют тесты;
    // здесь последний шаг цепочки в настоящем окне: мост preload, панель «Документы» выходит вперёд, строка документа помечена активной.
    await ev("document.getElementById('tab-plugins').click()");
    const tabState = () => ev("document.getElementById('tab-documents').getAttribute('aria-selected') + ':' + String(document.querySelector('#documents-list .document-row').getAttribute('aria-current'))");
    assert.equal(await tabState(), 'false:null', 'до просьбы панель «Документы» не выбрана и строка не помечена');
    const docId = await ev("document.querySelector('#documents-list .document-row').dataset.document");
    await main(`(() => { const { webContents } = process.mainModule.require('electron'); webContents.getAllWebContents().find((w) => w.getType() === 'window').send('documents:reveal', ${JSON.stringify(docId)}); })()`);
    await waitFor('просьба reveal выбрала панель «Документы» и пометила вкладку сессии', async () => (await tabState()) === 'true:true');
    await ev("document.getElementById('tab-plugins').click()");
    await main(`(() => { const { webContents } = process.mainModule.require('electron'); webContents.getAllWebContents().find((w) => w.getType() === 'window').send('documents:reveal', ${JSON.stringify(docId)}); })()`);
    await waitFor('повторная просьба снова возвращает человека на вкладку', async () => (await tabState()) === 'true:true');
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

  // P-05: плагин из шаблона активен, его вид открыт, кнопка вида выполняет команду main-части и показывает ответ (значение config по умолчанию).
  assert.equal(await state('example'), 'active', 'плагин из шаблона не включился');
  await waitFor('вид шаблона открыт: в нём кнопка cy-button', async () => (await inView('example', "document.getElementById('hello')?.localName")) === 'cy-button');
  await inView('example', "document.getElementById('hello').click()");
  await waitFor('ответ команды example.hello в виде шаблона', async () => (await inView('example', "document.getElementById('answer')?.textContent")) === 'привет');
  log('шаблон плагина: собран cyborg-plugin, активен, вид открыт, команда из вида ответила');
  // K-13: канал «главная часть - вид». Толчок идёт виду panel и не доходит до bar (тот же плагин, другое имя вида); окно перезагружается, и канал связывается заново.
  const inViewNamed = (id, view, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://${id}' && new URL(f.url).searchParams.get('view') === ${JSON.stringify(view)});
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  const pushes = (view) => inViewNamed('panels', view, "document.getElementById('pushed')?.textContent ?? null");
  const ping = () => ev("window.playground.runCommand('panels.ping')");
  await waitFor('виды panels смонтированы', async () => (await pushes('panel')) === 'толчков: 0' && (await pushes('bar')) === 'толчков: 0');
  assert.deepEqual(await ping(), {});
  await waitFor('толчок главной части дошёл до вида panel без опроса', async () => (await pushes('panel')) === 'толчков: 1');
  await sleep(300);
  assert.equal(await pushes('bar'), 'толчков: 0', 'толчок для panel дошёл до bar того же плагина');
  await inViewNamed('panels', 'panel', "document.getElementById('reply').click()");
  await waitFor('сообщение вида panel дошло до главной части', () => lines().some((l) => l.includes('panels: вид panel сообщил: {"from":"panel"}')));
  const allViews = await views();
  await ev.send('Page.reload');
  await waitFor('виды после перезагрузки окна', async () => (await views().catch(() => '')) === allViews && (await pushes('panel').catch(() => null)) === 'толчков: 0', 30_000);
  assert.deepEqual(await ping(), {});
  await waitFor('после перезагрузки окна вид panel снова получает толчки главной части', async () => (await pushes('panel')) === 'толчков: 2');
  log('канал «главная часть - вид»: толчок доходит только до вида с этим именем, ответ вида - до главной части, после перезагрузки окна канал связан заново');

  // K-13: модальное окно плагина. Вид form с area "modal" встаёт слоем поверх окна, остальное inert, фокус заперт, результат уходит владельцу, Escape закрывает.
  const modalOpen = () => ev("!!document.querySelector('dialog.layer-modal[open]')");
  const inForm = (expression) => inViewNamed('panels', 'form', expression);
  await ev("(window.__form = window.playground.runCommand('panels.form'), 0)");
  await waitFor('модальное окно показано слоем окна', modalOpen);
  assert.equal(await ev("document.querySelector('dialog.layer-modal').matches(':modal')"), true, 'окно не в верхнем слое');
  assert.equal(await ev("document.querySelector('dialog.layer-modal').getAttribute('aria-label')"), 'Новый проект', 'название окна не от главной части');
  assert.equal(await ev("document.getElementById('playground').inert"), true, 'виды под окном не inert');
  assert.equal(await ev("document.activeElement?.closest('dialog.layer-modal') !== null"), true, 'фокус не в модальном окне');
  await waitFor('вид окна получил данные главной части', async () => (await inForm("document.getElementById('name')?.value ?? null")) === 'черновик');
  // Tab не уходит из окна: фокус остаётся внутри диалога после каждого нажатия, в том числе на выходе из фрейма вида (раннер macOS не держит фокус окна сам).
  await ev("window.focus(), document.querySelector('dialog.layer-modal iframe').focus()");
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await tap(key);
    await waitFor(`после ${key} фокус в модальном окне`, () => ev("document.activeElement?.closest('dialog.layer-modal') !== null && !document.activeElement.classList.contains('layer-modal-trap')"));
  }
  await inForm("(document.getElementById('name').value = 'Проект', document.getElementById('create').click())");
  assert.deepEqual(await ev('window.__form'), { value: { name: 'Проект' } }, 'результат вида не дошёл до владельца');
  await waitFor('окно снято после результата', async () => !(await modalOpen()));
  assert.equal(await ev("document.getElementById('playground').inert"), false, 'виды остались inert после закрытия окна');
  assert.ok(lines().some((l) => l.includes('panels: форма вернула: {"name":"Проект"}')), 'главная часть не записала результат');

  await ev("(window.__form = window.playground.runCommand('panels.form'), 0)");
  await waitFor('окно показано снова', modalOpen);
  await press('Escape');
  assert.deepEqual(await ev('window.__form'), {}, 'Escape не вернул владельцу undefined');
  await waitFor('Escape закрыл окно', async () => !(await modalOpen()));
  assert.ok(lines().some((l) => l.includes('panels: форма вернула: ничего')), 'владелец не узнал об отмене');

  // #163: размер окна от автора и Escape, оставленный виду. Окно 700 x 300; Escape доходит до вида и окно не закрывает, закрывает кнопка вида.
  await ev("(window.__own = window.playground.runCommand('panels.form-own'), 0)");
  await waitFor('окно с размером автора показано', modalOpen);
  assert.equal(await ev("document.querySelector('dialog.layer-modal').style.width"), 'min(700px, 90vw)', 'размер окна не от автора');
  assert.equal(await ev("document.querySelector('dialog.layer-modal').dataset.escape"), 'view', 'слой не знает, что Escape у вида');
  const ownBox = await ev("(() => { const r = document.querySelector('dialog.layer-modal').getBoundingClientRect(); return { width: r.width, height: r.height, vw: window.innerWidth, vh: window.innerHeight }; })()");
  assert.ok(Math.abs(ownBox.width - Math.min(700, ownBox.vw * 0.9)) <= 2 && Math.abs(ownBox.height - Math.min(300, ownBox.vh * 0.8)) <= 2, `размер окна на экране не 700 x 300: ${JSON.stringify(ownBox)}`);
  await waitFor('вид окна смонтирован', async () => (await inForm("document.getElementById('escaped') !== null")) === true);
  // Две половины одного пути. Главный процесс видит настоящее нажатие Escape (sendInputEvent, тот же вход, что у `press` выше) и не гасит его: окно остаётся.
  await main(`(() => {
    const { webContents } = process.mainModule.require('electron');
    const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
    globalThis.__escapeSeen = [];
    // Слушатель добавлен после слушателя bindWindow: к его вызову нажатие уже погашено, если ядро решило его взять.
    page.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') globalThis.__escapeSeen.push({ kind: typeof event.defaultPrevented, prevented: event.defaultPrevented });
    });
  })()`);
  await press('Escape');
  await waitFor('главный процесс получил Escape', async () => (await main('globalThis.__escapeSeen.length')) === 1);
  assert.deepEqual(await main('globalThis.__escapeSeen'), [{ kind: 'boolean', prevented: false }], 'главный процесс погасил Escape, который окно оставило виду');
  assert.equal(await modalOpen(), true, 'Escape закрыл окно, которое оставило его виду');
  // Вторая половина: клавиша, пришедшая во фрейм вида, доходит до его обработчика (как для Monaco, через протокол DevTools и программный фокус).
  await ev("document.querySelector('dialog.layer-modal iframe').focus()");
  await main("process.mainModule.require('electron').webContents.getAllWebContents().find((w) => w.getType() === 'window').focus()");
  await inForm("document.getElementById('name').focus()");
  for (const type of ['rawKeyDown', 'keyUp']) await ev.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor('Escape дошёл до вида', async () => (await inForm("document.getElementById('escaped')?.textContent ?? null")) === 'Escape получил вид');
  assert.equal(await modalOpen(), true, 'вид получил Escape, но окно закрылось само');
  await inForm("document.getElementById('cancel').click()");
  await waitFor('окно снято кнопкой вида', async () => !(await modalOpen()));
  assert.deepEqual(await ev('window.__own'), {}, 'владелец не получил undefined');

  // Диалог из главной части без вида (ctx.dialogs.show): очередь окна та же, что у диалогов видов.
  await ev("(window.__confirm = window.playground.runCommand('panels.confirm'), 0)");
  await waitFor('вопрос главной части показан', () => ev("!!document.querySelector('dialog.layer-ask[data-plugin=\"panels\"] [data-choice=\"yes\"]')"));
  await ev("document.querySelector('dialog.layer-ask[data-plugin=\"panels\"] [data-choice=\"yes\"]').click()");
  assert.deepEqual(await ev('window.__confirm'), { value: 'yes' }, 'ответ человека не дошёл до главной части');
  log('модальное окно плагина: поверх окна, остальное inert, фокус заперт, результат и Escape доходят владельцу; диалог главной части отвечает');

  const lock = JSON.parse(readFileSync(join(userData, 'workspace.cyborg.json.lock'), 'utf8'));
  assert.equal(typeof lock.pid, 'number', 'замок воркспейса без pid');
  const askedBefore = await main('globalThis.playgroundSecondLaunches');
  const second = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--user-data-dir=${userData}`, ...electronArgs], { stdio: 'ignore' });
  const code = await Promise.race([new Promise((r) => second.once('exit', r)), sleep(15000).then(() => 'висит')]);
  if (code === 'висит') second.kill('SIGKILL');
  assert.equal(code, 0, 'второй экземпляр на том же воркспейсе не ушёл сам (код 3 - владелец не ответил)');
  assert.equal(await main('globalThis.playgroundSecondLaunches'), askedBefore + 1, 'владелец не получил запрос на подъём окна: код 0 второго процесса этого не доказывает');
  assert.equal(app.exitCode, null, 'первый экземпляр закрылся вместе со вторым');
  assert.equal(await state('echo'), 'active');
  assert.match(await text('#workspace-current'), /workspace\.cyborg\.json$/);
  const recent = JSON.parse(readFileSync(join(userData, 'recent.json'), 'utf8')).recent;
  assert.ok(recent.some((f) => f.endsWith('workspace.cyborg.json')), 'открытый воркспейс не попал в «Недавние»');
  log('воркспейс: замок с pid, второй запуск отдаёт фокус первому и уходит, открытый - в «Недавних»');

  await sharedUserData({ ev, main, state });

  await main(STUB_RELAUNCH);
  assert.equal(await ev("document.getElementById('safe-mode').hidden"), true, 'плашка безопасного режима без флага');
  await ev("document.getElementById('safe-mode-enter').click()");
  const relaunched = await waitFor('перезапуск в безопасном режиме', () => main('globalThis.smokeRelaunch'));
  assert.ok(relaunched.includes('--safe-mode'), `перезапуск без --safe-mode: ${relaunched.join(' ')}`);
  log('безопасный режим: пункт окна перезапускает приложение с --safe-mode');

  await bareWindow();
  await safeWindow();
  await userPluginsWindow();
  await diagnosticsWindow();
  await ptyExitWindow();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lockPid = (file) => {
  try {
    return JSON.parse(readFileSync(`${file}.lock`, 'utf8')).pid;
  } catch {
    return undefined;
  }
};

/**
 * K-20, проверка P9: два процесса, два воркспейса, один userData. Первый процесс - основной экземпляр smoke (воркспейс по умолчанию),
 * второй поднимается рядом с `--workspace=<другой файл>`; третий открывается из окна первого действием «в новом окне».
 */
async function sharedUserData({ ev, main, state }) {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-playground-two-'));
  const fileA = join(userData, 'workspace.cyborg.json');
  const fileB = join(dir, 'b.cyborg.json');
  const fileC = join(dir, 'c.cyborg.json');
  writeFileSync(fileB, '{}');
  writeFileSync(fileC, '{}');
  const env = liveClaude ? process.env : { ...process.env, SHELL: join(fakeBin, 'login-shell') };
  const launch = (file, extra = [], extraEnv = {}) => {
    const child = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${userData}`, '--remote-debugging-port=0', `--workspace=${file}`, ...extra, ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, ...extraEnv } });
    child.out = '';
    child.stderr.on('data', (d) => (child.out += d));
    return child;
  };
  const second = launch(fileB);
  let third;
  let fourth;
  try {
    const port = await waitFor('порт DevTools второго процесса', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(second.out)?.[1]);
    const page = await waitFor('окно второго процесса', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    const evB = await connect(page.webSocketDebuggerUrl);
    const mainB = await connect(await waitFor('инспектор главного процесса второго', () => /Debugger listening on (ws:\/\/\S+)/.exec(second.out)?.[1]));
    const stateB = (id) => evB(`document.querySelector('#plugins-list [data-plugin=${JSON.stringify(id)}]')?.dataset.state ?? ''`);
    await waitFor('плагины второго воркспейса запущены', async () => (await stateB('echo')) === 'active');
    assert.equal(await state('echo'), 'active', 'первый процесс остановился от появления второго');
    assert.match(await evB("document.getElementById('workspace-current').textContent"), /b\.cyborg\.json$/, 'второе окно открыло не свой воркспейс');
    assert.match(await ev("document.getElementById('workspace-current').textContent"), /workspace\.cyborg\.json$/, 'первое окно сменило воркспейс');

    const pidA = lockPid(fileA);
    const pidB = lockPid(fileB);
    assert.ok(Number.isInteger(pidA) && Number.isInteger(pidB) && pidA !== pidB, `у процессов нет своих замков: ${String(pidA)}, ${String(pidB)}`);
    assert.ok(alive(pidA) && alive(pidB), 'замок держит несуществующий процесс');

    // Сессия Chromium и localStorage по воркспейсу.
    const sessionOf = (m) => m("process.mainModule.require('electron').app.getPath('sessionData')");
    const sessionA = await sessionOf(main);
    const sessionB = await sessionOf(mainB);
    assert.ok(sessionA.endsWith(join('workspaces', workspaceKey(fileA))), `сессия первого: ${sessionA}`);
    assert.ok(sessionB.endsWith(join('workspaces', workspaceKey(fileB))), `сессия второго: ${sessionB}`);
    assert.notEqual(sessionA, sessionB);
    await ev("localStorage.setItem('k20', 'A')");
    await evB("localStorage.setItem('k20', 'B')");
    assert.deepEqual([await ev("localStorage.getItem('k20')"), await evB("localStorage.getItem('k20')")], ['A', 'B'], 'localStorage двух процессов смешался');

    // State по ключу воркспейса: чужого файла у процесса нет.
    const stateFiles = existsSync(join(userData, 'state')) ? readdirSync(join(userData, 'state')) : [];
    const keys = [workspaceKey(fileA), workspaceKey(fileB)].map((k) => `${k}.json`);
    assert.ok(stateFiles.every((f) => keys.includes(f)), `в state чужие файлы: ${stateFiles.join(',')}`);

    // «Недавние»: оба воркспейса записаны, ничья запись не потеряна.
    // Второй процесс записывает себя в «Недавние», когда воркспейс открылся: ждём запись, а потом сверяем обе.
    const recentNow = () => JSON.parse(readFileSync(join(userData, 'recent.json'), 'utf8')).recent.map((f) => realpathSync(f));
    const recent = await waitFor('«Недавние» с обоими воркспейсами', () => (recentNow().includes(realpathSync(fileB)) ? recentNow() : undefined));
    assert.ok(recent.includes(realpathSync(fileA)), `«Недавние» потеряли воркспейс первого: ${recent.join(', ')}`);
    log('два процесса, два воркспейса, один userData: свои замки, свои сессии Chromium и localStorage, «Недавние» с обоими');

    // Повторный запуск воркспейса B: поднимает окно владельца и сам завершается. Код 0 это не доказывает (молчащий владелец дал бы код 3,
    // но и «ничего не сделали» не отличить): главный процесс владельца считает запросы на подъём окна.
    const askedBefore = await mainB('globalThis.playgroundSecondLaunches');
    const again = launch(fileB);
    const code = await Promise.race([new Promise((r) => again.once('exit', r)), sleep(15000).then(() => 'висит')]);
    if (code === 'висит') again.kill('SIGKILL');
    assert.equal(code, 0, `повторный запуск воркспейса не ушёл сам или не передал запрос (код ${String(code)}): ${again.out}`);
    assert.equal(await mainB('globalThis.playgroundSecondLaunches'), askedBefore + 1, 'владелец не получил запрос поднять окно: onSecond не вызван');
    assert.equal(second.exitCode, null, 'владелец воркспейса закрылся от повторного запуска');
    assert.equal(lockPid(fileB), pidB, 'замок владельца сменился');
    assert.equal(await stateB('echo'), 'active');
    log('повторный запуск того же воркспейса: владелец получил запрос и поднял окно, новый процесс завершился (код 0), замок за владельцем');

    // Контроль экземпляров недоступен (каталог адресов не создаётся): процесс всё равно открывает окно и называет причину, а не висит без окна.
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'файл на месте каталога');
    const fileD = join(dir, 'd.cyborg.json');
    writeFileSync(fileD, '{}');
    fourth = launch(fileD, [], { XDG_RUNTIME_DIR: join(blocker, 'run') });
    const portD = await waitFor('порт DevTools процесса без контроля экземпляров', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(fourth.out)?.[1]);
    const pageD = await waitFor('окно процесса без контроля экземпляров', async () => (await (await fetch(`http://127.0.0.1:${portD}/json`)).json()).find((t) => t.type === 'page'));
    const evD = await connect(pageD.webSocketDebuggerUrl);
    await waitFor('плагины воркспейса запущены', async () => (await evD("document.querySelector('#plugins-list [data-plugin=\"echo\"]')?.dataset.state ?? ''")) === 'active');
    assert.match(fourth.out, /Контроль экземпляров недоступен/, 'причина не названа в stderr');
    log('контроль экземпляров недоступен: окно открыто, плагины работают, причина названа');

    // «Открыть в новом окне» из первого окна: третий процесс, первые два живы.
    writeFileSync(join(userData, 'recent.json'), JSON.stringify({ recent: [...recent, realpathSync(fileC)] }));
    const opened = await ev(`window.playground.openWorkspaceInNewWindow(${JSON.stringify(realpathSync(fileC))})`);
    assert.ok(!opened?.error, `открытие в новом окне отказало: ${JSON.stringify(opened)}`);
    const pidC = await waitFor('замок третьего воркспейса', () => lockPid(fileC));
    third = pidC;
    assert.ok(![pidA, pidB].includes(pidC) && alive(pidC), `третий процесс не отдельный: ${String(pidC)}`);
    assert.ok(alive(pidA) && alive(pidB), 'открытие в новом окне закрыло прежние процессы');
    assert.equal(await state('echo'), 'active');
    log('«Открыть в новом окне»: воркспейс в отдельном процессе, прежние окна остались');
  } finally {
    if (third !== undefined && alive(third)) process.kill(third, 'SIGTERM');
    fourth?.kill('SIGTERM');
    second.kill('SIGTERM');
    await Promise.race([new Promise((r) => second.once('exit', r)), sleep(8000)]);
    if (second.exitCode === null) second.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
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
  const safe = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${dir}`, '--remote-debugging-port=0', '--safe-mode', '--user-plugins', ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
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
    // Политика этапа 1 (SAD 6.1): каталог пользователя включён флагом, его плагин помечен в окне; встроенный - нет.
    assert.deepEqual(
      await ev("[...document.querySelectorAll('#plugins-list [data-plugin]:not([data-state=\"disabled\"])')].map((r) => `${r.dataset.plugin}:${r.dataset.origin}:${r.querySelector('.plugin-origin')?.textContent ?? ''}:${r.querySelector('.plugin-origin-note') !== null}`).sort()"),
      ['echo:bundled::false', 'locker:user:сторонний:true', 'pin-lock:bundled::false'],
    );
    assert.equal(await ev("!document.getElementById('user-plugins').hidden && /--user-plugins/.test(document.getElementById('user-plugins').textContent)"), true, 'нет плашки каталога пользователя');
    const journal = err.split('\n').filter((l) => l.startsWith('[plugins] {'));
    assert.ok(journal.some((l) => /"pluginId":"locker","kind":"third-party"/.test(l)), 'нет записи third-party у стороннего плагина');
    assert.ok(!journal.some((l) => /"pluginId":"(echo|pin-lock)","kind":"third-party"/.test(l)), 'запись third-party у встроенного плагина');
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
    assert.ok(relaunched.includes('--user-plugins'), `перезапуск потерял --user-plugins: ${relaunched.join(' ')}`);
    log(`безопасный режим: хосты не подняты, lock.onStart не закрыл окно, «Включить» - отказ (${refusal}), выход перезапускает без флага`);
  } finally {
    safe.kill('SIGTERM');
    await Promise.race([new Promise((r) => safe.once('exit', r)), sleep(8000)]);
    if (safe.exitCode === null) safe.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Политика этапа 1 по умолчанию: без `--user-plugins` плагин из каталога пользователя не читается, в окне он не загружен и не помечен как найденный. */
async function userPluginsWindow() {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-playground-userdir-'));
  const notes = join(dir, 'plugins', 'notes');
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, 'manifest.json'), JSON.stringify({ id: 'notes', version: '1.0.0', engines: { cyborg: '^1' } }));
  writeFileSync(join(notes, 'index.js'), 'export default { activate() {} };\n');
  writeFileSync(join(dir, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['echo', 'notes'] } }));
  const plain = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${dir}`, '--remote-debugging-port=0', ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  plain.stderr.on('data', (d) => (err += d));
  try {
    const port = await waitFor('порт DevTools окна без флага каталога пользователя', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err)?.[1]);
    const page = await waitFor('окно без флага каталога пользователя', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    const ev = await connect(page.webSocketDebuggerUrl);
    await waitFor('echo из поставки работает', () => ev("document.querySelector('#plugins-list [data-plugin=\"echo\"]')?.dataset.state === 'active'"));
    assert.equal(await ev("document.querySelector('#plugins-list [data-plugin=\"notes\"]')?.dataset.state !== 'active'"), true, 'плагин из каталога пользователя загружен без флага');
    assert.equal(await ev("document.querySelector('#plugins-list [data-origin=\"user\"]') === null && document.getElementById('user-plugins').hidden"), true, 'без флага в окне есть сторонние или плашка каталога');
    assert.ok(err.includes('--user-plugins'), 'в лог не попала подсказка про флаг');
    assert.ok(!/"kind":"third-party"/.test(err), 'без флага загружен сторонний плагин');
    log('каталог пользователя без флага: плагин notes не загружен, в окне нет сторонних, подсказка про --user-plugins в логе');
  } finally {
    plain.kill('SIGTERM');
    await Promise.race([new Promise((r) => plain.once('exit', r)), sleep(8000)]);
    if (plain.exitCode === null) plain.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * #185: выход приложения с процессами pty в главном процессе. `node-pty` доставляет выход из своего потока, и недоставленный к очистке окружения Node выход роняет Electron
 * SIGABRT (в CI окна не видно, у человека на macOS - «Electron неожиданно завершил работу»). Проба убивает восемь pty и сразу выходит; чисто - код 0, без сигнала и отчёта macOS.
 */
async function ptyExitWindow() {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-playground-ptyexit-'));
  const since = Date.now();
  const probe = spawn(join(repo, 'node_modules', '.bin', 'electron'), [join(repo, 'playground', 'scripts', 'pty-exit-probe.mjs'), `--user-data-dir=${dir}`, ...electronArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  probe.stdout.on('data', (d) => (out += d));
  probe.stderr.on('data', (d) => (out += d));
  try {
    await Promise.race([new Promise((r) => probe.once('exit', r)), sleep(30_000)]);
    assert.notEqual(probe.exitCode ?? probe.signalCode, null, `проба выхода с pty не завершилась за 30 с: ${out}`);
    const crash = await crashOf(probe, since);
    assert.equal(crash, undefined, `выход с pty уронил Electron: ${String(crash)}\n${out}`);
    assert.equal(probe.exitCode, 0, `проба выхода с pty: код ${String(probe.exitCode)}\n${out}`);
    assert.match(out, /выходов доставлено 8 из 8/, 'выходы убитых pty не доставлены до выхода приложения');
    log('выход с pty в главном процессе: drain бэкенда дождался выходов, процесс вышел без сигнала и без отчёта о падении macOS');
  } finally {
    probe.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * K-30: хранение диагностики между запусками. Первый процесс роняет хост плагина и убивается без закрытия (SIGKILL); второй на том же userData показывает причину
 * сбоя прошлого запуска у плагина, не меняя его состояния, и выгружает диагностику одним файлом по кнопке окна (диалог «Сохранить как» подменён).
 */
async function diagnosticsWindow() {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-playground-diag-'));
  writeFileSync(join(dir, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['echo'], hosts: { a: ['echo'] } } }));
  const file = join(dir, 'workspace.cyborg.json');
  const launch = () => {
    // Своя группа процессов: убитое без закрытия приложение уносит и хосты плагинов, иначе они держат адрес экземпляра, и второй запуск считал бы воркспейс занятым.
    const child = spawn(join(repo, 'node_modules', '.bin', 'electron'), ['--inspect=0', repo, `--user-data-dir=${dir}`, '--remote-debugging-port=0', ...electronArgs], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    child.out = '';
    child.stderr.on('data', (d) => (child.out += d));
    return child;
  };
  const pageOf = async (child) => {
    const port = await waitFor('порт DevTools окна диагностики', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(child.out)?.[1]);
    const page = await waitFor('окно диагностики', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    return connect(page.webSocketDebuggerUrl);
  };
  const stateOf = (ev) => ev("document.querySelector('#plugins-list [data-plugin=\"echo\"]')?.dataset.state ?? ''");
  const first = launch();
  let second;
  try {
    const ev1 = await pageOf(first);
    await waitFor('echo работает в первом запуске', async () => (await stateOf(ev1)) === 'active');
    assert.equal(await ev1("document.querySelector('#plugins-list [data-plugin=\"echo\"] .plugin-previous')"), null, 'в первом запуске прошлого сбоя нет');
    await ev1("(window.playground.crashHost('echo'), 0)");
    await waitFor('падение хоста в журнале', () => /"kind":"host-down"/.test(first.out));
    const stored = join(dir, 'diagnostics', workspaceKey(file), 'diagnostics.log');
    await waitFor('запись о падении хоста уже в файле (срочная запись)', () => existsSync(stored) && readFileSync(stored, 'utf8').includes('"kind":"host-down"'));
    process.kill(-first.pid, 'SIGKILL');
    await new Promise((r) => first.once('exit', r));

    second = launch();
    const ev2 = await pageOf(second);
    const main2 = await connect(await waitFor('инспектор главного процесса второго запуска', () => /Debugger listening on (ws:\/\/\S+)/.exec(second.out)?.[1]));
    await waitFor('echo работает во втором запуске', async () => (await stateOf(ev2)) === 'active');
    const previous = await waitFor('причина сбоя прошлого запуска', () => ev2("document.querySelector('#plugins-list [data-plugin=\"echo\"] .plugin-previous')?.textContent"));
    assert.match(previous, /^В прошлом запуске, .*: хост a упал/);
    assert.equal(await ev2("document.querySelector('#plugins-list [data-plugin=\"echo\"] .plugin-reason')"), null, 'прошлый сбой стал причиной текущего состояния');
    assert.equal(await ev2("document.getElementById('diagnostics').hidden"), false);
    assert.match(await ev2("document.getElementById('diagnostics-status').textContent"), /^Диагностика: файлов \d+, \d+ КиБ; записи с .*; прошлый запуск с /);

    const out = join(dir, 'выгрузка.txt');
    await main2(`(() => { const { dialog } = process.mainModule.require('electron'); dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(out)} }); })()`);
    await ev2("document.getElementById('diagnostics-export').click()");
    const done = await waitFor('итог выгрузки в окне', () => ev2("document.getElementById('diagnostics-result').textContent"));
    assert.match(done, /^Выгрузка сохранена: .*выгрузка\.txt/);
    const text = readFileSync(out, 'utf8');
    assert.ok(text.startsWith('Диагностика Cyborg Harness\n'), 'выгрузка не текстовая');
    assert.ok(text.includes('Приложение: Cyborg Playground'), 'нет приложения');
    assert.match(text, /\n {2}echo \S+ - работает, хост a\n/, 'нет версии и состояния плагина');
    assert.match(text, /журнал warn хост a: хост a упал/, 'нет записи о падении хоста прошлого запуска');
    assert.match(text, /Запуски: з1 с .*; з2 с .* \(этот\)/, 'нет двух запусков');
    log('диагностика: падение хоста записано сразу и пережило убитый процесс, второй запуск показывает причину у плагина без смены состояния, выгрузка из окна - один текстовый файл');
  } finally {
    for (const child of [first, second]) {
      try {
        if (child) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // группа уже ушла
      }
    }
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
    assert.deepEqual(await ev("[...document.querySelectorAll('#workspace-recent .workspace-recent-item')].map((b) => b.title)"), [other], 'пропавший файл в «Недавних»');
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
  if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL');
  // Выход приложения после всего сценария: сигнал падения или отчёт macOS о нём - провал, даже если сами проверки прошли (#185).
  const crash = await crashOf(app, startedAt);
  if (crash !== undefined) {
    failed = true;
    console.error(`smoke: ОШИБКА: приложение упало при выходе: ${crash}`);
  }
  rmSync(userData, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
