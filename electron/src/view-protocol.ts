// Вид плагина в <iframe> с адресом cyborg-plugin://<группа>/<плагин>/ (SAD §3.8): origin - группа рендера, плагин - первый сегмент пути; мост к главному процессу через preload в подфрейме.

import type { ViewDrop } from '@cyborg-harness/contracts';
import type { TerminalEvent, ViewBridge } from '@cyborg-harness/core/ui-shell';

export type { TerminalEvent, ViewBridge, ViewDrop };

export const VIEW_SCHEME = 'cyborg-plugin';

/** Перетаскиваемый путь файла: MIME контракта, а не text/plain - чужой вид не примет его за текст. */
export const PATH_MIME = 'application/x-cyborg-path';

const ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

/** Origin группы рендера: все виды плагинов группы живут под ним, в одном процессе рендера. */
export function viewOrigin(group: string): string {
  return `${VIEW_SCHEME}://${group}`;
}

/** Группа рендера по origin фрейма; не вид плагина - undefined. */
export function groupOfOrigin(origin: string): string | undefined {
  const prefix = `${VIEW_SCHEME}://`;
  if (!origin.startsWith(prefix)) return undefined;
  const group = origin.slice(prefix.length);
  return ID.test(group) ? group : undefined;
}

/** Адрес вида для `<iframe>`: группа - хост, плагин - первый сегмент пути, `?view=` - вид. */
export function viewUrl(group: string, pluginId: string, view?: string): string {
  return `${viewOrigin(group)}/${pluginId}/${view === undefined ? '' : `?view=${encodeURIComponent(view)}`}`;
}

export interface FrameAddress {
  readonly group: string;
  readonly plugin: string;
  readonly view?: string;
}

/** Группа, плагин и вид из адреса кадра; адрес не вида (чужая схема, нет плагина в пути, мусор) - undefined. */
export function frameAddress(url: string): FrameAddress | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${VIEW_SCHEME}:`) return undefined;
    const group = groupOfOrigin(`${parsed.protocol}//${parsed.host}`);
    const plugin = parsed.pathname.split('/')[1];
    if (group === undefined || plugin === undefined || !ID.test(plugin)) return undefined;
    const view = parsed.searchParams.get('view');
    return { group, plugin, ...(view !== null && { view }) };
  } catch {
    return undefined;
  }
}

/** Вид, который открыт во фрейме: `?view=<вид>` в адресе; без параметра или с чужим адресом - undefined. */
export function viewOfUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('view') ?? undefined;
  } catch {
    return undefined;
  }
}
