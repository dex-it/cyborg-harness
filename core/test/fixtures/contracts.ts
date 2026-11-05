// Тесты гоняют границу хоста формами, которых в настоящем контракте быть не должно: синхронный метод, зависание, падение процесса.
import type { Subscription } from '@cyborg/contracts';

declare module '@cyborg/contracts' {
  interface Contracts {
    'test.files': { 1: TestFiles; 2: TestFiles };
    'test.clock': { 1: { tick(): Promise<() => number> } };
    'test.tab': { 1: { readonly kind: string } };
    'test.flaky': { 1: object };
    'test.ticker': { 1: Ticker };
    'test.guarded': { 1: Guarded };
  }
}

export interface Ticker {
  onTick(listener: (n: number, label: string) => void, label?: string): Subscription;
  tick(n: number): void;
  listeners(): number;
}

export interface TestFiles {
  readonly root?: string;
  read?(path: string): string | Promise<string>;
  fail?(): Promise<never>;
  leak?(): Promise<{ cb: () => number }>;
  hang?(): never;
  crash?(): never;
}

/** Поставщик с `guard` в манифесте: путь аргумента проверяется у вызывающего (`via-contract`). */
export interface Guarded {
  read(path: string): Promise<string>;
  open(spec: { path: string }): Promise<string>;
  size(path: string): Promise<number>;
}
