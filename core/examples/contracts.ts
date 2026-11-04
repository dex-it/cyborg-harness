// Пакет объявлений стороннего автора: контракты demo.* дополняют карту, не трогая @cyborg/contracts.
declare module '@cyborg/contracts' {
  interface Contracts {
    'demo.clock': { 1: Clock };
    'demo.flaky': { 1: Flaky };
  }
}

/** Нарочно нарушает правила контракта: граница хоста делает nowSync асинхронным, а функции в onTick не пропускает. */
export interface Clock {
  nowSync(): number;
  now(): Promise<Date>;
  onTick(callback: () => void): Promise<() => void>;
}

export interface Flaky {
  readonly pid: number;
}
