import type { WebContents, WebFrameMain } from 'electron';
import { groupOfOrigin, VIEW_SCHEME } from './view-protocol.ts';
import { pluginOfFrame, trackViewFrames, type ViewGroups } from './view-frames.ts';


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

/** Окно - только на свою страницу; документ окна ставит во фрейм любой вид, а вид уводит только свой фрейм и только в свою группу рендера (origin): переход к соседу по группе - не выход за границу доверия, плагин вне группы адрес не обслужит. */
export function navigationAllowed(nav: Navigation, windowUrl: string, mainFrame: WebFrameMain): boolean {
  if (nav.isMainFrame) return withoutHash(nav.url) === withoutHash(windowUrl);
  const target = groupOfOrigin(originOf(nav.url));
  if (target === undefined || !nav.url.startsWith(`${VIEW_SCHEME}://`)) return false;
  if (nav.initiator === mainFrame) return true;
  // Инициатора нет у перехода браузера (перезагрузка) и у удалённого фрейма: пускаем только на тот вид, что уже во фрейме.
  if (!nav.initiator) return groupOfOrigin(nav.frame?.origin ?? '') === target;
  const by = groupOfOrigin(nav.initiator.origin);
  return by === target && groupOfOrigin(nav.frame?.origin ?? '') === by;
}

/**
 * Плагин, на которого записывается отказ навигации: плагин кадра-инициатора; если инициатор не кадр вида (дочерний srcdoc или about:blank внутри вида,
 * кадр после pushState) или его нет, - плагин навигируемого кадра. Вид окна и чужие страницы плагина не имеют.
 */
export function navigationPlugin(nav: Navigation, groups: ViewGroups): string | undefined {
  return (nav.initiator && pluginOfFrame(nav.initiator, groups)) ?? (nav.frame && pluginOfFrame(nav.frame, groups)) ?? undefined;
}

/** Окно не открывает новых окон и не уходит со своих адресов (У-23): ссылки наружу - только `shell.openExternal` по праву. Заодно привязывает плагина к кадру вида (`trackViewFrames`). */
export function guardNavigation(contents: WebContents, windowUrl: string, denied: (pluginId: string, url: string) => void, groups: ViewGroups): void {
  // Открывший фрейм Electron не называет, а referrer со схемы cyborg-plugin пуст: окно отклоняется без записи в журнал.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Плагин кадра вида фиксируется при создании его документа и дальше не читается из адреса, который вид меняет сам (TR-31).
  trackViewFrames(contents, groups);
  contents.on('will-frame-navigate', (event) => {
    if (navigationAllowed(event, windowUrl, contents.mainFrame)) return;
    event.preventDefault();
    const pluginId = navigationPlugin(event, groups);
    if (pluginId !== undefined) denied(pluginId, event.url);
  });
}
