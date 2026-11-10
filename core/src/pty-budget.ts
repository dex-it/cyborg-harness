import { CoreError } from './errors.ts';

/**
 * Запас ввода одного pty (#134, У-47): ведро байт. Ядро не видит, читает ли программа stdin: node-pty очередь записи наружу не отдаёт,
 * и `proc.write` у программы, которая не читает (`tail -f`, `sleep`), копит данные в памяти без предела. Поэтому ограничены сами байты:
 * сразу можно отдать до `burst` (вставка вдвое больше предела одного ввода, набор текста), дальше - не быстрее `rate` байт в секунду.
 * Принятое сверх запаса не списывается и не принимается частью: ввод целиком или `Invalid`.
 *
 * Потолок невычитанного (#167): ведро ограничивает скорость, а не размер, и программа, молчащая и не читающая stdin, копила бы очередь без предела (до 900 МиБ в час).
 * node-pty 1.1 очередь записи и события дренажа не отдаёт, и приватное `_writeStream._writeQueue` не читается, поэтому признаком чтения служит вывод программы:
 * принятое без единого байта её вывода (`heard()`) считается непрочитанным, а сверх `queue` ввод отклоняется. Программа, которая печатает и не читает, потолок обнуляет.
 */
export class InputBudget {
  readonly #burst: number;
  readonly #rate: number;
  readonly #now: () => number;
  readonly #queue: number;
  #left: number;
  #at: number;
  /** Принято после последнего вывода программы. */
  #queued = 0;

  constructor(burst: number, rate: number, queue = Infinity, now: () => number = () => Date.now()) {
    this.#burst = burst;
    this.#rate = rate;
    this.#queue = queue;
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
    if (this.#queued + bytes > this.#queue) {
      throw new CoreError('Invalid', `pty: программа не читает ввод - принято ${String(this.#queued)} Б без её вывода, предел ${String(this.#queue)} Б; повторите, когда программа ответит`);
    }
    this.#left -= bytes;
    this.#queued += bytes;
  }

  /** Программа вывела байты: она жива и обрабатывает ввод, счёт непрочитанного начинается заново. */
  heard(): void {
    this.#queued = 0;
  }
}

/** Размер ввода в байтах UTF-8; больше предела одного ввода (`max`) - `Invalid`. Одно правило для главного процесса и pty-хоста. */
export function inputBytes(data: string, max: number): number {
  // Байт UTF-8 не меньше длины строки: до подсчёта отсекается очевидное.
  const bytes = data.length > max ? Infinity : Buffer.byteLength(data, 'utf8');
  if (bytes > max) throw new CoreError('Invalid', `pty: ввод больше ${String(max)} байт - разбейте его на части`);
  return bytes;
}
