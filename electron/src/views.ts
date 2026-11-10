import fs from 'node:fs/promises';
import path from 'node:path';
import { protocol, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';
import { groupOfOrigin, VIEW_SCHEME } from './view-protocol.ts';
import { viewHeaders, type ViewCsp, type ViewRequest } from './view-files.ts';

/** До `app.ready`: standard даёт схеме свой origin на хост, а с ним site isolation по группам рендера. */
export function registerViewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: VIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export interface ServeViewsOptions {
  /** CSP ответов вместо `viewCsp(флаг плагина)` (пилот PL-05 задаёт наборы). Функция получает плагина и группу из адреса запроса и флаг `inlineStyles`. */
  readonly csp?: ViewCsp;
}

/** `shellDir` - каталог собранной оболочки вида (shell.js, shell.css). */
export function serveViews(resolve: (url: string) => ViewRequest | undefined, shellDir: string, options: ServeViewsOptions = {}): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    const found = resolve(request.url);
    if (!found) return new Response('нет такого файла вида', { status: 404 });
    const headers = viewHeaders(found, request.url, options.csp);
    if (found.kind === 'shell') return new Response(found.html, { headers });
    try {
      const file = found.kind === 'core' ? path.join(shellDir, found.name) : found.file;
      return new Response(new Uint8Array(await fs.readFile(file)), { headers });
    } catch {
      return new Response('нет такого файла вида', { status: 404 });
    }
  });
}

/** Все фреймы видов окна: тема одна на всех плагинов и всех групп. */
export function viewFrames(contents: WebContents): WebFrameMain[] {
  return contents.mainFrame.framesInSubtree.filter((frame) => groupOfOrigin(frame.origin) !== undefined);
}

/** Фреймы с этим origin, то есть всей группы рендера; кадры одного плагина группы - `framesOfPlugin`. */
export function framesOf(contents: WebContents, origin: string): WebFrameMain[] {
  return contents.mainFrame.framesInSubtree.filter((frame) => frame.origin === origin);
}

/** Каналы окна принимают только документ окна: вид плагина не выключит соседа, даже если обойдёт свой preload. */
export function fromWindow(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame;
}
