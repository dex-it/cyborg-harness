import { CoreError } from './errors.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Значение по ключу из недоверенного имени: `constructor` и `__proto__` иначе нашлись бы в прототипе. */
export function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

const KINDS = {
  string: (v: unknown): v is string => typeof v === 'string',
  number: (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v),
  boolean: (v: unknown): v is boolean => typeof v === 'boolean',
  array: (v: unknown): v is unknown[] => Array.isArray(v),
  strings: (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  record: isRecord,
  any: (v: unknown): v is unknown => v !== undefined,
} as const;

export type WireKind = keyof typeof KINDS;

export function isWireKind(name: string): name is WireKind {
  return Object.hasOwn(KINDS, name);
}

export function matchesKind(kind: WireKind, value: unknown): boolean {
  return KINDS[kind](value);
}

/** Поле - вид значения либо перечень допустимых строк. */
export type WireSpec = Readonly<Record<string, WireKind | readonly string[]>>;
type TypeOf<K> = K extends WireKind
  ? (typeof KINDS)[K] extends (v: unknown) => v is infer T
    ? T
    : never
  : K extends readonly (infer L)[]
    ? L
    : never;
export type Parsed<S extends WireSpec> = { readonly [F in keyof S]: TypeOf<S[F]> };

/** Сообщение хоста по форме; TypeScript-тип параметров обработчика ничего не гарантирует - хост вне доверия. */
export function parseWire<const S extends WireSpec>(method: string, value: unknown, spec: S): Parsed<S> {
  if (!isRecord(value)) throw new CoreError('Invalid', `${method}: параметры не объект`);
  for (const [field, kind] of Object.entries(spec)) {
    const v = value[field];
    const ok = typeof kind === 'string' ? KINDS[kind](v) : typeof v === 'string' && kind.includes(v);
    if (!ok) throw new CoreError('Invalid', `${method}: поле ${field} не ${typeof kind === 'string' ? kind : kind.join(' | ')}`);
  }
  return value as Parsed<S>;
}
