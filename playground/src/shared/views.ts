// Вид плагина в своём <iframe> с origin cyborg-plugin://<id> (SAD2 §3.8) и мост к главному процессу через preload в подфрейме.

import type { FeedLine, Reply } from './plugins.ts';

export const VIEW_SCHEME = 'cyborg-plugin';

/** Перетаскиваемый путь файла: MIME контракта, а не text/plain - чужой вид не примет его за текст. */
export const PATH_MIME = 'application/x-cyborg-path';

/** Что видит вид плагина в `window.cyborgView`: только своё - главный процесс узнаёт плагин по origin фрейма, а не по словам вида. */
export interface ViewBridge {
  /** Свои команды плагина; чужую главный процесс отклонит. */
  run(command: string): Promise<Reply>;
  /** Сообщения своего плагина, накопленные до открытия вида. */
  logs(): Promise<readonly FeedLine[]>;
  onLog(listener: (line: FeedLine) => void): void;
  /** Перетаскивание пути ведёт ядро: Chromium не пускает перетаскивание из страницы во фрейм другого процесса той же страницы. */
  startDrag(path: string): void;
  /** Путь, сброшенный в этот вид, и плагин-источник; сброс не из вида - null. */
  drop(): Promise<ViewDrop | null>;
}

export interface ViewDrop {
  readonly from: string;
  readonly path: string;
}

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
