import type { JournalEntry } from './loader.ts';

export const MAX_DENIED = 1000;
export const DENIED_WINDOW_MS = 5000;

type Denied = Extract<JournalEntry, { kind: 'denied' }>;

/** Отказов в списке не больше `limit`, старейший уходит; прочие записи не трогаются: из них выводится состояние плагинов. */
export function appendBounded<T>(list: T[], item: T, entryOf: (item: T) => JournalEntry, limit = MAX_DENIED): void {
  list.push(item);
  if (entryOf(item).kind !== 'denied') return;
  let denied = 0;
  for (const x of list) if (entryOf(x).kind === 'denied') denied++;
  if (denied > limit) list.splice(list.findIndex((x) => entryOf(x).kind === 'denied'), 1);
}

/** Одинаковые отказы плагина склеиваются: первый пишется сразу, повторы за окно - одной записью с `repeats` в его конце. */
export class DeniedCollapse {
  readonly #write: (entry: Denied) => void;
  readonly #windowMs: number;
  readonly #slots = new Map<string, { readonly entry: Denied; repeats: number; readonly timer: ReturnType<typeof setTimeout> }>();

  constructor(write: (entry: Denied) => void, windowMs = DENIED_WINDOW_MS) {
    this.#write = write;
    this.#windowMs = windowMs;
  }

  record(entry: Denied): void {
    const key = JSON.stringify([entry.pluginId, entry.method, entry.detail, entry.reason ?? null]);
    const slot = this.#slots.get(key);
    if (slot) {
      slot.repeats++;
      return;
    }
    this.#write(entry);
    const timer = setTimeout(() => this.#close(key), this.#windowMs);
    timer.unref();
    this.#slots.set(key, { entry, repeats: 0, timer });
  }

  /** Выгрузка: счёт повторов не теряется вместе с таймерами. */
  flush(): void {
    for (const key of [...this.#slots.keys()]) this.#close(key);
  }

  #close(key: string): void {
    const slot = this.#slots.get(key);
    if (!slot) return;
    this.#slots.delete(key);
    clearTimeout(slot.timer);
    if (slot.repeats > 0) this.#write({ ...slot.entry, repeats: slot.repeats });
  }
}
