import type { LogLevel } from '@cyborg-harness/contracts';

/** Уровни строки `ctx.log` и вывода хоста; порядок - от обычного к тяжёлому. */
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];

/** Чем ядро заменяет в строках плагина значение из хранилища секретов. */
export const SECRET_MARK = '[секрет]';

/**
 * Строка не длиннее `maxBytes` байт UTF-8 как есть; длиннее - голова по границе символа и пометка с полным размером.
 * `total` - размер исходной строки в байтах, если `text` уже её начало (обрезанное до обработки).
 */
export function clipLine(text: string, maxBytes: number, total = Buffer.byteLength(text)): string {
  if (total <= maxBytes) return text;
  const bytes = Buffer.from(text.length > maxBytes ? text.slice(0, maxBytes) : text);
  let cut = Math.min(bytes.length, maxBytes);
  // Продолжение многобайтового символа в первом отброшенном байте - символ разрезан: голова кончается перед ним.
  while (cut > 0 && cut < bytes.length && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--;
  return `${bytes.subarray(0, cut).toString('utf8')} [обрезано: всего ${String(total)} Б]`;
}

/** Короче этого значение не вычёркивается: скрыть его нельзя (перебор тривиален), а замена каждого вхождения портит строку, в том числе чужую. */
export const MIN_SECRET_LENGTH = 4;

/** Значения из `secrets` вычёркиваются из строки; длинные раньше коротких, чтобы значение, содержащее другое, не осталось хвостом. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const value of [...secrets].sort((a, b) => b.length - a.length)) if (value.length >= MIN_SECRET_LENGTH) out = out.replaceAll(value, SECRET_MARK);
  return out;
}
