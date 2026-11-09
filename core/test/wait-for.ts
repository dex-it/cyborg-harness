import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

export const DEFAULT_TIMEOUT = 15_000;
export const DEFAULT_INTERVAL = 10;

export interface WaitForOptions {
  /** Общий предел ожидания, мс. Большой запас нужен медленному раннеру CI, а не готовому условию: оно возвращается сразу. */
  readonly timeout?: number;
  /** Шаг между пробами, мс. */
  readonly interval?: number;
}

/**
 * Ждёт наблюдаемого условия, а не срока: проба зовётся, пока не вернёт значение, кроме `false` и `undefined`, и это значение возвращается.
 * Исключение пробы - «ещё не готово» (файла ещё нет); по пределу оно идёт в сообщение вместе с названием условия.
 * Фиксированная пауза («подождём 20 мс») на нагруженном раннере то слишком коротка, то впустую долга.
 */
export async function waitFor<T>(what: string, probe: () => T | Promise<T>, { timeout = DEFAULT_TIMEOUT, interval = DEFAULT_INTERVAL }: WaitForOptions = {}): Promise<Exclude<T, false | undefined>> {
  const end = Date.now() + timeout;
  let probes = 0;
  let last: unknown;
  for (;;) {
    probes++;
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value as Exclude<T, false | undefined>;
      last = undefined;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= end) break;
    await sleep(interval);
  }
  const reason = last instanceof Error ? `; последняя ошибка пробы: ${last.message}` : last === undefined ? '' : `; последняя ошибка пробы: ${String(last)}`;
  assert.fail(`${what}: не дождались за ${String(timeout)} мс (проб: ${String(probes)})${reason}`);
}
