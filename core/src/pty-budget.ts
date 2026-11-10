import { CoreError } from './errors.ts';

/**
 * Запас ввода одного pty (#134, У-47): ведро байт. Ядро не видит, читает ли программа stdin: node-pty очередь записи наружу не отдаёт,
 * и `proc.write` у программы, которая не читает (`tail -f`, `sleep`), копит данные в памяти без предела. Поэтому ограничены сами байты:
 * сразу можно отдать до `burst` (вставка вдвое больше предела одного ввода, набор текста), дальше - не быстрее `rate` байт в секунду.
 * Принятое сверх запаса не списывается и не принимается частью: ввод целиком или `Invalid`.
 */
export class InputBudget {
  readonly #burst: number;
  readonly #rate: number;
  readonly #now: () => number;
  #left: number;
  #at: number;

  constructor(burst: number, rate: number, now: () => number = () => Date.now()) {
    this.#burst = burst;
    this.#rate = rate;
    this.#now = now;
    this.#left = burst;
    this.#at = now();
  }

  /** Списывает `bytes` из запаса; запаса не хватило - `Invalid`, запас не тронут. */
  take(bytes: number): void {
    const at = this.#now();
    // Часы могли уйти назад: пополнения за это время нет, а запас не отрицателен.
    this.#left = Math.min(this.#burst, this.#left + (Math.max(0, at - this.#at) / 1000) * this.#rate);
    this.#at = at;
    if (bytes > this.#left) {
      throw new CoreError('Invalid', `pty: ввод быстрее ${String(this.#rate)} Б/с и сверх запаса ${String(this.#burst)} Б - программа не успевает читать, повторите позже`);
    }
    this.#left -= bytes;
  }
}

/** Размер ввода в байтах UTF-8; больше предела одного ввода (`max`) - `Invalid`. Одно правило для главного процесса и pty-хоста. */
export function inputBytes(data: string, max: number): number {
  // Байт UTF-8 не меньше длины строки: до подсчёта отсекается очевидное.
  const bytes = data.length > max ? Infinity : Buffer.byteLength(data, 'utf8');
  if (bytes > max) throw new CoreError('Invalid', `pty: ввод больше ${String(max)} байт - разбейте его на части`);
  return bytes;
}
