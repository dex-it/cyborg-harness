import type { Subscription } from '@cyborg/contracts';

declare module '@cyborg/contracts' {
  interface Contracts {
    'bench.rpc': { 1: BenchRpc };
  }
}

/** Контракт замера хостов (SAD2, открытый вопрос 7): вызов с ответом и поток событий подписчику. */
export interface BenchRpc {
  echo(data: string): Promise<string>;
  /** Шлёт `count` кусков всем подписчикам; ответ - после отправки последнего. */
  burst(count: number, data: string): Promise<void>;
  onData(listener: (data: string) => void): Subscription;
}

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly totalMs: number;
}

export function percentiles(times: number[], totalMs: number): Percentiles {
  times.sort((a, b) => a - b);
  const at = (q: number) => Math.round((times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? NaN) * 1000) / 1000;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), totalMs: Math.round(totalMs * 10) / 10 };
}
