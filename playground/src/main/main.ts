// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { utilityHosts } from './plugin-hosts.ts';
import { PluginsService } from './plugins.ts';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName('Cyborg Playground');

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
});

ipcMain.handle('plugins:snapshot', () => plugins.snapshot());
ipcMain.handle('plugins:enable', (_event, id: unknown) => plugins.enable(id));
ipcMain.handle('plugins:disable', (_event, id: unknown) => plugins.disable(id));
ipcMain.handle('plugins:crash', (_event, id: unknown) => plugins.crash(id));
ipcMain.handle('plugins:hang', (_event, id: unknown) => plugins.hang(id));
ipcMain.handle('plugins:run', (_event, command: unknown) => plugins.run(command));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    title: 'Cyborg Playground',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Ядро видит нажатие раньше страницы: сочетание активного плагина до окна не доходит.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && plugins.press(input)) event.preventDefault();
  });
  win.on('closed', () => (win = undefined));
}

app.on('before-quit', () => void plugins.unload());
app.on('window-all-closed', () => app.quit());

void app.whenReady().then(() => {
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
