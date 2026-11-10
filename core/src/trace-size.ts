/** Сколько узлов значения считается; дальше размер - оценка снизу: запись трассы не должна стоить дороже самой операции. */
const MAX_NODES = 1000;
const MAX_DEPTH = 8;

/**
 * Размер значения в байтах без его копирования и без вывода содержимого: строка - UTF-8, буфер - его длина, число - 8, булево - 1, объект и массив -
 * сумма частей и ключей. Карты, множества, функции и ничто не считаются нулём, глубже `MAX_DEPTH` и после `MAX_NODES` узлов счёт останавливается.
 * Одинаковый размер у разных значений допустим: трасса показывает порядок величины, а не содержимое (FR-CH-4004).
 */
export function bytesOf(value: unknown): number {
  const budget = { nodes: MAX_NODES };
  return count(value, 0, budget);
}

function count(value: unknown, depth: number, budget: { nodes: number }): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 1;
  if (typeof value !== 'object' || value === null) return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (depth >= MAX_DEPTH) return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      if (--budget.nodes < 0) break;
      total += count(item, depth + 1, budget);
    }
    return total;
  }
  for (const key in value) {
    if (--budget.nodes < 0) break;
    total += Buffer.byteLength(key) + count((value as Record<string, unknown>)[key], depth + 1, budget);
  }
  return total;
}
