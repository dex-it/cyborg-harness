// Дымовой тест собранного playground по DevTools Protocol; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Под замком у pin-lock два документа: вид и экран замка; экран - по ?view=overlay.
  const inOverlay = (id, expression) =>
    main(`(async () => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frame = page.mainFrame.framesInSubtree.find((f) => f.origin === 'cyborg-plugin://${id}' && f.url.includes('view=overlay'));
      return frame ? frame.executeJavaScript(${JSON.stringify(expression)}) : null;
    })()`);
  const viewLog = (id) => inView(id, "[...document.querySelectorAll('#log li')].map((l) => l.textContent).join('\\n')");
  const views = () => ev("[...document.querySelectorAll('#views iframe')].map((f) => f.closest('[data-plugin]').dataset.plugin).sort().join(',')");
  const viewVar = (id, name) => inView(id, `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`);
  const theme = (source) => main(`process.mainModule.require('electron').nativeTheme.themeSource = ${JSON.stringify(source)}`);
  const states = async (expected) => {
    for (const [id, want] of Object.entries(expected)) if ((await state(id)) !== want) return false;
    return true;
  };

  await waitFor('демо-плагины работают, flaky выключен с причиной', async () =>
    (await states({ echo: 'active', chat: 'active', alice: 'active', bob: 'active', flaky: 'stopped', 'agent-claude-code': 'active', 'agent-shell': 'active', 'session-isolation': 'active', sessions: 'active' })) &&
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

  await waitFor('виды echo, alice и bob во фреймах', async () => (await views()) === 'alice,bob,echo,pin-lock,sessions' && (await inView('bob', "document.readyState")) === 'complete');
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
  await waitFor('на месте вида снятой alice - заглушка с причиной', async () => (await views()) === 'bob,echo,pin-lock,sessions' && /выгружен вместе с chat/.test(await text('#views [data-plugin="alice"] .view-reason')));
  assert.ok(await ev(`[...document.querySelectorAll('#views [data-plugin="alice"] button')].some((b) => b.textContent === 'Журнал')`), 'у заглушки нет «Журнал»');
  assert.equal((await keyRow(combo('A')))?.live, 'false');
  await press(combo('A'));
  await waitFor('сочетание выгруженной alice дошло до окна', () => feedHas(re('A', 'до окна дошло')));
  assert.equal(await button('chat', 'Загрузить'), true, 'у выгруженного chat нет «Загрузить»');
  await waitFor('chat и alice вернулись, bob переподписался', async () =>
    (await states({ chat: 'active', alice: 'active' })) && lines().includes('[plugins] bob: чат вернулся, подписываюсь снова'),
  );
  assert.notEqual(await pid('chat'), chatPid, 'после выгрузки chat должен подняться в новом процессе');
  await waitFor('вид alice вернулся', async () => (await views()) === 'alice,bob,echo,pin-lock,sessions');
  await waitFor('новый документ alice помнит приветы из state воркспейса', async () => (await inView('alice', "document.getElementById('greeted')?.textContent")) === 'приветов: 1');
  log('выгрузка с зависимыми, загрузка в новый процесс, переподписка');

  const chatPid2 = await pid('chat');
  assert.equal(await button('chat', 'Уронить хост'), true);
  await waitFor('хост b упал и поднялся', async () => /хост b упал/.test(await text('#plugins-journal')) && (await state('chat')) === 'active' && (await pid('chat')) !== chatPid2);
  const screen = () => inView('echo', "document.getElementById('screen').textContent");
  const type = (command) => inView('echo', `(() => { const l = document.getElementById('line'); l.value = ${JSON.stringify(command)}; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
  await waitFor('вид echo открыл pty по билету главной части', async () => /^pty \d+$/.test(await inView('echo', "document.getElementById('term-state').textContent")));
  await type('echo до-$((6*7))');
  await waitFor('терминал вида ответил', async () => /до-42/.test(await screen()));
  if (process.platform !== 'win32') {
    const hung = await pid('echo');
    assert.equal(await button('echo', 'Повесить хост'), true);
    await waitFor('хост echo остановлен SIGSTOP', async () => /^T/.test(await main(`process.mainModule.require('child_process').execSync('ps -o stat= -p ${hung}').toString().trim()`)));
    await type('echo завис-$((7*8))');
    await waitFor('хост echo стоит, а терминал вида работает', async () => /завис-56/.test(await screen()));
    await waitFor('сторож признал хост a зависшим и перезапустил', async () => /хост a завис/.test(await text('#plugins-journal')) && (await state('echo')) === 'active' && (await pid('echo')) !== echoPid);
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
    assert.equal(await load(), true);
    await waitFor('вернувшийся echo подхватил тот же процесс', async () => (await state('echo')) === 'active' && (await inView('echo', "document.getElementById('term-state').textContent")) === `pty ${sh}` && /после-72/.test(await screen()));
    await type('echo снова-$((9*9))');
    await waitFor('терминал ожил', async () => /снова-81/.test(await screen()));
    assert.equal(await button('echo', 'Выгрузить'), true);
    await waitFor('второй вопрос', async () => (await ask()).includes(`pid ${sh}`));
    assert.equal(await choose('kill'), true);
    await waitFor('процесс echo завершён', async () => (await state('echo')) === 'stopped' && !(await alive(sh)));
    assert.equal(await load(), true);
    await waitFor('echo с новым терминалом', async () => (await state('echo')) === 'active' && /^pty \d+$/.test(await inView('echo', "document.getElementById('term-state').textContent")));
    log('выключение спрашивает о pty: оставленный процесс ждёт плагин, завершённый уходит');
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
  await waitFor('хост c поднялся, bob снова работает', async () => (await state('bob')) === 'active' && (await pid('bob')) !== bobPid2);
  assert.equal(await ev('window.plaqueSeen'), true, 'на время перезапуска вид не закрыт плашкой');
  assert.equal(await inView('bob', 'window.beforeCrash'), 'документ до сбоя', 'перезапуск хоста пересоздал документ вида');
  const statuses = async () => (await viewLog('bob')).split('\n').filter((l) => /чат есть/.test(l)).length;
  const before = await statuses();
  await inView('bob', "document.getElementById('status').click()");
  await waitFor('вид после перезапуска зовёт новый хост', async () => (await statuses()) > before);
  log('перезапуск хоста: вид под плашкой без ввода, документ вида жив, мост ходит в новый хост');

  const answer = () => inView('pin-lock', "document.getElementById('answer').textContent");
  await waitFor('вид pin-lock знает своё сочетание', async () => /Shift\+L\)$/.test((await inView('pin-lock', "document.getElementById('lock')?.textContent")) ?? ''));
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
  await waitFor('F6: следующая панель', async () => /pane-documents/.test(await focusedArea()));
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
  await waitFor('терминал сессии ответил', async () => /агент-25/.test(await inView('sessions', "document.getElementById('screen').textContent")));
  log(`cyborg.agent: два поставщика (${await agentButtons()}), sessions запускает pty по описанию агента`);

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
  if (process.env.CYBORG_SMOKE_CLAUDE === '1') {
    assert.match(await agentButtons(), /claude-code\+/, 'CYBORG_SMOKE_CLAUDE=1, а claude не найден в PATH оболочки входа');
    await inView('sessions', "document.querySelector('#agents cy-button[data-agent=\"claude-code\"]').click()");
    const screen = () => inView('sessions', "document.getElementById('screen').textContent");
    // Новый каталог сессий claude сначала спрашивает о доверии; уже доверенный сразу начинает сессию.
    await waitFor('живой claude: вопрос о доверии к каталогу или начало сессии', async () => /trust\s*this\s*folder/.test(await screen()) || lines().some((l) => /claude-code s\S+: сессия агента/.test(l)), 60_000);
    let reached = 'хук SessionStart дошёл событием session';
    if (/trust\s*this\s*folder/.test(await screen())) {
      await inView('sessions', "(() => { const l = document.getElementById('line'); l.value = ''; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); })()");
      await waitFor('стрелка из пустого поля дошла до диалога claude', async () => /❯\s*Yes,\s*I\s*trust/.test((await screen()).slice(-400)));
      reached = 'вопрос о доверии к каталогу, стрелка из вида меняет выбор';
    }
    await waitFor('вкладка сессии claude в панели «Документы»', async () => (await docRows()) === 'sessions · session:true');
    await ev("document.querySelector('#documents-list .document-row button').click()");
    await waitFor('сессия claude закрыта', async () => (await docRows()) === '' && /вышла/.test(await inView('sessions', "document.getElementById('session-state').textContent")));
    log(`живой claude: оболочка входа по праву launch поставщика, ${reached}; вкладка закрывает сессию`);
  } else log('живой claude пропущен: CYBORG_SMOKE_CLAUDE не задан');

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
  assert.match(await text('#workspace-current'), /workspace\.cyborg\.json$/);
  const recent = JSON.parse(readFileSync(join(userData, 'recent.json'), 'utf8')).recent;
  assert.ok(recent.some((f) => f.endsWith('workspace.cyborg.json')), 'открытый воркспейс не попал в «Недавние»');
  log('воркспейс: замок с pid, второй запуск отдаёт фокус первому и уходит, открытый - в «Недавних»');

  await bareWindow();
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
    log('окно без воркспейса: плагины не грузятся, «Недавние» без пропавших файлов');
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
