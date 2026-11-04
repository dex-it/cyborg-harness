import { CoreError } from './errors.ts';
import { isValidRange, parseVersion } from './semver.ts';
import { isRecord, isWireKind, matchesKind, type WireKind } from './wire.ts';

export { isRecord };

export interface ArgSpec {
  readonly kind: WireKind;
  readonly optional: boolean;
}

/** Аргументы команды: позиционные, необязательные только в хвосте; `rest` - вид всех остальных. */
export interface CommandSpec {
  readonly args: readonly ArgSpec[];
  readonly rest?: WireKind;
}

/** Манифест плагина; читается ядром до запуска кода плагина. */
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly engines: { readonly cyborg: string };
  /** Контракт -> версия или несколько мажорных версий одновременно. */
  readonly provides: Readonly<Record<string, readonly string[]>>;
  /** Кратность one, без поставщика плагин не активируется. */
  readonly requires: Readonly<Record<string, string>>;
  /** Кратность one, без поставщика плагин работает. */
  readonly optional: Readonly<Record<string, string>>;
  /** Кратность many, поставщики приходят и уходят во время работы. */
  readonly consumes: Readonly<Record<string, string>>;
  /** Имя -> аргументы; ядро сверяет их до вызова обработчика. */
  readonly commands: Readonly<Record<string, CommandSpec>>;
  readonly config?: { readonly version: number };
  readonly state?: { readonly version: number };
  /** `own` - просьба о своём хосте; пользователь вправе переопределить группой в `plugins.hosts`. */
  readonly host?: 'own';
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly id?: string | undefined; readonly errors: readonly string[] };

const ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

export function isValidId(value: string): boolean {
  return ID.test(value);
}

export function parseManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['манифест не объект'] };

  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (id === undefined || !isValidId(id)) errors.push(`id: ожидается имя вида "pin-lock" или "cyborg.files", получено ${show(raw.id)}`);

  const version = raw.version;
  if (typeof version !== 'string' || !parseVersion(version)) errors.push(`version: ожидается версия x.y.z, получено ${show(version)}`);

  const engines = isRecord(raw.engines) ? raw.engines.cyborg : undefined;
  if (typeof engines !== 'string' || !isValidRange(engines)) errors.push(`engines.cyborg: ожидается диапазон, получено ${show(engines)}`);

  const provides = readProvides(raw.provides, errors);
  const requires = readRanges('requires', raw.requires, errors);
  const optional = readRanges('optional', raw.optional, errors);
  const consumes = readRanges('consumes', raw.consumes, errors);

  for (const name of Object.keys(requires)) {
    if (name in optional) errors.push(`${name}: контракт одновременно в requires и optional`);
  }
  for (const name of Object.keys(consumes)) {
    if (name in requires || name in optional) errors.push(`${name}: контракт кратности many не может быть в requires или optional`);
  }

  const commands = readCommands(raw.commands, id, errors);
  const config = readSchemaVersion('config', raw.config, errors);
  const state = readSchemaVersion('state', raw.state, errors);
  if (raw.host !== undefined && raw.host !== 'own') errors.push(`host: допустимо только "own", получено ${show(raw.host)}`);

  if (errors.length > 0 || id === undefined || typeof version !== 'string' || typeof engines !== 'string') return { ok: false, id, errors };
  return {
    ok: true,
    manifest: {
      id,
      version,
      engines: { cyborg: engines },
      provides,
      requires,
      optional,
      consumes,
      commands,
      ...(config && { config }),
      ...(state && { state }),
      ...(raw.host === 'own' && { host: 'own' as const }),
    },
  };
}

function readProvides(raw: unknown, errors: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    errors.push('provides: ожидается объект');
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!isValidId(name)) errors.push(`provides.${name}: недопустимое имя контракта`);
    const list: unknown = typeof value === 'string' ? [value] : value;
    const versions = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string' && parseVersion(v) !== null) : [];
    if (!Array.isArray(list) || versions.length === 0 || versions.length !== list.length) {
      errors.push(`provides.${name}: ожидается версия или список версий, получено ${show(value)}`);
      continue;
    }
    const majors = versions.map((v) => parseVersion(v)?.[0]);
    if (new Set(majors).size !== majors.length) errors.push(`provides.${name}: две версии одной мажорной`);
    out[name] = versions;
  }
  return out;
}

function readRanges(field: string, raw: unknown, errors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    errors.push(`${field}: ожидается объект`);
    return out;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!isValidId(name)) errors.push(`${field}.${name}: недопустимое имя контракта`);
    if (typeof value !== 'string' || !isValidRange(value)) {
      errors.push(`${field}.${name}: ожидается диапазон, получено ${show(value)}`);
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** Список имён - команды без аргументов; объект - имя и `{ args, rest }`. */
function readCommands(raw: unknown, id: string | undefined, errors: string[]): Record<string, CommandSpec> {
  const out: Record<string, CommandSpec> = {};
  if (raw === undefined) return out;
  let entries: [string, unknown][];
  if (Array.isArray(raw) && raw.every((c) => typeof c === 'string')) {
    if (new Set(raw).size !== raw.length) errors.push('commands: имя повторяется');
    entries = raw.map((name) => [name, {}]);
  } else if (isRecord(raw)) {
    entries = Object.entries(raw);
  } else {
    errors.push('commands: ожидается список имён или объект имя -> { args, rest }');
    return out;
  }
  for (const [name, spec] of entries) {
    if (!isValidId(name) || (id !== undefined && !name.startsWith(`${id}.`))) {
      errors.push(`commands: "${name}" должна лежать в пространстве имён "${id}."`);
    }
    const parsed = readCommandSpec(name, spec, errors);
    if (parsed) out[name] = parsed;
  }
  return out;
}

function readCommandSpec(name: string, raw: unknown, errors: string[]): CommandSpec | undefined {
  const where = `commands.${name}`;
  if (!isRecord(raw)) {
    errors.push(`${where}: ожидается объект { args, rest }`);
    return undefined;
  }
  const list = raw.args ?? [];
  if (!Array.isArray(list) || !list.every((a) => typeof a === 'string')) {
    errors.push(`${where}.args: ожидается список видов, например ["string", "number?"]`);
    return undefined;
  }
  const args: ArgSpec[] = [];
  for (const text of list) {
    const optional = text.endsWith('?');
    const kind = optional ? text.slice(0, -1) : text;
    if (!isWireKind(kind)) {
      errors.push(`${where}.args: неизвестный вид ${show(text)}`);
      return undefined;
    }
    if (!optional && args.some((a) => a.optional)) {
      errors.push(`${where}.args: обязательный аргумент после необязательного`);
      return undefined;
    }
    args.push({ kind, optional });
  }
  const rest = raw.rest;
  if (rest === undefined) return { args };
  if (typeof rest !== 'string' || !isWireKind(rest)) {
    errors.push(`${where}.rest: неизвестный вид ${show(rest)}`);
    return undefined;
  }
  if (args.some((a) => a.optional)) {
    errors.push(`${where}: rest вместе с необязательными аргументами неоднозначен`);
    return undefined;
  }
  return { args, rest };
}

/** Ядро зовёт до обработчика: команду вызывает кто угодно по имени, аргументы - недоверенный вход. */
export function checkArgs(name: string, spec: CommandSpec, args: readonly unknown[]): void {
  const required = spec.args.filter((a) => !a.optional).length;
  const max = spec.rest ? Infinity : spec.args.length;
  if (args.length < required || args.length > max) {
    const expected = spec.rest ? `не меньше ${required}` : required === spec.args.length ? `${required}` : `${required}-${spec.args.length}`;
    throw new CoreError('Invalid', `${name}: аргументов ${args.length}, ожидается ${expected}`);
  }
  args.forEach((value, i) => {
    const kind = spec.args[i]?.kind ?? spec.rest;
    if (kind && !matchesKind(kind, value)) throw new CoreError('Invalid', `${name}: аргумент ${i + 1} не ${kind}`);
  });
}

function readSchemaVersion(field: string, raw: unknown, errors: string[]): { version: number } | undefined {
  if (raw === undefined) return undefined;
  const version = isRecord(raw) ? raw.version : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push(`${field}.version: ожидается целое >= 1, получено ${show(version)}`);
    return undefined;
  }
  return { version };
}

function show(value: unknown): string {
  return value === undefined ? 'ничего' : JSON.stringify(value);
}
