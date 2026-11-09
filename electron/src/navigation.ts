import type { WebContents, WebFrameMain } from 'electron';
import { pluginOfOrigin, VIEW_SCHEME } from './view-protocol.ts';


interface Navigation {
  readonly url: string;
  readonly isMainFrame: boolean;
  readonly frame: WebFrameMain | null;
  readonly initiator?: WebFrameMain | null | undefined;
}

// URL Node даёт origin 'null' схеме вне стандартных, а cyborg-plugin стандартной считает только Chromium.
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function withoutHash(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

/** Окно - только на свою страницу; документ окна ставит во фрейм любой вид, а вид уводит только свой фрейм и только на свой origin. */
export function navigationAllowed(nav: Navigation, windowUrl: string, mainFrame: WebFrameMain): boolean {
  if (nav.isMainFrame) return withoutHash(nav.url) === withoutHash(windowUrl);
  const target = pluginOfOrigin(originOf(nav.url));
  if (target === undefined || !nav.url.startsWith(`${VIEW_SCHEME}://`)) return false;
  if (nav.initiator === mainFrame) return true;
  // Инициатора нет у перехода браузера (перезагрузка) и у удалённого фрейма: пускаем только на тот вид, что уже во фрейме.
  if (!nav.initiator) return pluginOfOrigin(nav.frame?.origin ?? '') === target;
  const by = pluginOfOrigin(nav.initiator.origin);
  return by === target && pluginOfOrigin(nav.frame?.origin ?? '') === by;
}

/** Окно не открывает новых окон и не уходит со своих адресов (У-23): ссылки наружу - только `shell.openExternal` по праву. */
export function guardNavigation(contents: WebContents, windowUrl: string, denied: (pluginId: string, url: string) => void): void {
  // Открывший фрейм Electron не называет, а referrer со схемы cyborg-plugin пуст: окно отклоняется без записи в журнал.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-frame-navigate', (event) => {
    if (navigationAllowed(event, windowUrl, contents.mainFrame)) return;
    event.preventDefault();
    const pluginId = pluginOfOrigin(event.initiator?.origin ?? '') ?? pluginOfOrigin(event.frame?.origin ?? '');
    if (pluginId !== undefined) denied(pluginId, event.url);
  });
}
