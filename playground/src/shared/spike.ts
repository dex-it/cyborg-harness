// Замеры фреймов (spike): сообщения и мост страницы замера и пробных видов. Адаптер Electron их не знает.

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
