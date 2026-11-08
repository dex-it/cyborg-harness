import fs from 'node:fs/promises';
import path from 'node:path';
import { protocol, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { pluginOfOrigin, VIEW_SCHEME } from './view-protocol.ts';
import { VIEW_CSP, type ViewRequest } from './view-files.ts';

/** До `app.ready`: standard даёт схеме свой origin на хост, а с ним site isolation по плагинам. */
export function registerViewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** `shellDir` - каталог собранной оболочки вида (shell.js, shell.css). */
export function serveViews(resolve: (url: string) => ViewRequest | undefined, shellDir: string): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    const found = resolve(request.url);
    if (!found) return new Response('нет такого файла вида', { status: 404 });
    const headers = { 'content-type': found.kind === 'shell' ? 'text/html; charset=utf-8' : found.type, 'content-security-policy': VIEW_CSP };
    if (found.kind === 'shell') return new Response(found.html, { headers });
    try {
      const file = found.kind === 'core' ? path.join(shellDir, found.name) : found.file;
      return new Response(new Uint8Array(await fs.readFile(file)), { headers });
    } catch {
      return new Response('нет такого файла вида', { status: 404 });
    }
  });
}

/** Все фреймы видов окна: тема одна на всех. */
export function viewFrames(contents: WebContents): WebFrameMain[] {
  return contents.mainFrame.framesInSubtree.filter((frame) => pluginOfOrigin(frame.origin) !== undefined);
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
