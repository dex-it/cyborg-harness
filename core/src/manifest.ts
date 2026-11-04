import { isValidRange, parseVersion } from './semver.ts';

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
  readonly commands: readonly string[];
  readonly config?: { readonly version: number };
  readonly state?: { readonly version: number };
  /** `own` - просьба о своём хосте; пользователь вправе переопределить группой в `plugins.hosts`. */
  readonly host?: 'own';
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly id?: string; readonly errors: readonly string[] };

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

  if (errors.length > 0) return { ok: false, id, errors };
  return {
    ok: true,
    manifest: {
      id: id!,
      version: version as string,
      engines: { cyborg: engines as string },
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
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === 'string' && parseVersion(v))) {
      errors.push(`provides.${name}: ожидается версия или список версий, получено ${show(value)}`);
      continue;
    }
    const majors = list.map((v) => parseVersion(v as string)![0]);
    if (new Set(majors).size !== majors.length) errors.push(`provides.${name}: две версии одной мажорной`);
    out[name] = list as string[];
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

function readCommands(raw: unknown, id: string | undefined, errors: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((c) => typeof c === 'string')) {
    errors.push('commands: ожидается список имён');
    return [];
  }
  for (const name of raw as string[]) {
    if (!isValidId(name) || (id !== undefined && !name.startsWith(`${id}.`))) {
      errors.push(`commands: "${name}" должна лежать в пространстве имён "${id}."`);
    }
  }
  if (new Set(raw).size !== raw.length) errors.push('commands: имя повторяется');
  return raw as string[];
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return value === undefined ? 'ничего' : JSON.stringify(value);
}
