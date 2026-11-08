import { isRecord } from './wire.ts';

/**
 * Отмена вызова через границу хоста (SAD 4, «Отмена запросов»).
 *
 * `AbortSignal` не переживает structuredClone, поэтому сигнал идёт отдельно от аргументов: вызывающий кладёт его ПОСЛЕДНИМ аргументом,
 * хост заменяет его меткой `{ [SIGNAL]: true }` на том же месте, а сама отмена едет сообщением `cancel` на запрос (rpc.ts).
 * Поставщик получает на место метки свой `AbortSignal` запроса. Нет сигнала у вызывающего - на проводе нет метки, поставщик видит `undefined`.
 */
export const SIGNAL = '$cyborg.signal';

/** Последний аргумент - сигнал отмены. */
export function splitSignal(args: readonly unknown[]): { readonly args: unknown[]; readonly signal: AbortSignal | undefined } {
  const last = args.at(-1);
  if (!(last instanceof AbortSignal)) return { args: [...args], signal: undefined };
  return { args: [...args.slice(0, -1), { [SIGNAL]: true }], signal: last };
}

const isMark = (value: unknown): boolean => isRecord(value) && Object.keys(value).length === 1 && value[SIGNAL] === true;

/** На проводе последний аргумент - метка сигнала. */
export function hasSignalMark(args: readonly unknown[]): boolean {
  return isMark(args.at(-1));
}

/** Метка на месте последнего аргумента становится сигналом запроса; метка в другом месте - обычные данные. */
export function withSignal(args: readonly unknown[], signal: AbortSignal): unknown[] {
  return hasSignalMark(args) ? [...args.slice(0, -1), signal] : [...args];
}

/** Аргументы без метки сигнала: для проверки по схеме, где сигнала нет. */
export function withoutMark(args: readonly unknown[]): unknown[] {
  return hasSignalMark(args) ? args.slice(0, -1) : [...args];
}
