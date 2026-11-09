// Вид плагина в своём <iframe> с origin cyborg-plugin://<id> (SAD §3.8) и мост к главному процессу через preload в подфрейме.

import type { ViewDrop } from '@cyborg-harness/contracts';
import type { TerminalEvent, ViewBridge } from '@cyborg-harness/core/ui-shell';

export type { TerminalEvent, ViewBridge, ViewDrop };

export const VIEW_SCHEME = 'cyborg-plugin';

/** Перетаскиваемый путь файла: MIME контракта, а не text/plain - чужой вид не примет его за текст. */
export const PATH_MIME = 'application/x-cyborg-path';

export function viewOrigin(pluginId: string): string {
  return `${VIEW_SCHEME}://${pluginId}`;
}

/** Плагин по origin фрейма; не вид плагина - undefined. */
export function pluginOfOrigin(origin: string): string | undefined {
  const prefix = `${VIEW_SCHEME}://`;
  if (!origin.startsWith(prefix)) return undefined;
  const id = origin.slice(prefix.length);
  return /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(id) ? id : undefined;
}

/** Вид, который открыт во фрейме: `?view=<вид>` в адресе; без параметра или с чужим адресом - undefined. */
export function viewOfUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('view') ?? undefined;
  } catch {
    return undefined;
  }
}
