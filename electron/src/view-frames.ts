import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { frameAddress, groupOfOrigin, viewOrigin } from './view-protocol.ts';

/** Какой группе рендера принадлежит плагин с видами: ядро решает это один раз при загрузке (`Kernel.groupOf`), служба плагинов отдаёт ответ мосту. */
export interface ViewGroups {
  groupOf(pluginId: string): string | undefined;
}

/**
 * То, что нужно от `WebFrameMain` для опознания плагина: адрес и origin даёт главный процесс, вид их не пишет.
 * `frameTreeNodeId` есть у настоящего кадра Electron (фиксирован при создании кадра и не используется повторно); у подставного в тестах его нет.
 */
export type FrameLike = Pick<WebFrameMain, 'url' | 'origin'> & { readonly frameTreeNodeId?: number };

/** Плагин, к которому привязан кадр: `frameTreeNodeId` -> плагин. Номер браузерный и единый для всех окон, поэтому таблица одна. */
const bound = new Map<number, string>();

/**
 * Привязка плагина к кадру при создании его документа (TR-31, исследование доверия 5.8). Вид меняет `frame.url` сам: `history.pushState` на путь соседа по группе,
 * и адрес кадра называет соседа. Поэтому плагин берётся не из текущего адреса, а из адреса, с которым документ зафиксирован (`did-frame-navigate`: только межстраничная
 * навигация, `pushState` её не вызывает) и записывается за номером кадра. Привязку получает только кадр, прямо вложенный в главный фрейм окна (виды создаёт документ окна),
 * с адресом вида и плагином из группы своего origin; вложенный в вид кадр и чужая страница плагина не получают. Новый документ в кадре (окно перенаправило его на другой вид) привязывает заново.
 * Зовётся для каждого окна один раз (`guardNavigation`).
 */
export function trackViewFrames(contents: WebContents, groups: ViewGroups): void {
  const owned = new Set<number>();
  contents.on('did-frame-navigate', (_event, url, _code, _text, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const root = contents.mainFrame;
    const subtree = root.framesInSubtree;
    // Кадры, которых в окне уже нет, из таблицы уходят: номер не используется повторно, запись не нужна.
    const alive = new Set(subtree.map((f) => f.frameTreeNodeId));
    for (const id of owned) {
      if (alive.has(id)) continue;
      owned.delete(id);
      bound.delete(id);
    }
    const frame = subtree.find((f) => f.processId === processId && f.routingId === routingId);
    if (frame === undefined) return;
    const address = frameAddress(url);
    const plugin = address !== undefined && frame.parent?.frameTreeNodeId === root.frameTreeNodeId && groupOfOrigin(frame.origin) === address.group && groups.groupOf(address.plugin) === address.group ? address.plugin : undefined;
    if (plugin === undefined) {
      owned.delete(frame.frameTreeNodeId);
      bound.delete(frame.frameTreeNodeId);
      return;
    }
    owned.add(frame.frameTreeNodeId);
    bound.set(frame.frameTreeNodeId, plugin);
  });
  contents.once('destroyed', () => {
    for (const id of owned) bound.delete(id);
    owned.clear();
  });
}

/**
 * Плагин кадра. Настоящий кадр (есть `frameTreeNodeId`) - плагин, к которому он привязан при создании документа (`trackViewFrames`), если плагин всё ещё состоит в группе из origin кадра;
 * текущий адрес не читается, так что `pushState` личность не меняет. Подставной кадр без номера (тесты) - первый сегмент пути его адреса в группе из origin: граница доверия видов - группа,
 * вид может назваться соседом по группе, но не плагином вне группы. Кадр без адреса вида (about:blank, srcdoc) плагина не имеет.
 */
export function pluginOfFrame(frame: FrameLike, groups: ViewGroups): string | undefined {
  if (frame.frameTreeNodeId !== undefined) {
    const plugin = bound.get(frame.frameTreeNodeId);
    const group = groupOfOrigin(frame.origin);
    return plugin !== undefined && group !== undefined && groups.groupOf(plugin) === group ? plugin : undefined;
  }
  const address = frameAddress(frame.url);
  if (address === undefined || groupOfOrigin(frame.origin) !== address.group) return undefined;
  return groups.groupOf(address.plugin) === address.group ? address.plugin : undefined;
}

/** Плагин вида, приславшего сообщение; из окна или чужой страницы - undefined. */
export function senderPlugin(event: IpcMainEvent | IpcMainInvokeEvent, groups: ViewGroups): string | undefined {
  const frame = event.senderFrame;
  return frame ? pluginOfFrame(frame, groups) : undefined;
}

/** Кадры одного плагина в окне: тема - всем видам, а лог и видимость - только этим, не соседям по группе. */
export function framesOfPlugin(contents: WebContents, group: string | undefined, pluginId: string): WebFrameMain[] {
  if (group === undefined) return [];
  return contents.mainFrame.framesInSubtree.filter((frame) => frame.origin === viewOrigin(group) && (frame.frameTreeNodeId === undefined ? frameAddress(frame.url)?.plugin : bound.get(frame.frameTreeNodeId)) === pluginId);
}
