/*
 * Кольцо диагностики в памяти (K-30, FR-CH-4011, У-49): ёмкость по числу записей, при переполнении уходит старейшая запись самого шумного владельца,
 * поэтому плагин, пишущий в цикле, не вытесняет записи соседей. Записи, которые держат состояние плагина (`keep`), из кольца не уходят,
 * пока есть что вытеснить кроме них.
 */

interface Slot<T> {
  readonly seq: number;
  readonly value: T;
}

/** Очередь без сдвига массива на каждое вытеснение: голова двигается, хвост подрезается пачкой. */
class Queue<T> {
  #items: Slot<T>[] = [];
  #head = 0;

  get length(): number {
    return this.#items.length - this.#head;
  }

  /** Номер старейшей записи; пустая очередь - бесконечность, чтобы проиграть любую по возрасту. */
  get oldest(): number {
    return this.#items[this.#head]?.seq ?? Infinity;
  }

  push(slot: Slot<T>): void {
    this.#items.push(slot);
  }

  shift(): void {
    this.#head++;
    if (this.#head > 1024 && this.#head * 2 > this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
  }

  slots(): readonly Slot<T>[] {
    return this.#head === 0 ? this.#items : this.#items.slice(this.#head);
  }
}

export interface RingLimits {
  /** Записей в кольце всего. */
  readonly capacity: number;
  /** Записей одного владельца без `keep`: сверх этого уходит его же старейшая, остальных не трогая. */
  readonly perOwner: number;
}

export class DiagnosticsRing<T> {
  readonly #limits: RingLimits;
  readonly #byOwner = new Map<string, Queue<T>>();
  readonly #kept = new Queue<T>();
  #seq = 0;
  #size = 0;

  constructor(limits: RingLimits) {
    this.#limits = limits;
  }

  get size(): number {
    return this.#size;
  }

  /** Записей владельца без `keep` сейчас в кольце. */
  countOf(owner: string): number {
    return this.#byOwner.get(owner)?.length ?? 0;
  }

  /** `owner` - плагин (или метка хоста), чей это поток; `keep` - запись нужна, чтобы вывести состояние, её шумный сосед не вытеснит. */
  add(value: T, owner: string, keep: boolean): void {
    const slot = { seq: this.#seq++, value };
    this.#size++;
    if (keep) {
      this.#kept.push(slot);
    } else {
      let queue = this.#byOwner.get(owner);
      if (!queue) {
        queue = new Queue();
        this.#byOwner.set(owner, queue);
      }
      queue.push(slot);
      if (queue.length > this.#limits.perOwner) {
        queue.shift();
        this.#size--;
      }
    }
    while (this.#size > this.#limits.capacity) this.#evict();
  }

  /** Записи в порядке добавления. */
  entries(): T[] {
    const all = [...this.#kept.slots(), ...[...this.#byOwner.values()].flatMap((q) => q.slots())];
    return all.sort((a, b) => a.seq - b.seq).map((s) => s.value);
  }

  /** Уходит старейшая запись самого шумного владельца (при равенстве - того, чья запись старше); остались одни `keep` - старейшая из них. */
  #evict(): void {
    let loudest: Queue<T> | undefined;
    let owner = '';
    for (const [name, queue] of this.#byOwner) {
      if (queue.length === 0) continue;
      if (!loudest || queue.length > loudest.length || (queue.length === loudest.length && queue.oldest < loudest.oldest)) {
        loudest = queue;
        owner = name;
      }
    }
    if (loudest) {
      loudest.shift();
      if (loudest.length === 0) this.#byOwner.delete(owner);
    } else {
      this.#kept.shift();
    }
    this.#size--;
  }
}
