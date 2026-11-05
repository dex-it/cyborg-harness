import type { Disposable, DisposableStore as Store } from '@cyborg/contracts';

export type { Disposable };

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
}

/** Снимает добавленное в обратном порядке; ошибка одного не мешает снять остальные. */
export class DisposableStore implements Store {
  #items: Disposable[] = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  add(...items: Disposable[]): void {
    if (this.#disposed) {
      disposeAll(items);
      return;
    }
    this.#items.push(...items);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = this.#items.reverse();
    this.#items = [];
    disposeAll(items);
  }
}

function disposeAll(items: readonly Disposable[]): void {
  const errors: unknown[] = [];
  for (const item of items) {
    try {
      item.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'несколько ошибок при снятии');
}
