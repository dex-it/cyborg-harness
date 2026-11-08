import type { JournalEntry } from './kernel-types.ts';

export const MAX_DENIED = 1000;
export const MAX_DEPRECATED = 1000;
export const DENIED_WINDOW_MS = 5000;
export const DEPRECATED_WINDOW_MS = 5000;

type Denied = Extract<JournalEntry, { kind: 'denied' }>;
type DeprecatedCall = Extract<JournalEntry, { kind: 'deprecated-call' }>;

/** Виды записей, которых в журнале не больше предела каждого: их поток идёт от плагина, а не от его состояния. */
const BOUNDS: Partial<Record<JournalEntry['kind'], number>> = { denied: MAX_DENIED, 'deprecated-call': MAX_DEPRECATED };

/** Записей каждого ограниченного вида в списке не больше `limit` (по умолчанию - предел вида); прочие записи не трогаются: из них выводится состояние плагинов. */
export function appendBounded<T>(list: T[], item: T, entryOf: (item: T) => JournalEntry, limit?: number): void {
  list.push(item);
  const kind = entryOf(item).kind;
  const bound = BOUNDS[kind];
  if (bound === undefined) return;
  const max = limit ?? bound;
  const byPlugin = new Map<string, number>();
  let count = 0;
  for (const x of list) {
    const e = entryOf(x);
    if (e.kind !== kind) continue;
    count++;
    const id = e.pluginId ?? '';
    byPlugin.set(id, (byPlugin.get(id) ?? 0) + 1);
  }
  if (count <= max) return;
  // Уходит старейшая запись самого шумного плагина: поток разных записей одного не вытесняет чужие.
  const [loudest] = [...byPlugin].reduce((a, b) => (b[1] > a[1] ? b : a));
  list.splice(list.findIndex((x) => {
    const e = entryOf(x);
    return e.kind === kind && (e.pluginId ?? '') === loudest;
  }), 1);
}

/** Одинаковые записи склеиваются: первая пишется сразу, повторы за окно - одной записью с `repeats` в его конце. */
class Collapse<E extends { readonly repeats?: number }> {
  readonly #write: (entry: E) => void;
  readonly #keyOf: (entry: E) => unknown[];
  readonly #windowMs: number;
  readonly #slots = new Map<string, { readonly entry: E; repeats: number; readonly timer: ReturnType<typeof setTimeout> }>();

  constructor(write: (entry: E) => void, keyOf: (entry: E) => unknown[], windowMs: number) {
    this.#write = write;
    this.#keyOf = keyOf;
    this.#windowMs = windowMs;
  }

  record(entry: E): void {
    const key = JSON.stringify(this.#keyOf(entry));
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

/** Одинаковые отказы плагина: тот же метод, подробность и причина. */
export class DeniedCollapse extends Collapse<Denied> {
  constructor(write: (entry: Denied) => void, windowMs = DENIED_WINDOW_MS) {
    super(write, (e) => [e.pluginId, e.method, e.detail, e.reason ?? null], windowMs);
  }
}

/** Вызовы одним плагином одного устаревшего члена одного контракта поставщика. */
export class DeprecatedCollapse extends Collapse<DeprecatedCall> {
  constructor(write: (entry: DeprecatedCall) => void, windowMs = DEPRECATED_WINDOW_MS) {
    super(write, (e) => [e.pluginId, e.provider, e.contract, e.member], windowMs);
  }
}
