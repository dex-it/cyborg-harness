import { isRecord } from './wire.ts';

/** Ошибки значения: путь JSON Pointer и что не так; пустой список - значение годно. */
export type SchemaCheck = (value: unknown) => string[];

type Node = (value: unknown, at: string, out: string[]) => void;

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly']);

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};

const canon = (v: unknown): string =>
  JSON.stringify(v, (_key, x: unknown) => (isRecord(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const pointer = (at: string, key: string | number) => `${at}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const where = (at: string) => (at === '' ? '/' : at);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Подмножество JSON Schema; ключ вне него - ошибка схемы, чтобы автор не считал проверенным то, что ядро не проверяет. */
export function compileSchema(raw: unknown): { readonly ok: true; readonly check: SchemaCheck } | { readonly ok: false; readonly errors: readonly string[] } {
  const errors: string[] = [];
  const root = node(raw, '#', errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    check: (value) => {
      const out: string[] = [];
      root(value, '', out);
      return out;
    },
  };
}

function node(raw: unknown, path: string, errors: string[]): Node {
  if (raw === true) return () => undefined;
  if (raw === false) return (_v, at, out) => void out.push(`${where(at)}: значение запрещено схемой`);
  if (!isRecord(raw)) {
    errors.push(`${path}: схема - объект или boolean`);
    return () => undefined;
  }
  const checks: Node[] = [];
  const bad = (key: string, expected: string) => errors.push(`${path}/${key}: ожидается ${expected}`);
  for (const [key, value] of Object.entries(raw)) {
    if (ANNOTATIONS.has(key)) continue;
    switch (key) {
      case 'type': {
        const list: unknown = typeof value === 'string' ? [value] : value;
        if (!Array.isArray(list) || list.length === 0 || !list.every((t) => typeof t === 'string' && TYPES.has(t))) {
          bad(key, `тип из ${[...TYPES].join(', ')} или их список`);
          break;
        }
        const types = list as string[];
        checks.push((v, at, out) => {
          const actual = typeOf(v);
          if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) out.push(`${where(at)}: ожидается ${types.join(' или ')}, получено ${actual}`);
        });
        break;
      }
      case 'enum': {
        if (!Array.isArray(value) || value.length === 0) {
          bad(key, 'непустой список');
          break;
        }
        const allowed = new Set(value.map(canon));
        const shown = value.map((x) => JSON.stringify(x)).join(', ');
        checks.push((v, at, out) => {
          if (!allowed.has(canon(v))) out.push(`${where(at)}: допустимо ${shown}`);
        });
        break;
      }
      case 'const': {
        const expected = canon(value);
        checks.push((v, at, out) => {
          if (canon(v) !== expected) out.push(`${where(at)}: допустимо только ${expected}`);
        });
        break;
      }
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum': {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          bad(key, 'число');
          break;
        }
        const sign = key === 'minimum' ? '>=' : key === 'maximum' ? '<=' : key === 'exclusiveMinimum' ? '>' : '<';
        const ok = (n: number) => (sign === '>=' ? n >= value : sign === '<=' ? n <= value : sign === '>' ? n > value : n < value);
        checks.push((v, at, out) => {
          if (typeof v === 'number' && !ok(v)) out.push(`${where(at)}: ожидается ${sign} ${String(value)}`);
        });
        break;
      }
      case 'minLength':
      case 'maxLength': {
        if (!count(value)) {
          bad(key, 'целое >= 0');
          break;
        }
        const min = key === 'minLength';
        checks.push((v, at, out) => {
          // Длина в символах, а не в единицах UTF-16, как в стандарте.
          const n = typeof v === 'string' ? Array.from(v).length : undefined;
          if (n !== undefined && (min ? n < value : n > value)) out.push(`${where(at)}: длина ${min ? '>=' : '<='} ${String(value)}`);
        });
        break;
      }
      case 'pattern': {
        let re: RegExp | undefined;
        try {
          re = typeof value === 'string' ? new RegExp(value, 'u') : undefined;
        } catch {
          re = undefined;
        }
        if (!re) {
          bad(key, 'регулярное выражение');
          break;
        }
        const pattern = re;
        checks.push((v, at, out) => {
          if (typeof v === 'string' && !pattern.test(v)) out.push(`${where(at)}: не подходит под ${pattern.source}`);
        });
        break;
      }
      case 'minItems':
      case 'maxItems': {
        if (!count(value)) {
          bad(key, 'целое >= 0');
          break;
        }
        const min = key === 'minItems';
        checks.push((v, at, out) => {
          if (Array.isArray(v) && (min ? v.length < value : v.length > value)) out.push(`${where(at)}: элементов ${min ? '>=' : '<='} ${String(value)}`);
        });
        break;
      }
      case 'uniqueItems': {
        if (typeof value !== 'boolean') {
          bad(key, 'boolean');
          break;
        }
        if (value) {
          checks.push((v, at, out) => {
            if (Array.isArray(v) && new Set(v.map(canon)).size !== v.length) out.push(`${where(at)}: элементы повторяются`);
          });
        }
        break;
      }
      case 'items': {
        const item = node(value, `${path}/items`, errors);
        checks.push((v, at, out) => {
          if (Array.isArray(v)) v.forEach((x, i) => item(x, pointer(at, i), out));
        });
        break;
      }
      case 'required': {
        if (!Array.isArray(value) || !value.every((k) => typeof k === 'string')) {
          bad(key, 'список имён полей');
          break;
        }
        const names = value;
        checks.push((v, at, out) => {
          if (isRecord(v)) for (const k of names) if (!Object.hasOwn(v, k)) out.push(`${pointer(at, k)}: обязательное поле`);
        });
        break;
      }
      case 'properties': {
        if (!isRecord(value)) {
          bad(key, 'объект схем полей');
          break;
        }
        const props = new Map(Object.entries(value).map(([k, s]) => [k, node(s, `${path}/properties/${k}`, errors)] as const));
        checks.push((v, at, out) => {
          if (isRecord(v)) for (const [k, check] of props) if (Object.hasOwn(v, k)) check(v[k], pointer(at, k), out);
        });
        break;
      }
      case 'additionalProperties': {
        const extra = node(value, `${path}/additionalProperties`, errors);
        const known = new Set(isRecord(raw.properties) ? Object.keys(raw.properties) : []);
        checks.push((v, at, out) => {
          if (isRecord(v)) for (const k of Object.keys(v)) if (!known.has(k)) extra(v[k], pointer(at, k), out);
        });
        break;
      }
      default:
        errors.push(`${path}: ключ ${key} не поддерживается`);
    }
  }
  return (v, at, out) => {
    for (const check of checks) check(v, at, out);
  };
}
