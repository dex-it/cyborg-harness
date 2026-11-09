// Каналы IPC главного процесса: окно -> служба плагинов и виды -> служба плагинов. Имена те же, что в preload.ts (test/channels.test.ts).
import { BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { isRecord } from './guards.ts';
import type { PluginsService } from './plugins.ts';
import { themeTokens } from './theme.ts';
import { viewOfUrl, viewOrigin } from './view-protocol.ts';
import { resolveDragFile, ViewDrags } from './view-drag.ts';
import { ViewTerminals, type TerminalFrame } from './view-terminals.ts';
import { framesOf, fromWindow, senderPlugin } from './views.ts';

/** Канал, который принимает только документ окна: вид плагина не выключит соседа, даже если обойдёт свой preload. */
export function windowChannel(channel: string, handler: (arg: unknown) => unknown): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, arg: unknown) => {
    if (!fromWindow(event)) throw new Error(`${channel}: только для окна`);
    return handler(arg);
  });
}

/**
 * Канал, который принимает вид плагина: плагин берётся из origin фрейма-отправителя, а не из аргументов, поэтому чужой вид
 * чужого плагина не вызовет. Не вид (окно, чужая страница) получает `notView`. Точка расширения для каналов приложения (K-13).
 */
export function viewChannel(channel: string, handler: (pluginId: string, ...args: unknown[]) => unknown, notView: unknown = { error: 'не вид плагина' }): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const pluginId = senderPlugin(event);
    return pluginId === undefined ? notView : handler(pluginId, ...args);
  });
}

export interface WindowChannelsOptions {
  readonly plugins: PluginsService;
  /** Окно приложения; пока его нет, `views:visibility` ничего не делает. */
  readonly window: () => BrowserWindow | undefined;
}

/** Каналы окна: снимок и кнопки службы плагинов, ответ диалога, закрытие документа, видимость видов. */
export function registerWindowChannels({ plugins, window }: WindowChannelsOptions): void {
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
  windowChannel('views:visibility', (arg) => {
    const win = window();
    if (!isRecord(arg) || typeof arg.id !== 'string' || typeof arg.view !== 'string' || typeof arg.visible !== 'boolean' || !win) return;
    // Видов у плагина может быть несколько, каждый во фрейме со своим ?view=: свёрнутый вид не прячет остальные.
    for (const frame of framesOf(win.webContents, viewOrigin(arg.id))) if (viewOfUrl(frame.url) === arg.view) frame.send('view:visibility', arg.visible);
    plugins.setViewVisible(arg.id, arg.visible);
  });
}

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

export interface ViewChannelsOptions {
  readonly plugins: PluginsService;
  /** Корень файлов, которые виды могут перетаскивать; в Cyborg это проекты, доступные плагину на чтение. */
  readonly dragRoot: () => string;
}

/** Каналы видов: плагин всегда берётся из origin фрейма-отправителя, а не из аргументов. */
export function registerViewChannels({ plugins, dragRoot }: ViewChannelsOptions): void {
  viewChannel('view:dialog', (pluginId, view, spec) => plugins.dialogFor(pluginId, view, spec));
  viewChannel('view:keys', (pluginId) => plugins.keysFor(pluginId), {});
  viewChannel('view:logs', (pluginId) => plugins.logsOf(pluginId), []);
  viewChannel('view:run', (pluginId, command, args) => plugins.runFor(pluginId, command, args));
  viewChannel('view:contract', (pluginId, contract, major) => plugins.contractFor(pluginId, contract, major));
  viewChannel('view:call', (pluginId, contract, major, method, args) => plugins.callFor(pluginId, contract, major, method, args));
  viewChannel('view:state', (pluginId, view) => plugins.viewStateFor(pluginId, view));
  viewChannel('view:state:set', (pluginId, view, value) => plugins.setViewStateFor(pluginId, view, value));
  const terminals = new ViewTerminals((pluginId, ticket, sink) => plugins.openTerminal(pluginId, ticket, sink));
  const terminalChannel = (channel: string, handler: (frame: TerminalFrame, pluginId: string, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const pluginId = senderPlugin(event);
      return pluginId === undefined || !event.senderFrame ? { error: 'не вид плагина' } : handler(event.senderFrame, pluginId, ...args);
    });
  };
  terminalChannel('view:terminal:open', (frame, pluginId, ticket) => terminals.open(frame, pluginId, ticket));
  terminalChannel('view:terminal:write', (frame, _pluginId, tid, data) => terminals.write(frame, tid, data));
  terminalChannel('view:terminal:resize', (frame, _pluginId, tid, cols, rows) => terminals.resize(frame, tid, cols, rows));
  ipcMain.on('view:terminal:close', (event, tid: unknown) => {
    if (senderPlugin(event) !== undefined && event.senderFrame) terminals.close(event.senderFrame, tid);
  });
  ipcMain.handle('view:theme', () => themeTokens(nativeTheme.shouldUseDarkColors));
  // Фокус ввода сообщают документ окна и виды плагинов: ядро решает по нему, пускать ли сочетание с `when.input` в поле ввода.
  // Фреймы живут в разных процессах, и уход фокуса из старого приходит то раньше, то позже прихода в новый: уход засчитывается, только если фокус ещё у его фрейма.
  let focusFrame = '';
  ipcMain.on('input:focus', (event, kind: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame && senderPlugin(event) === undefined) return;
    const frame = `${String(event.processId)}:${String(event.frameId)}`;
    if (kind === 'blur') {
      if (frame === focusFrame) plugins.setInputFocus('other');
      return;
    }
    focusFrame = frame;
    plugins.setInputFocus(kind);
  });
  const drags = new ViewDrags();
  ipcMain.on('view:drag', (event, relative: unknown) => {
    const pluginId = senderPlugin(event);
    const file = resolveDragFile(dragRoot(), relative);
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
}
