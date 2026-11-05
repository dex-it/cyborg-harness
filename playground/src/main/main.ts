// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, Notification, powerMonitor, screen, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { viewOrigin } from '../shared/views.ts';
import { electronOs } from './os-env.ts';
import { utilityHosts } from './plugin-hosts.ts';
import { PluginsService } from './plugins.ts';
import { runSpike } from './spike.ts';
import { runHostsSpike } from './spike-hosts.ts';
import { resolveDragFile, ViewDrags } from './view-drag.ts';
import { framesOf, fromWindow, registerViewScheme, senderPlugin, serveViews, viewFrames } from './views.ts';
import { themeTokens } from './theme.ts';
import { resolveViewRequest } from './view-files.ts';
import { ViewTerminals, type TerminalFrame } from './view-terminals.ts';
import { isRecord } from '../../../core/src/manifest.ts';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName('Cyborg Playground');
registerViewScheme();

/** `--spike=<файл>`: замеры видов во фреймах (SAD2, открытый вопрос 11) вместо окна плагинов. */
const spikeOut = process.argv.find((a) => a.startsWith('--spike='))?.slice('--spike='.length);
const hostsSpikeOut = process.argv.find((a) => a.startsWith('--spike-hosts='))?.slice('--spike-hosts='.length);
/** `--workspace=<файл>`: воркспейс по SAD2 §3.1; без флага - `<userData>/workspace.cyborg.json`. */
const workspaceArg = process.argv.find((a) => a.startsWith('--workspace='))?.slice('--workspace='.length);
const workspaceFile = workspaceArg === undefined ? path.join(app.getPath('userData'), 'workspace.cyborg.json') : path.resolve(workspaceArg);
const spiking = spikeOut !== undefined || hostsSpikeOut !== undefined;

// Окон на воркспейс у playground одно; второй запуск того же воркспейса поднимает его окно, а не второе ядро.
if (!spiking && !app.requestSingleInstanceLock({ workspace: workspaceFile })) app.exit(0);

/** Первый запуск: alice и bob делят хост c - видно, как падение одного процесса снимает обоих, а чат в хосте b живёт. */
const DEFAULT_CONFIG = {
  plugins: {
    enabled: ['echo', 'chat', 'alice', 'bob', 'flaky', 'later', 'agent-claude-code', 'agent-shell', 'sessions'],
    hosts: { a: ['echo'], b: ['chat'], c: ['alice', 'bob'], d: ['flaky'], agents: ['agent-claude-code', 'agent-shell'] },
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
  const asked = (data as { workspace?: unknown } | null)?.workspace;
  showWindow();
  if (asked !== workspaceFile && Notification.isSupported()) {
    new Notification({ title: 'Cyborg Playground', body: `Открыт воркспейс ${workspaceFile}; другой - отдельным экземпляром с другим userData (несколько окон - второй этап).` }).show();
  }
});
const plugins = new PluginsService({
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
windowChannel('plugins:crash', (id) => plugins.crash(id));
windowChannel('plugins:hang', (id) => plugins.hang(id));
windowChannel('plugins:run', (command) => plugins.run(command));
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
      `(() => { for (const f of document.querySelectorAll('#views iframe')) { const r = f.getBoundingClientRect(); if (${x} >= r.left && ${x} < r.right && ${y} >= r.top && ${y} < r.bottom) return f.closest('[data-plugin]')?.dataset.plugin ?? null; } return null; })()`,
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
    title: `Cyborg Playground - ${path.basename(workspaceFile)}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
  const hosts = utilityHosts(path.join(__dirname, 'plugin-host.mjs'));
  void plugins.start({
    userData,
    workspace: workspaceFile,
    builtinDir: path.join(__dirname, 'plugins'),
    spawnHost: hosts.spawn,
    pidOf: hosts.pidOf,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    os: electronOs({ userData, roots: () => [workspace], protectedPaths: [workspaceFile, `${workspaceFile}.lock`] }),
    // Короче, чем в Cyborg: зависание по кнопке «Повесить хост» видно через пару секунд.
    watchdog: { interval: 500, timeout: 2500 },
    // eslint-disable-next-line no-console -- журнал ядра в главном процессе - это stderr приложения
    log: (line) => console.error(line),
  });
});
