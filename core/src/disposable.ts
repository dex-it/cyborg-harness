import type { Disposable, DisposableStore as Store } from '@cyborg/contracts';

export type { Disposable };

// Наборы хранилищ, где лежит снятие: снятое само уходит из них, а не держит замыкание до конца жизни плагина.
const holders = new WeakMap<Disposable, Set<Set<Disposable>>>();

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  const disposable: Disposable = {
    dispose() {
      if (done) return;
      done = true;
      for (const items of holders.get(disposable) ?? []) items.delete(disposable);
      holders.delete(disposable);
      fn();
    },
  };
  holders.set(disposable, new Set());
  return disposable;
}

/** Снимает добавленное в обратном порядке; ошибка одного не мешает снять остальные. */
export class DisposableStore implements Store {
  #items = new Set<Disposable>();
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  add(...items: Disposable[]): void {
    if (this.#disposed) {
      disposeAll(items);
      return;
    }
    for (const item of items) {
      this.#items.add(item);
      holders.get(item)?.add(this.#items);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = [...this.#items].reverse();
    this.#items.clear();
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
