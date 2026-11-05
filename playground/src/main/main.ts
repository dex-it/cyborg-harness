// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, nativeImage, Notification, type IpcMainInvokeEvent } from 'electron';
import { viewOrigin } from '../shared/views.ts';
import { utilityHosts } from './plugin-hosts.ts';
import { PluginsService } from './plugins.ts';
import { runSpike } from './spike.ts';
import { ViewDrags } from './view-drag.ts';
import { framesOf, fromWindow, registerViewScheme, senderPlugin, serveViews } from './views.ts';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName('Cyborg Playground');
registerViewScheme();

/** `--spike=<файл>`: замеры видов во фреймах (SAD2, открытый вопрос 11) вместо окна плагинов. */
const spikeOut = process.argv.find((a) => a.startsWith('--spike='))?.slice('--spike='.length);

/** Первый запуск: alice и bob делят хост c - видно, как падение одного процесса снимает обоих, а чат в хосте b живёт. */
const DEFAULT_CONFIG = {
  plugins: {
    enabled: ['echo', 'chat', 'alice', 'bob', 'flaky'],
    hosts: { a: ['echo'], b: ['chat'], c: ['alice', 'bob'], d: ['flaky'] },
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
windowChannel('plugins:disable', (id) => plugins.disable(id));
windowChannel('plugins:crash', (id) => plugins.crash(id));
windowChannel('plugins:hang', (id) => plugins.hang(id));
windowChannel('plugins:run', (command) => plugins.run(command));
ipcMain.handle('view:logs', (event) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? [] : plugins.logsOf(pluginId);
});
ipcMain.handle('view:run', (event, command: unknown) => {
  const pluginId = senderPlugin(event);
  return pluginId === undefined ? { error: 'не вид плагина' } : plugins.runFor(pluginId, command);
});
const drags = new ViewDrags();
ipcMain.on('view:drag', (event, file: unknown) => {
  const pluginId = senderPlugin(event);
  const drag = pluginId === undefined ? undefined : drags.start(pluginId, file);
  if (!drag) return;
  event.sender.startDrag({ file: drag.path, icon: nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0x99), { width: 16, height: 16 }) });
  // На Linux startDrag держит вызов до отпускания кнопки, а view:drop приёмника приходит через десятки мс после.
  setTimeout(() => drags.end(drag), 1000);
});
ipcMain.handle('view:drop', (event) => (senderPlugin(event) === undefined ? null : (drags.take() ?? null)));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 980,
    title: 'Cyborg Playground',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Ядро видит нажатие раньше страницы: сочетание активного плагина до окна не доходит.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && plugins.press(input)) event.preventDefault();
  });
  win.on('closed', () => (win = undefined));
}

app.on('before-quit', () => void plugins.unload());
// Замер сам открывает и закрывает окна по сценариям и сам завершает приложение.
app.on('window-all-closed', () => {
  if (spikeOut === undefined) app.quit();
});

void app.whenReady().then(() => {
  if (spikeOut !== undefined) {
    void runSpike({ out: spikeOut, preload: path.join(__dirname, 'preload.js'), rendererDir: path.join(__dirname, 'renderer') }).finally(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode)));
    return;
  }
  serveViews((id) => plugins.viewDir(id));
  const userData = app.getPath('userData');
  const config = path.join(userData, 'cyborg.json');
  if (!fs.existsSync(config)) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(config, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  createWindow();
  const hosts = utilityHosts(path.join(__dirname, 'plugin-host.mjs'));
  void plugins.start({
    userData,
    builtinDir: path.join(__dirname, 'plugins'),
    spawnHost: hosts.spawn,
    pidOf: hosts.pidOf,
    // Короче, чем в Cyborg: зависание по кнопке «Повесить хост» видно через пару секунд.
    watchdog: { interval: 500, timeout: 2500 },
    // eslint-disable-next-line no-console -- журнал ядра в главном процессе - это stderr приложения
    log: (line) => console.error(line),
  });
});
