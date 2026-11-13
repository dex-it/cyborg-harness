// Playground ядра: одно окно «Плагины Cyborg» над настоящими хостами в utilityProcess, без самого Cyborg.
// Всё, что связывает ядро с Electron, лежит в пакете @cyborg-harness/electron; здесь настройка приложения: аргументы, раскладка окна, замеры.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, Notification, powerMonitor, shell } from 'electron';
import { RecentWorkspaces, withFileLock } from '@cyborg-harness/core';
import {
  alertNotification,
  baseAccelerators,
  bindAppMenu,
  bindWindow,
  electronOs,
  fileDiagnostics,
  guardNavigation,
  isolateSession,
  PluginsService,
  quitAfterPlugins,
  registerViewChannels,
  registerViewScheme,
  registerWindowChannels,
  resolveViewRequest,
  restarts,
  serveViews,
  showWindow,
  TRACE_ARGS_FLAG,
  USER_PLUGINS_FLAG,
  utilityHosts,
  utilityPtyHost,
  watchPower,
  watchTheme,
  windowChannel,
  windowEvents,
  workspaceInfo,
  type AppMenuItem,
  workspaceInstance,
  workspaceNeighbors,
} from '@cyborg-harness/electron';
import { migrateLegacyWorkspace } from './legacy-workspace.ts';
import { createErrorReporter, type ErrorNotice } from './main-errors.ts';
import { quietPipes } from './quiet-pipes.ts';
import { runSpike } from './spike.ts';
import { runHostsSpike } from './spike-hosts.ts';
import { runTrustProbe } from './trust-probe.ts';
import { runGatewaySpike } from './spike-gateway.ts';

const APP_NAME = 'Cyborg Playground';

// Своя папка данных: cyborg.json и пользовательские плагины playground не смешиваются с настройками Cyborg.
app.setName(APP_NAME);
registerViewScheme();

/**
 * Окно необработанной ошибки, которое не исчезает: полный текст, «Копировать» (в буфер; после копирования окно открывается снова),
 * «Показать файл журнала», «Закрыть». До готовности приложения `dialog.showMessageBox` недоступен - окно ждёт `ready`.
 */
async function showErrorNotice(notice: ErrorNotice): Promise<void> {
  await app.whenReady();
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: `Необработанная ошибка главного процесса (${notice.kind})`,
      detail: `${notice.text}\nЖурнал: ${notice.logFile}`,
      buttons: ['Копировать', 'Показать файл журнала', 'Закрыть'],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    });
    if (response === 0) {
      await clipboard.writeText(notice.text);
      continue;
    }
    if (response === 1) shell.showItemInFolder(notice.logFile);
    return;
  }
}

// Свой обработчик отменяет штатное окно «Uncaught Exception»: ошибка попадает в журнал, в stderr и в это окно, а процесс не падает молча.
const errorReporter = createErrorReporter({
  logFile: path.join(app.getPath('userData'), 'logs', 'main-errors.log'),
  notify: (notice) => void showErrorNotice(notice),
});
process.on('uncaughtException', (error) => errorReporter.report('uncaughtException', error));
process.on('unhandledRejection', (reason) => errorReporter.report('unhandledRejection', reason));

/** `--spike=<файл>`: замеры видов во фреймах (SAD, открытый вопрос 11) вместо окна плагинов. */
const spikeOut = process.argv.find((a) => a.startsWith('--spike='))?.slice('--spike='.length);
const hostsSpikeOut = process.argv.find((a) => a.startsWith('--spike-hosts='))?.slice('--spike-hosts='.length);
const gatewaySpikeOut = process.argv.find((a) => a.startsWith('--spike-gateway='))?.slice('--spike-gateway='.length);
/** `--trust-probe=<файл>`: плагин-нарушитель в хосте стороннего плагина на настоящем utilityProcess (TR-01, `npm run test:trust`). */
const trustProbeOut = process.argv.find((a) => a.startsWith('--trust-probe='))?.slice('--trust-probe='.length);
const recent = new RecentWorkspaces(path.join(app.getPath('userData'), 'recent.json'));
/** `--workspace=<файл>` по SAD §3.1; без флага - последний из «Недавних», без них - `<userData>/workspace.cyborg.json`; `--no-workspace` - окно без воркспейса. */
const workspaceArg = process.argv.find((a) => a.startsWith('--workspace='))?.slice('--workspace='.length);
const workspaceFile = process.argv.includes('--no-workspace')
  ? undefined
  : workspaceArg !== undefined
    ? path.resolve(workspaceArg)
    : (recent.list()[0] ?? path.join(app.getPath('userData'), 'workspace.cyborg.json'));
/** `--view-csp=<строка>`: CSP видов вместо `VIEW_CSP` - так пилот PL-05 (`npm run spike:monaco`) проверяет наборы директив; в Cyborg её задаёт приложение (K-05). */
const viewCsp = process.argv.find((a) => a.startsWith('--view-csp='))?.slice('--view-csp='.length);
const spiking = spikeOut !== undefined || hostsSpikeOut !== undefined || gatewaySpikeOut !== undefined || trustProbeOut !== undefined;
/** `--safe-mode` (BR-CH-005): манифесты разобраны, код плагинов не запускается; смена воркспейса флаг сохраняет, снимает его только «Выйти из безопасного режима». */
const safeMode = process.argv.includes('--safe-mode');
/** `--user-plugins` (SAD 6.1): читать каталог плагинов пользователя; без флага грузятся только плагины из поставки. Флаг только в командной строке: файл воркспейса может лежать в репозитории. Смена воркспейса и безопасного режима его сохраняет (перезапуск берёт argv). */
const userPlugins = process.argv.includes(USER_PLUGINS_FLAG);
/** `--trace-args` (K-33): записи трассы несут аргументы операций, чтобы отладка не шла вслепую. Только командная строка, как `--user-plugins`: из файла воркспейса запись данных не включить. Перезапуск и новое окно берут argv и флаг сохраняют. */
const traceArgs = process.argv.includes(TRACE_ARGS_FLAG);
/** `--delivery` (P-07): встроенные плагины берутся из `delivery` рядом с приложением - поставки, собранной `cyborg-plugin delivery` (index.mjs и delivery.json); без флага это стенд с исходниками в `plugins` (index.ts). */
const deliveryMode = process.argv.includes('--delivery');

let win: BrowserWindow | undefined;

/**
 * Меню приложения (K-08): свои меню и пункты здесь, пункты плагинов (`contributes.menus`) встают в меню с `menu` и в меню ядра, которых тут нет («Инструменты»).
 * Правка нужна и для буфера обмена: role copy и paste меню Edit действуют на сфокусированный кадр, вложенный тоже (issue #2).
 */
const menuBase: AppMenuItem[] = [
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
  { label: 'Воркспейс', menu: 'workspace', submenu: [{ role: process.platform === 'darwin' ? 'close' : 'quit' }] },
  { role: 'editMenu' },
  // resetZoom: Cmd/Ctrl+0 - сочетание Cyborg, которое там живёт в слушателе окна; здесь оно акселератор меню и занято в реестре ядра (PL-03).
  { label: 'Вид', menu: 'view', submenu: [{ role: 'toggleDevTools' }, { role: 'resetZoom' }] },
  { label: 'Окно', menu: 'window', submenu: [{ role: 'minimize' }] },
];

// Сессия Chromium этого воркспейса лежит в своём каталоге внутри userData: два процесса не делят localStorage и кэш.
isolateSession(app.getPath('userData'), workspaceFile);

/** Контроль экземпляров не заработал (см. `workspaceInstance`): окно откроется, но повторный запуск этого воркспейса его не поднимет. */
let instanceProblem: string | undefined;
/** Сколько раз второй запуск этого воркспейса просил поднять окно; читает smoke (K-20, #61 к.3): код выхода второго процесса этого не доказывает. */
(globalThis as { playgroundSecondLaunches?: number }).playgroundSecondLaunches = 0;

/**
 * Экземпляров несколько, воркспейс у каждого свой (K-20, SAD 3.1): второй запуск того же воркспейса поднимает его окно и уходит,
 * другой воркспейс с тем же userData открывается своим процессом. Вернуть прежнюю модель «один процесс на весь userData» -
 * заменить вызов на `singleInstance(...)` адаптера; общие файлы userData остаются под замками.
 */
const claim = spiking
  ? Promise.resolve('owner' as const)
  : workspaceInstance(
      app.getPath('userData'),
      workspaceFile,
      { safeMode, userPlugins },
      (data) => {
        const asked = data as { safeMode?: unknown; userPlugins?: unknown } | null;
        (globalThis as unknown as { playgroundSecondLaunches: number }).playgroundSecondLaunches++;
        showWindow(win);
        if (!Notification.isSupported()) return;
        const say = (body: string) => alertNotification(APP_NAME, body, () => showWindow(win));
        // Запрошенный режим вторым запуском не применяется: ядро решает про него один раз, до первого хоста.
        if ((asked?.safeMode === true) !== safeMode) say(safeMode ? 'Безопасный режим уже включён; выйти из него можно пунктом окна «Выйти из безопасного режима».' : 'Безопасный режим не включён: закройте приложение или выберите в окне «Перезапустить в безопасном режиме».');
        // Каталог пользователя, как и безопасный режим, решается один раз при старте ядра.
        if ((asked?.userPlugins === true) !== userPlugins) say(userPlugins ? `Каталог плагинов пользователя уже включён (${USER_PLUGINS_FLAG}); снять его можно, закрыв приложение и запустив без флага.` : `Каталог плагинов пользователя не включён: чтобы загрузить сторонние плагины, закройте приложение и запустите его с ${USER_PLUGINS_FLAG}.`);
      },
      (error) => {
        instanceProblem = `Контроль экземпляров недоступен (${error.message}). Окно откроется, но повторный запуск этого воркспейса его не поднимет: он сообщит, что воркспейс занят.`;
        // eslint-disable-next-line no-console -- до готовности приложения журнала плагинов ещё нет: причина уходит в stderr
        console.error(instanceProblem);
      },
      // Соседние окна этого userData спрашивают, какие плагины здесь могут работать, прежде чем удалить плагин (#154); до создания службы запрос получит «не знаю».
      () => plugins.working(),
    );

/** Первый запуск: alice и bob делят хост c - видно, как падение одного процесса снимает обоих, а чат в хосте b живёт. */
const DEFAULT_CONFIG = {
  plugins: {
    enabled: ['echo', 'chat', 'alice', 'bob', 'flaky', 'later', 'agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions', 'sessions', 'session-notifications', 'pin-lock', 'panels', 'editor', 'stub-files', 'stub-sessions', 'stub-tracker', 'stub-commands', 'stub-project'],
    // session-notifications в своём хосте (PL-02): события sessions идут к нему через границу процессов.
    hosts: { a: ['echo'], b: ['chat'], c: ['alice', 'bob'], d: ['flaky'], notifications: ['session-notifications'], agents: ['agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions'] },
    // K-04: виды alice и bob делят origin и процесс рендера, остальные - по одному на плагин.
    uiGroups: { duo: ['alice', 'bob'], stubs: ['stub-files', 'stub-sessions', 'stub-tracker', 'stub-commands'] },
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
windowChannel('workspace:open-new', (file) => control.openWorkspaceInNewWindow(file));
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
  guardNavigation(win.webContents, pathToFileURL(page).href, (pluginId, url) => plugins.viewDenied(pluginId, url), plugins);
  void win.loadFile(page);
  bindWindow(win, plugins);
  win.on('closed', () => (win = undefined));
}

quitAfterPlugins(plugins);
// Замер сам открывает и закрывает окна по сценариям и сам завершает приложение.
app.on('window-all-closed', () => {
  if (!spiking) app.quit();
});

quietPipes();

const start = () => {
  if (gatewaySpikeOut !== undefined) {
    void runGatewaySpike({ out: gatewaySpikeOut, hostEntry: path.join(__dirname, 'plugin-host.mjs'), benchDir: path.join(__dirname, 'bench'), trace: !process.argv.includes('--gateway-trace=off') }).finally(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode)));
    return;
  }
  if (trustProbeOut !== undefined) {
    void runTrustProbe({ out: trustProbeOut, hostEntry: path.join(__dirname, 'plugin-host.mjs'), probeDir: path.join(__dirname, 'trust-probe') }).finally(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode)));
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
  serveViews((url) => resolveViewRequest(url, (id) => plugins.uiOf(id), (id) => plugins.wake(id)), path.join(__dirname, 'renderer', 'shell'), viewCsp === undefined ? {} : { csp: viewCsp });
  watchTheme(() => win);
  const userData = app.getPath('userData');
  const config = path.join(userData, 'cyborg.json');
  // Два процесса на пустом userData: файл появляется целиком (rename) и один раз (под замком), иначе второй прочтёт полфайла.
  withFileLock(config, () => {
    if (fs.existsSync(config)) return;
    const tmp = `${config}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(DEFAULT_CONFIG, null, 2));
    fs.renameSync(tmp, config);
  });
  createWindow();
  bindAppMenu(plugins, menuBase);
  // Причина видна человеку в окне, а не только в stderr: без неё «повторный запуск не поднимает окно» выглядит поломкой.
  if (instanceProblem !== undefined && win !== undefined) void dialog.showMessageBox(win, { type: 'warning', message: APP_NAME, detail: instanceProblem });
  watchPower(plugins);
  showWorkspace();
  if (workspaceFile === undefined) {
    plugins.withoutWorkspace();
    return;
  }
  const hosts = utilityHosts(path.join(__dirname, 'plugin-host.mjs'));
  // K-30: журнал, строки плагинов и трасса уходят в кольцо и в файлы `userData/diagnostics/<воркспейс>`; окно показывает причину сбоя прошлого запуска и выгружает диагностику.
  const version = `${APP_NAME} ${app.getVersion()}`;
  // eslint-disable-next-line no-console -- отказ диска виден в stderr приложения и в строке «Диагностика» окна
  const diagnostics = fileDiagnostics(userData, workspaceFile, { app: version, onProblem: (text) => console.error(`[diagnostics] ${text}`) });
  // node-pty живёт в своём процессе ядра: его зависание не замораживает окно (K-01).
  const ptyHost = utilityPtyHost(path.join(__dirname, 'pty-host.js'));
  void plugins.start({
    userData,
    workspace: workspaceFile,
    appName: APP_NAME,
    diagnostics,
    versions: { app: version },
    migrate: migrateLegacyWorkspace,
    safeMode,
    userPlugins,
    traceArgs,
    // Настоящие акселераторы меню окна: плагин не займёт их динамически, манифест на них проиграет с записью в журнале (PL-03).
    menuKeys: baseAccelerators(menuBase),
    neighbors: workspaceNeighbors(userData, workspaceFile),
    builtinDir: path.join(__dirname, deliveryMode ? 'delivery' : 'plugins'),
    builtinMode: deliveryMode ? 'delivery' : 'stand',
    spawnHost: hosts.spawn,
    pidOf: hosts.pidOf,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    // Окно могло потерять фокус, пока ядро запускалось: плагин узнаёт это из ctx.window.focused(), а не ждёт перемены.
    windowFocused: () => win?.isFocused() ?? true,
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
};

void claim.then((kind) => {
  if (kind === 'owner') {
    void app.whenReady().then(start);
    return;
  }
  // Воркспейс уже открыт другим процессом, этому пора выйти. `handed` - владелец получил запрос (код 0); `unresponsive` - владелец жив,
  // но молчит: человеку нужно об этом сказать, код выхода отдельный (3), чтобы такой исход не принимали за успех.
  if (kind === 'handed') {
    app.exit(0);
    return;
  }
  const message = 'Воркспейс уже открыт другим процессом, но тот не отвечает. Закройте его или завершите вручную и запустите приложение снова.';
  // eslint-disable-next-line no-console -- до окна сообщить больше некуда
  console.error(message);
  // До `ready` на Linux showErrorBox пишет только в stderr, а у процесса «в новом окне» stdio закрыт - диалог только после готовности.
  void app.whenReady().then(() => {
    dialog.showErrorBox(APP_NAME, message);
    app.exit(3);
  });
});
