// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { utilityHosts } from './plugin-hosts.ts';
import { PluginsService } from './plugins.ts';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName('Cyborg Playground');

/** Первый запуск: включаем демо-плагины, каждый в своём хосте, чтобы падение одного не задевало других. */
const DEFAULT_CONFIG = {
  plugins: {
    enabled: ['echo', 'probe', 'flaky'],
    hosts: { a: ['echo'], b: ['probe'], c: ['flaky'] },
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
ipcMain.handle('plugins:revive', (_event, id: unknown) => plugins.revive(id));

function createWindow(): void {
  win = new BrowserWindow({
    width: 900,
    height: 760,
    title: 'Cyborg Playground',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
  void plugins.start({
    userData,
    builtinDir: path.join(__dirname, 'plugins'),
    spawnHost: utilityHosts(path.join(__dirname, 'plugin-host.mjs')),
    // eslint-disable-next-line no-console -- журнал ядра в главном процессе - это stderr приложения
    log: (line) => console.error(line),
  });
});
