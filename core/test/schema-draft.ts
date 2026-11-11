import { isRecord } from '../src/wire.ts';

// Проверка значения по JSON Schema draft-07 в объёме, который нужен схеме манифеста (contracts/manifest.schema.json). Зависимостей у репозитория нет,
// а `compileSchema` ядра понимает только подмножество для схем `config` автора (нет anyOf, oneOf, not, propertyNames). Ключ вне перечня - исключение,
// чтобы схема не выросла за пределы того, что проверено этим кодом и тестом на него (`manifest-schema.test.ts`).

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'definitions']);

type Schema = Record<string, unknown> | boolean;

const typeOf = (v: unknown, type: string): boolean => {
  switch (type) {
    case 'object':
      return isRecord(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      throw new Error(`тип ${type} не поддерживается`);
  }
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Ошибки значения по схеме с путём JSON Pointer; пустой список - значение годно. */
export function validateDraft(schema: Schema, value: unknown, root: Record<string, unknown> = isRecord(schema) ? schema : {}, at = ''): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at || '/'}: запрещено схемой`];
  const out: string[] = [];
  const here = at || '/';
  const ok = (sub: Schema, v: unknown = value): boolean => validateDraft(sub, v, root, at).length === 0;
  if (typeof schema.$ref === 'string') {
    const match = /^#\/definitions\/([\w.-]+)$/.exec(schema.$ref);
    const definitions = isRecord(root.definitions) ? root.definitions : {};
    const target = match?.[1] === undefined ? undefined : definitions[match[1]];
    if (target === undefined) throw new Error(`ссылка ${schema.$ref} не разрешается`);
    return validateDraft(target as Schema, value, root, at);
  }
  for (const [key, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    switch (key) {
      case 'type': {
        const types = typeof rule === 'string' ? [rule] : (rule as string[]);
        if (!types.some((t) => typeOf(value, t))) out.push(`${here}: ожидается ${types.join(' или ')}`);
        break;
      }
      case 'enum':
        if (!(rule as unknown[]).some((e) => same(e, value))) out.push(`${here}: значение вне перечня`);
        break;
      case 'const':
        if (!same(rule, value)) out.push(`${here}: ожидается ${JSON.stringify(rule)}`);
        break;
      case 'pattern':
        if (typeof value === 'string' && !new RegExp(rule as string, 'u').test(value)) out.push(`${here}: не подходит под ${String(rule)}`);
        break;
      case 'minLength':
        if (typeof value === 'string' && Array.from(value).length < (rule as number)) out.push(`${here}: короче ${String(rule)}`);
        break;
      case 'maxLength':
        if (typeof value === 'string' && Array.from(value).length > (rule as number)) out.push(`${here}: длиннее ${String(rule)}`);
        break;
      case 'minimum':
        if (typeof value === 'number' && value < (rule as number)) out.push(`${here}: меньше ${String(rule)}`);
        break;
      case 'maximum':
        if (typeof value === 'number' && value > (rule as number)) out.push(`${here}: больше ${String(rule)}`);
        break;
      case 'minItems':
        if (Array.isArray(value) && value.length < (rule as number)) out.push(`${here}: элементов меньше ${String(rule)}`);
        break;
      case 'maxItems':
        if (Array.isArray(value) && value.length > (rule as number)) out.push(`${here}: элементов больше ${String(rule)}`);
        break;
      case 'uniqueItems':
        if (rule === true && Array.isArray(value) && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) out.push(`${here}: элементы повторяются`);
        break;
      case 'items':
        if (Array.isArray(value)) value.forEach((item, i) => out.push(...validateDraft(rule as Schema, item, root, `${at}/${String(i)}`)));
        break;
      case 'required':
        if (isRecord(value)) for (const name of rule as string[]) if (!Object.hasOwn(value, name)) out.push(`${at}/${name}: обязательное поле`);
        break;
      case 'properties':
        if (isRecord(value)) for (const [name, sub] of Object.entries(rule as Record<string, Schema>)) if (Object.hasOwn(value, name)) out.push(...validateDraft(sub, value[name], root, `${at}/${name}`));
        break;
      case 'additionalProperties':
        if (isRecord(value)) {
          const known = new Set(Object.keys(isRecord(schema.properties) ? schema.properties : {}));
          for (const name of Object.keys(value)) if (!known.has(name)) out.push(...validateDraft(rule as Schema, value[name], root, `${at}/${name}`));
        }
        break;
      case 'propertyNames':
        if (isRecord(value)) for (const name of Object.keys(value)) out.push(...validateDraft(rule as Schema, name, root, `${at}/${name}`));
        break;
      case 'minProperties':
        if (isRecord(value) && Object.keys(value).length < (rule as number)) out.push(`${here}: полей меньше ${String(rule)}`);
        break;
      case 'maxProperties':
        if (isRecord(value) && Object.keys(value).length > (rule as number)) out.push(`${here}: полей больше ${String(rule)}`);
        break;
      case 'allOf':
        for (const sub of rule as Schema[]) out.push(...validateDraft(sub, value, root, at));
        break;
      case 'anyOf':
        if (!(rule as Schema[]).some((sub) => ok(sub))) out.push(`${here}: не подходит ни под один вариант`);
        break;
      case 'oneOf': {
        const hits = (rule as Schema[]).filter((sub) => ok(sub)).length;
        if (hits !== 1) out.push(`${here}: подходит под ${String(hits)} вариантов, нужен один`);
        break;
      }
      case 'not':
        if (ok(rule as Schema)) out.push(`${here}: подходит под запрещённый вариант`);
        break;
      default:
        throw new Error(`ключ схемы ${key} не поддерживается проверкой`);
    }
  }
  return out;
}
