// Вид плагина в своём <iframe> с origin cyborg-plugin://<id> (SAD §3.8) и мост к главному процессу через preload в подфрейме.

import type { ViewDrop } from '@cyborg-harness/contracts';
import type { TerminalEvent, ViewBridge } from '@cyborg-harness/core/ui-shell';

export type { TerminalEvent, ViewBridge, ViewDrop };

export const VIEW_SCHEME = 'cyborg-plugin';

/** Перетаскиваемый путь файла: MIME контракта, а не text/plain - чужой вид не примет его за текст. */
export const PATH_MIME = 'application/x-cyborg-path';

/** Сообщение замера: `ack` - ответить сразу, без него вид молчит до последнего куска потока. */
export interface SpikePing {
  readonly n: number;
  readonly ack: boolean;
  readonly data?: string;
}

/** Мост замера: есть у пробных видов и у страницы замера, у видов плагинов его нет. */
export interface SpikeBridge {
  onPing(listener: (ping: SpikePing) => void): void;
  pong(n: number): void;
  /** Страница замера пересылает ping во фрейм через postMessage - второй вариант моста. */
  onRelay(listener: (target: number, ping: SpikePing) => void): void;
  report(event: SpikeReport): void;
}

export type SpikeReport =
  | { readonly kind: 'key'; readonly key: string; readonly ctrl: boolean; readonly shift: boolean }
  | { readonly kind: 'dragstart' }
  | { readonly kind: 'drop'; readonly types: readonly string[]; readonly path: string; readonly from: string | null };

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
