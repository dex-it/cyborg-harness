// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, Notification, powerMonitor, screen, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { viewOrigin } from '@cyborg-harness/electron/window';
import { PluginsService } from './plugins.ts';
import { runSpike } from './spike.ts';
import { runHostsSpike } from './spike-hosts.ts';
import { runGatewaySpike } from './spike-gateway.ts';
import { themeTokens } from '@cyborg-harness/electron';
import { resolveViewRequest } from '@cyborg-harness/electron';
import { electronOs, framesOf, fromWindow, guardNavigation, registerViewScheme, resolveDragFile, senderPlugin, serveViews, utilityHosts, viewFrames, ViewDrags, ViewTerminals, type TerminalFrame } from '@cyborg-harness/electron';
import { RecentWorkspaces } from '@cyborg-harness/core';
import { isRecord } from './guards.ts';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName('Cyborg Playground');
registerViewScheme();

/** `--spike=<файл>`: замеры видов во фреймах (SAD, открытый вопрос 11) вместо окна плагинов. */
const spikeOut = process.argv.find((a) => a.startsWith('--spike='))?.slice('--spike='.length);
const hostsSpikeOut = process.argv.find((a) => a.startsWith('--spike-hosts='))?.slice('--spike-hosts='.length);
const gatewaySpikeOut = process.argv.find((a) => a.startsWith('--spike-gateway='))?.slice('--spike-gateway='.length);
const recent = new RecentWorkspaces(path.join(app.getPath('userData'), 'recent.json'));
/** `--workspace=<файл>` по SAD §3.1; без флага - последний из «Недавних», без них - `<userData>/workspace.cyborg.json`; `--no-workspace` - окно без воркспейса. */
const workspaceArg = process.argv.find((a) => a.startsWith('--workspace='))?.slice('--workspace='.length);
const workspaceFile = process.argv.includes('--no-workspace')
  ? undefined
  : workspaceArg !== undefined
    ? path.resolve(workspaceArg)
    : (recent.list()[0] ?? path.join(app.getPath('userData'), 'workspace.cyborg.json'));
const spiking = spikeOut !== undefined || hostsSpikeOut !== undefined || gatewaySpikeOut !== undefined;
/** `--safe-mode` (BR-CH-005): манифесты разобраны, код плагинов не запускается; смена воркспейса флаг сохраняет, снимает его только «Выйти из безопасного режима». */
const SAFE_MODE = '--safe-mode';
const safeMode = process.argv.includes(SAFE_MODE);

// Один экземпляр - один воркспейс - одно окно: второй запуск с любым воркспейсом поднимает открытое окно, а не второе ядро.
if (!spiking && !app.requestSingleInstanceLock({ workspace: workspaceFile ?? null, safeMode })) app.exit(0);

/** Первый запуск: alice и bob делят хост c - видно, как падение одного процесса снимает обоих, а чат в хосте b живёт. */
const DEFAULT_CONFIG = {
  plugins: {
    enabled: ['echo', 'chat', 'alice', 'bob', 'flaky', 'later', 'agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions', 'sessions', 'pin-lock'],
    hosts: { a: ['echo'], b: ['chat'], c: ['alice', 'bob'], d: ['flaky'], agents: ['agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions'] },
  },
};

let win: BrowserWindow | undefined;

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const notices = new Set<Notification>();

app.on('second-instance', (_event, _argv, _cwd, data) => {
  const asked = data as { workspace?: unknown; safeMode?: unknown } | null;
  showWindow();
  if (!Notification.isSupported()) return;
  const say = (body: string) => new Notification({ title: 'Cyborg Playground', body }).show();
  if (asked?.workspace !== workspaceFile) say(`Открыт воркспейс ${workspaceFile ?? 'нет'}; другой открывается из окна - «Недавние» или «Открыть…».`);
  // Запрошенный режим вторым запуском не применяется: ядро решает про него один раз, до первого хоста.
  if ((asked?.safeMode === true) !== safeMode) say(safeMode ? 'Безопасный режим уже включён; выйти из него можно пунктом окна «Выйти из безопасного режима».' : 'Безопасный режим не включён: закройте приложение или выберите в окне «Перезапустить в безопасном режиме».');
});
const plugins = new PluginsService({
  windowCommand: (command) => {
    if (win && !win.isDestroyed()) win.webContents.send('window:command', command);
  },
  changed: () => {
    if (win && !win.isDestroyed()) win.webContents.send('plugins:changed');
  },
  alert: (title, body) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    const forget = () => notices.delete(notification);
    notification.on('click', () => {
      forget();
      showWindow();
    });
    notification.on('close', forget);
    notification.on('failed', forget);
    notices.add(notification);
    notification.show();
  },
  log: (pluginId, line) => {
    if (win && !win.isDestroyed()) for (const frame of framesOf(win.webContents, viewOrigin(pluginId))) frame.send('view:log', line);
  },
  title: (title) => {
    if (win && !win.isDestroyed()) win.setTitle(title);
  },
});

function windowChannel(channel: string, handler: (arg: unknown) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, arg: unknown) => {
    if (!fromWindow(event)) throw new Error(`${channel}: только для окна`);
    return handler(arg);
  });
}

windowChannel('plugins:snapshot', () => plugins.snapshot());
windowChannel('plugins:enable', (id) => plugins.enable(id));
windowChannel('plugins:disable', (arg) => (isRecord(arg) ? plugins.disable(arg.id, arg.keepPty) : plugins.disable(arg)));
windowChannel('plugins:disable-preview', (id) => plugins.disablePreview(id));
windowChannel('plugins:end-kept-pty', (id) => plugins.endKeptPty(id));
windowChannel('plugins:crash', (id) => plugins.crash(id));
windowChannel('plugins:hang', (id) => plugins.hang(id));
windowChannel('plugins:run', (command) => plugins.run(command));
windowChannel('window:answer', (arg) => plugins.answerDialog(arg));
windowChannel('documents:close', (id) => plugins.closeDocument(id));
windowChannel('workspace:open', (file) => openWorkspace(file));
windowChannel('app:safe-mode', (on) => switchSafeMode(on));

const realOf = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

function showWorkspace(): void {
  const current = workspaceFile === undefined ? null : realOf(workspaceFile);
  plugins.setWorkspace({ current: workspaceFile ?? null, recent: recent.list().filter((f) => f !== current) });
}

/** Один экземпляр - один воркспейс - одно окно: смена воркспейса - перезапуск, выход выключает плагины и снимает замок. */
async function openWorkspace(arg: unknown): Promise<void> {
  let file: string | undefined;
  if (arg === undefined) {
    const options = { title: 'Открыть воркспейс', filters: [{ name: 'Воркспейс Cyborg', extensions: ['json'] }], properties: ['openFile' as const] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    file = picked.canceled ? undefined : picked.filePaths[0];
  } else if (typeof arg === 'string' && recent.list().includes(arg)) {
    file = arg;
  } else {
    throw new Error('воркспейса нет в «Недавних»');
  }
  if (file === undefined || (workspaceFile !== undefined && realOf(file) === realOf(workspaceFile))) return;
  if (!(await livePtyAgreed('Открыть', `Открыть ${path.basename(file)}?`))) return;
  const keep = process.argv.slice(1).filter((a) => a !== '--no-workspace' && !a.startsWith('--workspace='));
  app.relaunch({ args: [...keep, `--workspace=${file}`] });
  app.quit();
}

/** Перезапуск, а не переключение на ходу: ядро решает про безопасный режим один раз, до первого хоста. */
async function switchSafeMode(on: unknown): Promise<void> {
  if (typeof on !== 'boolean') throw new Error('ожидается true или false');
  if (on === safeMode) return;
  if (!(await livePtyAgreed('Перезапустить', on ? 'Перезапустить в безопасном режиме?' : 'Выйти из безопасного режима?'))) return;
  const keep = process.argv.slice(1).filter((a) => a !== SAFE_MODE);
  app.relaunch({ args: on ? [...keep, SAFE_MODE] : keep });
  app.quit();
}

/** Перезапуск завершает живые pty плагинов: без них вопроса нет. */
async function livePtyAgreed(action: string, question: string): Promise<boolean> {
  const live = plugins.livePty;
  if (live === 0) return true;
  const message = { type: 'question' as const, buttons: [action, 'Отмена'], defaultId: 1, cancelId: 1, message: question, detail: `Живых процессов плагинов: ${String(live)}. Они завершатся при перезапуске.` };
  const answer = win ? await dialog.showMessageBox(win, message) : await dialog.showMessageBox(message);
  return answer.response === 0;
}
ipcMain.handle('view:dialog', (event, view: unknown, spec: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.dialogFor(pluginId, view, spec);
});
ipcMain.handle('view:keys', (event) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? {} : plugins.keysFor(pluginId);
});
ipcMain.handle('view:logs', (event) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? [] : plugins.logsOf(pluginId);
});
ipcMain.handle('view:run', (event, command: unknown, args: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.runFor(pluginId, command, args);
});
ipcMain.handle('view:contract', (event, contract: unknown, major: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.contractFor(pluginId, contract, major);
});
ipcMain.handle('view:call', (event, contract: unknown, major: unknown, method: unknown, args: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.callFor(pluginId, contract, major, method, args);
});
ipcMain.handle('view:state', (event, view: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.viewStateFor(pluginId, view);
});
ipcMain.handle('view:state:set', (event, view: unknown, value: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.setViewStateFor(pluginId, view, value);
});
const terminals = new ViewTerminals((pluginId, ticket, sink) => plugins.openTerminal(pluginId, ticket, sink));
function terminalChannel(channel: string, handler: (frame: TerminalFrame, pluginId: string, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const pluginId = senderPlugin(event);
    return pluginId === undefined || !event.senderFrame ? { error: 'не вид плагина' } : handler(event.senderFrame, pluginId, ...args);
  });
}
terminalChannel('view:terminal:open', (frame, pluginId, ticket) => terminals.open(frame, pluginId, ticket));
terminalChannel('view:terminal:write', (frame, _pluginId, tid, data) => terminals.write(frame, tid, data));
terminalChannel('view:terminal:resize', (frame, _pluginId, tid, cols, rows) => terminals.resize(frame, tid, cols, rows));
ipcMain.on('view:terminal:close', (event, tid: unknown) => {
  if (senderPlugin(event) !== undefined && event.senderFrame) terminals.close(event.senderFrame, tid);
});
ipcMain.handle('view:theme', () => themeTokens(nativeTheme.shouldUseDarkColors));
windowChannel('views:visibility', (arg) => {
  if (!isRecord(arg) || typeof arg.id !== 'string' || typeof arg.visible !== 'boolean' || !win) return;
  for (const frame of framesOf(win.webContents, viewOrigin(arg.id))) frame.send('view:visibility', arg.visible);
});
/** Корень файлов, которые виды могут перетаскивать; в Cyborg это проекты, доступные плагину на чтение. */
let workspace = '';
const drags = new ViewDrags();

/** Вид под точкой экрана: прямоугольники фреймов знает только документ окна. */
async function viewAt(contents: WebContents, point: Electron.Point): Promise<string | undefined> {
  const owner = BrowserWindow.fromWebContents(contents);
  if (!owner) return undefined;
  const bounds = owner.getContentBounds();
  const [x, y] = [point.x - bounds.x, point.y - bounds.y];
  const id: unknown = await contents
    .executeJavaScript(
      `(() => { for (const f of document.querySelectorAll('.views iframe')) { const r = f.getBoundingClientRect(); if (${x} >= r.left && ${x} < r.right && ${y} >= r.top && ${y} < r.bottom) return f.closest('[data-plugin]')?.dataset.plugin ?? null; } return null; })()`,
    )
    .catch(() => null);
  return typeof id === 'string' ? id : undefined;
}

ipcMain.on('view:drag', (event, relative: unknown) => {
  const pluginId = senderPlugin(event);
  const file = resolveDragFile(workspace, relative);
  if (pluginId === undefined || file === undefined || typeof relative !== 'string') return;
  const drag = drags.start(pluginId, relative);
  event.sender.startDrag({ file, icon: nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0x99), { width: 16, height: 16 }) });
  // На Linux startDrag держит вызов до отпускания кнопки: курсор сейчас - точка сброса, а view:drop приёмника придёт позже.
  void viewAt(event.sender, screen.getCursorScreenPoint()).then((target) => drags.landed(drag, target));
  setTimeout(() => drags.end(drag), 1000);
});
ipcMain.handle('view:drop', async (event) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? null : ((await drags.take(pluginId)) ?? null);
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 980,
    title: `Cyborg Playground - ${workspaceFile === undefined ? 'без воркспейса' : path.basename(workspaceFile)}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
  });
  // Заголовок собирает ядро; `<title>` страницы его бы затёр.
  win.on('page-title-updated', (event) => event.preventDefault());
  const page = path.join(__dirname, 'renderer', 'index.html');
  guardNavigation(win.webContents, pathToFileURL(page).href, (pluginId, url) => plugins.viewDenied(pluginId, url));
  void win.loadFile(page);
  // Ядро видит нажатие раньше страницы: сочетание активного плагина до окна не доходит.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && plugins.press(input)) event.preventDefault();
  });
  win.on('focus', () => plugins.emit({ kind: 'focus', focused: true }));
  win.on('blur', () => plugins.emit({ kind: 'focus', focused: false }));
  win.on('closed', () => (win = undefined));
}

// Выход ждёт onBeforeQuit плагинов не дольше бюджета: второй before-quit уже не откладывается.
let quitReady = false;
app.on('before-quit', (event) => {
  if (quitReady) return;
  event.preventDefault();
  void plugins.quit(3000).finally(() => {
    quitReady = true;
    app.quit();
  });
});
// Замер сам открывает и закрывает окна по сценариям и сам завершает приложение.
app.on('window-all-closed', () => {
  if (!spiking) app.quit();
});

void app.whenReady().then(() => {
  if (gatewaySpikeOut !== undefined) {
    void runGatewaySpike({ out: gatewaySpikeOut, hostEntry: path.join(__dirname, 'plugin-host.mjs'), benchDir: path.join(__dirname, 'bench') }).finally(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode)));
    return;
  }
  if (hostsSpikeOut !== undefined) {
    void runHostsSpike({ out: hostsSpikeOut, hostEntry: path.join(__dirname, 'plugin-host.mjs'), benchDir: path.join(__dirname, 'bench') }).finally(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode)));
    return;
  }
  workspace = path.join(app.getPath('userData'), 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const notes = path.join(workspace, 'notes.md');
  if (!fs.existsSync(notes)) fs.writeFileSync(notes, '# Заметки\n\nФайл для перетаскивания между видами playground.\n');
  if (spikeOut !== undefined) {
    void runSpike({ out: spikeOut, preload: path.join(__dirname, 'preload.js'), rendererDir: path.join(__dirname, 'renderer') }).finally(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode)));
    return;
  }
  serveViews((url) => resolveViewRequest(url, (id) => plugins.uiOf(id, true)), path.join(__dirname, 'renderer', 'shell'));
  nativeTheme.on('updated', () => {
    if (!win || win.isDestroyed()) return;
    const tokens = themeTokens(nativeTheme.shouldUseDarkColors);
    for (const frame of viewFrames(win.webContents)) frame.send('view:theme', tokens);
  });
  const userData = app.getPath('userData');
  const config = path.join(userData, 'cyborg.json');
  if (!fs.existsSync(config)) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(config, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  createWindow();
  powerMonitor.on('suspend', () => plugins.emit({ kind: 'suspend' }));
  powerMonitor.on('resume', () => plugins.emit({ kind: 'resume' }));
  powerMonitor.on('lock-screen', () => plugins.emit({ kind: 'screen-lock' }));
  showWorkspace();
  if (workspaceFile === undefined) {
    plugins.withoutWorkspace();
    return;
  }
  const hosts = utilityHosts(path.join(__dirname, 'plugin-host.mjs'));
  void plugins.start({
    userData,
    workspace: workspaceFile,
    safeMode,
    builtinDir: path.join(__dirname, 'plugins'),
    spawnHost: hosts.spawn,
    pidOf: hosts.pidOf,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    os: electronOs({ userData, roots: () => [workspace], protectedPaths: [workspaceFile, `${workspaceFile}.lock`], workspaceFile, raiseWindow: showWindow }),
    // Короче, чем в Cyborg: зависание по кнопке «Повесить хост» видно через пару секунд.
    watchdog: { interval: 500, timeout: 2500 },
    // eslint-disable-next-line no-console -- журнал ядра в главном процессе - это stderr приложения
    log: (line) => console.error(line),
  }).then(() => {
    // В «Недавние» попадает только открывшийся: чужой замок или ошибка старта воркспейс туда не приносят.
    if (plugins.snapshot().phase !== 'ready') return;
    recent.add(workspaceFile);
    showWorkspace();
  });
});
