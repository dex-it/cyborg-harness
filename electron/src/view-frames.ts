import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { frameAddress, groupOfOrigin, viewOrigin } from './view-protocol.ts';

/** Какой группе рендера принадлежит плагин с видами: ядро решает это один раз при загрузке (`Kernel.groupOf`), служба плагинов отдаёт ответ мосту. */
export interface ViewGroups {
  groupOf(pluginId: string): string | undefined;
}

/** То, что нужно от `WebFrameMain` для опознания плагина: адрес и origin даёт главный процесс, вид их не пишет. */
export type FrameLike = Pick<WebFrameMain, 'url' | 'origin'>;

/**
 * Плагин кадра: первый сегмент пути его адреса, если плагин состоит в группе из origin кадра. Граница доверия видов - группа:
 * вид может сменить путь своего кадра (`history.pushState`) на путь соседа по группе и станет им, но не на плагин вне группы.
 * Origin и адрес должны назвать одну группу; кадр без адреса вида (about:blank, srcdoc) плагина не имеет.
 */
export function pluginOfFrame(frame: FrameLike, groups: ViewGroups): string | undefined {
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
  return contents.mainFrame.framesInSubtree.filter((frame) => frame.origin === viewOrigin(group) && frameAddress(frame.url)?.plugin === pluginId);
}
