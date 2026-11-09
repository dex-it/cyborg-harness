// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.
// Всё, что связывает ядро с Electron, лежит в пакете @cyborg-harness/electron; здесь настройка приложения: аргументы, раскладка окна, замеры.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, Notification, powerMonitor } from 'electron';
import { RecentWorkspaces } from '@cyborg-harness/core';
import {
  alertNotification,
  bindWindow,
  electronOs,
  guardNavigation,
  PluginsService,
  quitAfterPlugins,
  registerViewChannels,
  registerViewScheme,
  registerWindowChannels,
  resolveViewRequest,
  restarts,
  serveViews,
  showWindow,
  singleInstance,
  utilityHosts,
  utilityPtyHost,
  watchPower,
  watchTheme,
  windowChannel,
  windowEvents,
  workspaceInfo,
} from '@cyborg-harness/electron';
import { migrateLegacyWorkspace } from './legacy-workspace.ts';
import { runSpike } from './spike.ts';
import { runHostsSpike } from './spike-hosts.ts';
import { runGatewaySpike } from './spike-gateway.ts';

const APP_NAME = 'Cyborg Playground';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName(APP_NAME);
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
const safeMode = process.argv.includes('--safe-mode');

let win: BrowserWindow | undefined;

// Один экземпляр - один воркспейс - одно окно: второй запуск с любым воркспейсом поднимает открытое окно, а не второе ядро.
const sole =
  spiking ||
  singleInstance({ workspace: workspaceFile ?? null, safeMode }, (data) => {
    const asked = data as { workspace?: unknown; safeMode?: unknown } | null;
    showWindow(win);
    if (!Notification.isSupported()) return;
    const say = (body: string) => alertNotification(APP_NAME, body, () => showWindow(win));
    if (asked?.workspace !== workspaceFile) say(`Открыт воркспейс ${workspaceFile ?? 'нет'}; другой открывается из окна - «Недавние» или «Открыть…».`);
    // Запрошенный режим вторым запуском не применяется: ядро решает про него один раз, до первого хоста.
    if ((asked?.safeMode === true) !== safeMode) say(safeMode ? 'Безопасный режим уже включён; выйти из него можно пунктом окна «Выйти из безопасного режима».' : 'Безопасный режим не включён: закройте приложение или выберите в окне «Перезапустить в безопасном режиме».');
  });
if (!sole) app.exit(0);

/** Первый запуск: alice и bob делят хост c - видно, как падение одного процесса снимает обоих, а чат в хосте b живёт. */
const DEFAULT_CONFIG = {
  plugins: {
    enabled: ['echo', 'chat', 'alice', 'bob', 'flaky', 'later', 'agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions', 'sessions', 'pin-lock'],
    hosts: { a: ['echo'], b: ['chat'], c: ['alice', 'bob'], d: ['flaky'], agents: ['agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions'] },
  },
};

/** Корень файлов, которые виды могут перетаскивать; в Cyborg это проекты, доступные плагину на чтение. */
let workspace = '';

const plugins = new PluginsService(windowEvents(() => win));
registerWindowChannels({ plugins, window: () => win });
registerViewChannels({ plugins, dragRoot: () => workspace });

// Смена воркспейса и безопасного режима - перезапуск приложения; каналы окна для них - дело приложения (меню, кнопки).
const control = restarts({ plugins, window: () => win, recent, workspaceFile, safeMode });
windowChannel('workspace:open', (file) => control.openWorkspace(file));
windowChannel('app:safe-mode', (on) => control.switchSafeMode(on));

const showWorkspace = () => plugins.setWorkspace(workspaceInfo(workspaceFile, recent));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 980,
    title: `${APP_NAME} - ${workspaceFile === undefined ? 'без воркспейса' : path.basename(workspaceFile)}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
  });
  // Заголовок собирает ядро; `<title>` страницы его бы затёр.
  win.on('page-title-updated', (event) => event.preventDefault());
  const page = path.join(__dirname, 'renderer', 'index.html');
  guardNavigation(win.webContents, pathToFileURL(page).href, (pluginId, url) => plugins.viewDenied(pluginId, url));
  void win.loadFile(page);
  bindWindow(win, plugins);
  win.on('closed', () => (win = undefined));
}

quitAfterPlugins(plugins);
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
  watchTheme(() => win);
  const userData = app.getPath('userData');
  const config = path.join(userData, 'cyborg.json');
  if (!fs.existsSync(config)) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(config, JSON.stringify(DEFAULT_CONFIG, null, 2));
  }
  createWindow();
  watchPower(plugins);
  showWorkspace();
  if (workspaceFile === undefined) {
    plugins.withoutWorkspace();
    return;
  }
  const hosts = utilityHosts(path.join(__dirname, 'plugin-host.mjs'));
  // node-pty живёт в своём процессе ядра: его зависание не замораживает окно (K-01).
  const ptyHost = utilityPtyHost(path.join(__dirname, 'pty-host.js'));
  void plugins.start({
    userData,
    workspace: workspaceFile,
    appName: APP_NAME,
    migrate: migrateLegacyWorkspace,
    safeMode,
    builtinDir: path.join(__dirname, 'plugins'),
    spawnHost: hosts.spawn,
    pidOf: hosts.pidOf,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    os: electronOs({ userData, roots: () => [workspace], protectedPaths: [workspaceFile, `${workspaceFile}.lock`], workspaceFile, raiseWindow: () => showWindow(win), ptyHost: ptyHost.spawn }),
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
