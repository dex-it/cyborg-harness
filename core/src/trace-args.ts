import { clipLine, MIN_SECRET_LENGTH, redactSecrets } from './log-text.ts';

/*
 * Аргументы операции в записи трассы (K-33, решение владельца 2026-11-11): только по флагу запуска `--trace-args` (`LoadOptions.traceArgs`).
 * Текст строится обходом значения с теми же пределами формы, что у `bytesOf` (глубина, число узлов), значения секретов вычёркиваются (`redactSecrets`, K-29)
 * в каждой строке и каждом ключе до экранирования, а итог не длиннее `LIMITS.traceArgsBytes`: остаток отрезается с пометкой `clipLine`.
 */

const MAX_NODES = 1000;
const MAX_DEPTH = 8;

interface Walk {
  readonly parts: string[];
  /** Знаков в `parts`. */
  used: number;
  /** Знаков, после которых обход останавливается. */
  readonly limit: number;
  /** Запас на значение секрета, разрезанное границей: строка берётся с запасом, вычёркивается и только потом идёт в текст. */
  readonly slack: number;
  readonly secrets: readonly string[];
  nodes: number;
  /** Весь ли аргумент попал в текст: нет, если обход остановили предел знаков, число узлов или глубина. */
  complete: boolean;
}

function put(w: Walk, text: string): void {
  w.parts.push(text);
  w.used += text.length;
}

function quote(w: Walk, text: string): string {
  const reach = Math.max(0, w.limit - w.used) + w.slack;
  const head = text.length > reach ? text.slice(0, reach) : text;
  if (head !== text) w.complete = false;
  return JSON.stringify(redactSecrets(head, w.secrets));
}

/** Значение без внутренностей одной меткой; `undefined` - у объекта и массива, которые обходятся. */
function leaf(w: Walk, value: unknown): string | undefined {
  if (typeof value === 'string') return quote(w, value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return `${String(value)}n`;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return '[symbol]';
  if (value === null) return 'null';
  if (typeof value !== 'object') return 'undefined';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[bytes ${String(value.byteLength)}]`;
  if (value instanceof Map) return `[Map ${String(value.size)}]`;
  if (value instanceof Set) return `[Set ${String(value.size)}]`;
  return undefined;
}

function walk(w: Walk, value: unknown, depth: number): void {
  if (w.used >= w.limit) {
    w.complete = false;
    return;
  }
  const text = leaf(w, value);
  if (text !== undefined) {
    put(w, text);
    return;
  }
  if (depth >= MAX_DEPTH) {
    w.complete = false;
    put(w, '[…]');
    return;
  }
  const object = value as object;
  const array = Array.isArray(object);
  put(w, array ? '[' : '{');
  let first = true;
  // Лениво, как `bytesOf`: объект на миллион ключей не копируется в список ради первой тысячи.
  for (const key in object) {
    if (--w.nodes < 0 || w.used >= w.limit) {
      w.complete = false;
      break;
    }
    if (!first) put(w, ',');
    first = false;
    if (!array) put(w, `${quote(w, key)}:`);
    walk(w, (object as Record<string, unknown>)[key], depth + 1);
  }
  put(w, array ? ']' : '}');
}

/**
 * Текст аргументов для записи трассы. `limit` - предел в байтах (`LIMITS.traceArgsBytes`), `secrets` - значения, которые нельзя оставлять
 * (`OsGateway.secretValues`), `sizeBytes` - размер аргументов из `bytesOf` для пометки, когда обход остановился раньше конца.
 */
export function describeArgs(value: unknown, limit: number, secrets: readonly string[], sizeBytes: number): string {
  const slack = secrets.reduce((n, s) => (s.length >= MIN_SECRET_LENGTH ? Math.max(n, s.length) : n), 0);
  const w: Walk = { parts: [], used: 0, limit, slack, secrets, nodes: MAX_NODES, complete: true };
  walk(w, value, 0);
  return clipLine(w.parts.join(''), limit, w.complete ? undefined : Math.max(sizeBytes, limit + 1));
}
