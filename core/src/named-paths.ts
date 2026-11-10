import path from 'node:path';

/**
 * Пути, названные строками в значении config: абсолютные и от домашнего каталога (`~`, `~/…`), на любой глубине.
 * Ядро не знает, в каком поле плагин держит корни проектов, поэтому считает путём любую такую строку (ADR-CH-0015, п. 5).
 */
export function namedPaths(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      if (item === '~' || item.startsWith('~/') || path.isAbsolute(item)) out.push(item);
    } else if (Array.isArray(item)) {
      stack.push(...(item as unknown[]));
    } else if (typeof item === 'object' && item !== null) {
      stack.push(...Object.values(item));
    }
  }
  return out;
}
