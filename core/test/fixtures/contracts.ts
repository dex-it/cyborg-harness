// Тесты гоняют границу хоста формами, которых в настоящем контракте быть не должно: синхронный метод, зависание, падение процесса.
declare module '@cyborg/contracts' {
  interface Contracts {
    'test.files': { 1: TestFiles; 2: TestFiles };
    'test.clock': { 1: { tick(): Promise<() => number> } };
    'test.tab': { 1: { readonly kind: string } };
    'test.flaky': { 1: object };
  }
}

export interface TestFiles {
  readonly root?: string;
  read?(path: string): string | Promise<string>;
  fail?(): Promise<never>;
  leak?(): Promise<{ cb: () => number }>;
  hang?(): never;
  crash?(): never;
}
