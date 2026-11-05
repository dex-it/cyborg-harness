import fs from 'node:fs/promises';
import { protocol, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { pluginOfOrigin, VIEW_SCHEME } from '../shared/views.ts';
import { resolveViewFile, VIEW_CSP } from './view-files.ts';

/** До `app.ready`: standard даёт схеме свой origin на хост, а с ним site isolation по плагинам. */
export function registerViewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function serveViews(dirOf: (pluginId: string) => string | undefined): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    const found = resolveViewFile(request.url, dirOf);
    if (!found) return new Response('нет такого файла вида', { status: 404 });
    try {
      return new Response(new Uint8Array(await fs.readFile(found.file)), { headers: { 'content-type': found.type, 'content-security-policy': VIEW_CSP } });
    } catch {
      return new Response('нет такого файла вида', { status: 404 });
    }
  });
}

export function framesOf(contents: WebContents, origin: string): WebFrameMain[] {
  return contents.mainFrame.framesInSubtree.filter((frame) => frame.origin === origin);
}

/** Плагин вида, приславшего сообщение; из окна или чужой страницы - undefined. */
export function senderPlugin(event: IpcMainEvent | IpcMainInvokeEvent): string | undefined {
  const frame = event.senderFrame;
  return frame ? pluginOfOrigin(frame.origin) : undefined;
}

/** Каналы окна принимают только документ окна: вид плагина не выключит соседа, даже если обойдёт свой preload. */
export function fromWindow(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
}
