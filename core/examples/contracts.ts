import type { Subscription } from '@cyborg-harness/contracts';

// Пакет объявлений стороннего автора: контракты demo.* дополняют карту, не трогая @cyborg-harness/contracts.
declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'demo.clock': { 1: Clock };
    'demo.flaky': { 1: Flaky };
  }
}

/** Нарочно нарушает правила контракта: граница хоста делает nowSync асинхронным; onTick - подписка по правилам. */
export interface Clock {
  nowSync(): number;
  now(): Promise<Date>;
  onTick(callback: (tick: number) => void): Subscription;
}

export interface Flaky {
  readonly pid: number;
}
