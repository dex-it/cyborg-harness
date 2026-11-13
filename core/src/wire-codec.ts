import type { Port } from './rpc.ts';

// TR-21 (ADR-CH-0019, п. 3): кодек типов для канала `json`. Хост стороннего плагина - отдельный процесс Node, а у Node 24 V8 13.6 против 15.6 в Electron 45: сериализация
// `advanced` (v8.serialize) между ними не читается (docs/05-verification/spike-node-host.md). Канал `json` читают обе стороны, но он теряет Map, Set, Date, BigInt, байты, Error.
// Кодек сводит значения, которые переживает structuredClone, к тегированному JSON (`{ "$t": "Map", "v": [...] }`) и отвергает то, что structuredClone отвергает:
// функцию, Symbol, Promise, WeakMap и циклическую ссылку. Общая (не циклическая) ссылка копируется дважды, тождество объектов через границу не сохраняется.
// Разбор недоверенный: хост плагина - чужой код, тег с неверной формой - ошибка кодека, а ключи `__proto__` и `$t` в данных остаются данными.

/** Аргумент хоста: канал идёт тегированным JSON (`serialization: 'json'`), хост разбирает сообщения кодеком. */
export const WIRE_JSON = '--wire=json';

const TAG = '$t';
const MAX_DEPTH = 500;

const TYPED = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array } as const;
type TypedName = keyof typeof TYPED;
const ERRORS = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError } as const;
type ErrorName = keyof typeof ERRORS;

const isTypedName = (name: unknown): name is TypedName => typeof name === 'string' && Object.hasOwn(TYPED, name);
const isErrorName = (name: unknown): name is ErrorName => typeof name === 'string' && Object.hasOwn(ERRORS, name);

const clone = (what: string): never => {
  throw new Error(`DataCloneError: ${what} не переживёт канал хоста (structuredClone его тоже отвергает)`);
};
const bad = (what: string): never => {
  throw new Error(`кодек канала хоста: ${what}`);
};

const isRecordLike = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function bytesOf(view: ArrayBufferView): string {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
}

/** Значение для JSON: типы, которые JSON теряет, - тегированные объекты. Бросает на том, что structuredClone не клонирует. */
export function encodeWire(value: unknown): unknown {
  return encode(value, new Set<object>(), 0);
}

function encode(value: unknown, ancestors: Set<object>, depth: number): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'undefined':
      return { [TAG]: 'undef' };
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0) ? value : { [TAG]: 'num', v: Object.is(value, -0) ? '-0' : String(value) };
    case 'bigint':
      return { [TAG]: 'BigInt', v: value.toString() };
    case 'function':
      return clone('функция');
    case 'symbol':
      return clone('Symbol');
    case 'object':
      break;
  }
  if (value === null) return null;
  if (depth > MAX_DEPTH) return clone('значение глубже предела вложенности');
  if (ancestors.has(value)) return clone('циклическая ссылка');
  ancestors.add(value);
  try {
    return encodeObject(value, ancestors, depth + 1);
  } finally {
    ancestors.delete(value);
  }
}

function encodeObject(value: object, ancestors: Set<object>, depth: number): unknown {
  if (Array.isArray(value)) return encodeArray(value, ancestors, depth);
  if (value instanceof Date) return { [TAG]: 'Date', v: Number.isNaN(value.getTime()) ? null : value.getTime() };
  if (value instanceof Map) return { [TAG]: 'Map', v: [...value].map(([k, v]) => [encode(k, ancestors, depth), encode(v, ancestors, depth)]) };
  if (value instanceof Set) return { [TAG]: 'Set', v: [...value].map((item) => encode(item, ancestors, depth)) };
  if (value instanceof ArrayBuffer) return { [TAG]: 'ArrayBuffer', v: Buffer.from(value).toString('base64') };
  if (ArrayBuffer.isView(value)) {
    const name = Buffer.isBuffer(value) ? 'Uint8Array' : value.constructor.name;
    if (!isTypedName(name)) return clone(`представление ${name}`);
    return { [TAG]: 'ta', n: name, v: bytesOf(value) };
  }
  if (value instanceof RegExp) return { [TAG]: 'RegExp', s: value.source, f: value.flags };
  if (value instanceof Error) {
    const { name } = value;
    return {
      [TAG]: 'Error',
      n: isErrorName(name) ? name : 'Error',
      m: value.message,
      ...(typeof value.stack === 'string' && { s: value.stack }),
      ...('cause' in value && { c: encode(value.cause, ancestors, depth) }),
    };
  }
  const kind = Object.prototype.toString.call(value);
  if (kind !== '[object Object]') return clone(kind.slice(8, -1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) Object.defineProperty(out, key, { value: encode((value as Record<string, unknown>)[key], ancestors, depth), enumerable: true, writable: true, configurable: true });
  // Объект данных с ключом `$t` не должен читаться как тег.
  return Object.hasOwn(out, TAG) ? { [TAG]: 'obj', v: out } : out;
}

function encodeArray(list: readonly unknown[], ancestors: Set<object>, depth: number): unknown {
  let holes = false;
  for (let i = 0; i < list.length; i++) {
    if (!(i in list)) {
      holes = true;
      break;
    }
  }
  if (!holes) return list.map((item) => encode(item, ancestors, depth));
  const entries: [number, unknown][] = [];
  for (let i = 0; i < list.length; i++) if (i in list) entries.push([i, encode(list[i], ancestors, depth)]);
  return { [TAG]: 'sparse', l: list.length, v: entries };
}

/** Значение после JSON.parse: теги разобраны. Тег не по форме - ошибка кодека. */
export function decodeWire(raw: unknown): unknown {
  return decode(raw, 0);
}

function decode(raw: unknown, depth: number): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  if (depth > MAX_DEPTH) return bad('вложенность глубже предела');
  if (Array.isArray(raw)) return raw.map((item) => decode(item, depth + 1));
  const tag = (raw as Record<string, unknown>)[TAG];
  if (tag === undefined || !Object.hasOwn(raw, TAG)) return plain(raw as Record<string, unknown>, depth);
  return tagged(raw as Record<string, unknown>, tag, depth);
}

/** Объект данных: ключи копируются как собственные свойства (`__proto__` - тоже), прототип остаётся Object.prototype. */
function plain(raw: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) Object.defineProperty(out, key, { value: decode(raw[key], depth + 1), enumerable: true, writable: true, configurable: true });
  return out;
}

function list(raw: Record<string, unknown>, what: string): unknown[] {
  return Array.isArray(raw.v) ? (raw.v as unknown[]) : bad(`${what}: ожидался список`);
}

function base64Of(raw: Record<string, unknown>, what: string): Buffer {
  const text = raw.v;
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return bad(`${what}: байты не в base64`);
  return Buffer.from(text, 'base64');
}

function tagged(raw: Record<string, unknown>, tag: unknown, depth: number): unknown {
  switch (tag) {
    case 'undef':
      return undefined;
    case 'num': {
      const text = raw.v;
      if (text === 'NaN') return Number.NaN;
      if (text === 'Infinity') return Number.POSITIVE_INFINITY;
      if (text === '-Infinity') return Number.NEGATIVE_INFINITY;
      if (text === '-0') return -0;
      return bad('число: неизвестное значение');
    }
    case 'BigInt':
      return typeof raw.v === 'string' && /^-?\d+$/.test(raw.v) ? BigInt(raw.v) : bad('BigInt: ожидалось целое в десятичной записи');
    case 'Date':
      if (raw.v === null) return new Date(Number.NaN);
      return typeof raw.v === 'number' && Number.isFinite(raw.v) ? new Date(raw.v) : bad('Date: ожидалось число или null');
    case 'Map':
      return new Map(
        list(raw, 'Map').map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2) return bad('Map: ожидалась пара');
          const [k, v] = pair as [unknown, unknown];
          return [decode(k, depth + 1), decode(v, depth + 1)] as const;
        }),
      );
    case 'Set':
      return new Set(list(raw, 'Set').map((item) => decode(item, depth + 1)));
    case 'ArrayBuffer': {
      const bytes = base64Of(raw, 'ArrayBuffer');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    case 'ta': {
      if (!isTypedName(raw.n)) return bad('типизированный массив: неизвестное имя');
      const bytes = base64Of(raw, 'типизированный массив');
      const Ctor = TYPED[raw.n];
      if (bytes.byteLength % Ctor.BYTES_PER_ELEMENT !== 0) return bad('типизированный массив: длина не кратна размеру элемента');
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return new Ctor(copy as ArrayBuffer);
    }
    case 'RegExp':
      if (typeof raw.s !== 'string' || typeof raw.f !== 'string') return bad('RegExp: ожидались source и flags');
      try {
        return new RegExp(raw.s, raw.f);
      } catch {
        return bad('RegExp: не разобралось');
      }
    case 'Error': {
      if (!isErrorName(raw.n) || typeof raw.m !== 'string') return bad('Error: ожидались имя и сообщение');
      const error = 'c' in raw ? new ERRORS[raw.n](raw.m, { cause: decode(raw.c, depth + 1) }) : new ERRORS[raw.n](raw.m);
      if (typeof raw.s === 'string') Object.defineProperty(error, 'stack', { value: raw.s, writable: true, configurable: true, enumerable: false });
      return error;
    }
    case 'sparse': {
      if (typeof raw.l !== 'number' || !Number.isSafeInteger(raw.l) || raw.l < 0 || raw.l > 2 ** 32 - 1) return bad('разреженный массив: длина');
      const out = new Array<unknown>(raw.l);
      for (const entry of list(raw, 'разреженный массив')) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'number' || !Number.isSafeInteger(entry[0]) || entry[0] < 0 || entry[0] >= raw.l) return bad('разреженный массив: запись');
        out[entry[0]] = decode(entry[1], depth + 1);
      }
      return out;
    }
    case 'obj':
      return isRecordLike(raw.v) ? plain(raw.v, depth) : bad('obj: ожидался объект');
    default:
      return bad(`неизвестный тег ${typeof tag === 'string' ? tag : typeof tag}`);
  }
}

/**
 * Порт, у которого сообщения идут тегированным JSON: исходящее кодируется, входящее разбирается. Входящее, которое не разобралось, отбрасывается: чужой хост не должен ронять разбор в ядре.
 * `onInvalid` узнаёт, что отброшено (для журнала строк хоста).
 */
export function jsonPort(port: Port, onInvalid?: (error: unknown) => void): Port {
  return {
    post: (message) => port.post(encodeWire(message)),
    onMessage: (listener) =>
      port.onMessage((raw) => {
        let message: unknown;
        try {
          message = decodeWire(raw);
        } catch (error) {
          onInvalid?.(error);
          return;
        }
        listener(message);
      }),
  };
}
