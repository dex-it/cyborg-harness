// Окно и приложение: события ядра -> окно, окно и ОС -> ядро, экземпляры приложения. Раскладку окна и меню делает приложение.
import { app, nativeTheme, Notification, powerMonitor, type BrowserWindow } from 'electron';
import { claimWorkspace, sessionDataDir } from './instances.ts';
import type { PluginsEvents, PluginsService } from './plugins.ts';
import { themeTokens } from './theme.ts';
import { framesOfPlugin } from './view-frames.ts';
import { viewFrames } from './views.ts';

const alive = (win: BrowserWindow | undefined): win is BrowserWindow => win !== undefined && !win.isDestroyed();

/** Поднимает окно из свёрнутого и фона; нет окна - ничего. */
export function showWindow(win: BrowserWindow | undefined): void {
  if (!alive(win)) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Без ссылки сборщик мусора забирает Notification, и клик по нему уже ничего не вызывает.
const notices = new Set<Notification>();

/** Уведомление ОС от приложения; клик поднимает окно. */
export function alertNotification(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  const forget = () => notices.delete(notification);
  notification.on('click', () => {
    forget();
    onClick();
  });
  notification.on('close', forget);
  notification.on('failed', forget);
  notices.add(notification);
  notification.show();
}

/** События службы плагинов -> окно приложения: снимок, команда окна, лента вида, заголовок, уведомление о выключении плагина. */
export function windowEvents(getWindow: () => BrowserWindow | undefined): PluginsEvents {
  return {
    windowCommand: (command) => {
      const win = getWindow();
      if (alive(win)) win.webContents.send('window:command', command);
    },
    changed: () => {
      const win = getWindow();
      if (alive(win)) win.webContents.send('plugins:changed');
    },
    alert: (title, body) => alertNotification(title, body, () => showWindow(getWindow())),
    log: (pluginId, line, group) => {
      const win = getWindow();
      // Строку лога получают кадры самого плагина, а не всей группы рендера.
      if (alive(win)) for (const frame of framesOfPlugin(win.webContents, group, pluginId)) frame.send('view:log', line);
    },
    title: (title) => {
      const win = getWindow();
      if (alive(win)) win.setTitle(title);
    },
  };
}

/** Ядро видит нажатие раньше страницы, а фокус окна и питание ОС становятся системными событиями плагинов. */
export function bindWindow(win: BrowserWindow, plugins: PluginsService): void {
  // Ядро видит нажатие раньше страницы: сочетание активного плагина до окна не доходит.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && plugins.press(input, input.isAutoRepeat)) event.preventDefault();
  });
  win.on('focus', () => plugins.emit({ kind: 'focus', focused: true }));
  win.on('blur', () => plugins.emit({ kind: 'focus', focused: false }));
}

/** Сон, пробуждение и блокировка экрана -> `ctx.system` плагинов. */
export function watchPower(plugins: PluginsService): void {
  powerMonitor.on('suspend', () => plugins.emit({ kind: 'suspend' }));
  powerMonitor.on('resume', () => plugins.emit({ kind: 'resume' }));
  powerMonitor.on('lock-screen', () => plugins.emit({ kind: 'screen-lock' }));
}

/** Смена темы ОС -> токены темы во все фреймы видов. */
export function watchTheme(getWindow: () => BrowserWindow | undefined): void {
  nativeTheme.on('updated', () => {
    const win = getWindow();
    if (!alive(win)) return;
    const tokens = themeTokens(nativeTheme.shouldUseDarkColors);
    for (const frame of viewFrames(win.webContents)) frame.send('view:theme', tokens);
  });
}

/**
 * Один экземпляр на воркспейс, процессов может быть несколько (K-20, SAD 3.1). Исход:
 * - `owner` - процесс владелец: он слушает адрес воркспейса и зовёт `onSecond(data)`, когда второй запуск того же воркспейса просит поднять окно.
 *   Если контроль экземпляров недоступен (каталог адресов чужой или не создаётся, ошибка сокета), причина уходит в `onUnavailable`, а процесс
 *   всё равно `owner`, только без адреса: окно открывается, данные держит замок воркспейса, повторный запуск получит отказ замка в своём окне;
 * - `handed` - воркспейс уже открыт другим процессом, ему передан `data`, текущему пора выйти;
 * - `unresponsive` - владелец жив, но не ответил в срок: запрос не доставлен, текущему тоже пора выйти, но человеку об этом надо сказать.
 * Другой воркспейс с тем же `userData` не мешает. Окно без воркспейса (`workspaceFile` не задан) в `userData` одно. Вызывать до готовности
 * приложения; адрес отдаётся при выходе. Промис не отклоняется.
 */
export async function workspaceInstance(
  userData: string,
  workspaceFile: string | undefined,
  data: Record<string, unknown>,
  onSecond: (data: unknown) => void,
  onUnavailable?: (error: Error) => void,
): Promise<'owner' | 'handed' | 'unresponsive'> {
  const claim = await claimWorkspace(userData, workspaceFile, data, onSecond, onUnavailable);
  if (claim.kind !== 'owner') return claim.kind;
  app.once('will-quit', () => claim.close());
  return 'owner';
}

/**
 * Сессия Chromium этого воркспейса в своём каталоге внутри `userData` (`sessionData`): localStorage, IndexedDB и кэш двух процессов
 * не смешиваются и не спорят за замки. Вызывать до готовности приложения, когда воркспейс уже известен.
 */
export function isolateSession(userData: string, workspaceFile: string | undefined): void {
  app.setPath('sessionData', sessionDataDir(userData, workspaceFile));
}

/**
 * Один экземпляр приложения на весь `userData`: `false` - замок держит другой процесс, текущему пора выйти. `data` уходит первому экземпляру,
 * когда второй запущен; что ответить человеку, решает приложение.
 */
export function singleInstance(data: Record<string, unknown>, onSecond: (data: unknown) => void): boolean {
  if (!app.requestSingleInstanceLock(data)) return false;
  app.on('second-instance', (_event, _argv, _cwd, asked) => onSecond(asked));
  return true;
}

/** Выход ждёт `onBeforeQuit` плагинов не дольше бюджета (мс): второй `before-quit` уже не откладывается. */
export function quitAfterPlugins(plugins: PluginsService, budget = 3000): void {
  let ready = false;
  app.on('before-quit', (event) => {
    if (ready) return;
    event.preventDefault();
    void plugins.quit(budget).finally(() => {
      ready = true;
      app.quit();
    });
  });
}
