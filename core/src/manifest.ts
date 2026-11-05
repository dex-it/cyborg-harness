import { CoreError } from './errors.ts';
import { isValidRange, parseVersion, satisfies } from './semver.ts';
import { normalizeKey } from './keys.ts';
import { readPermissions, type PluginPermissions } from './permissions.ts';
import { readGuard, type MemberGuards } from './via-contract.ts';
import { isRecord, isWireKind, matchesKind, type WireKind } from './wire.ts';
import { reservedId, WINDOW_COMMANDS } from './window-layer.ts';

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

/** Сочетание клавиш -> своя команда без обязательных аргументов; `key` уже в записи `normalizeKey`. */
export interface KeybindingSpec {
  readonly key: string;
  readonly command: string;
}

/** Манифест плагина; читается ядром до запуска кода плагина. */
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly engines: { readonly cyborg: string };
  /** Контракт -> версия или несколько мажорных версий одновременно. */
  readonly provides: Readonly<Record<string, readonly string[]>>;
  /** Контракт -> член -> право вызывающего на аргумент: ядро проверит его до передачи вызова (`via-contract`). */
  readonly guards?: Readonly<Record<string, MemberGuards>>;
  /** Кратность one, без поставщика плагин не активируется. */
  readonly requires: Readonly<Record<string, string>>;
  /** Кратность one, без поставщика плагин работает. */
  readonly optional: Readonly<Record<string, string>>;
  /** Кратность many, поставщики приходят и уходят во время работы. */
  readonly consumes: Readonly<Record<string, string>>;
  /** Имя -> аргументы; ядро сверяет их до вызова обработчика. */
  readonly commands: Readonly<Record<string, CommandSpec>>;
  /** Читаются до запуска кода: конфликт сочетаний виден при загрузке, а не при нажатии. */
  readonly keybindings: readonly KeybindingSpec[];
  /** `schema` - путь `./<файл>.json` внутри каталога плагина; раздел проверяется по нему до активации и после правки извне. */
  readonly config?: SectionDecl;
  readonly state?: SectionDecl;
  /** `own` - просьба о своём хосте; пользователь вправе переопределить группой в `plugins.hosts`. */
  readonly host?: 'own';
  /** `lazy` - не при старте, а по первой команде, сочетанию, показу вида или потребителю своего контракта. */
  readonly activation?: 'lazy';
  /** Вид -> модуль с `mount` относительно каталога плагина; каждый вид живёт в своём `<iframe>`. */
  readonly ui?: {
    readonly views: Readonly<Record<string, string>>;
    /** Модуль замка окна, вид с именем `overlay`: только при праве `ui.lock`. */
    readonly overlay?: string;
  };
  /** `onStart` - окно закрыто с первого кадра, плагин активируется сразу, даже `lazy`. */
  readonly lock?: { readonly onStart: true };
  /** Типы документов плагина; `restorable` - документ переживает перезапуск окна. */
  readonly documents?: Readonly<Record<string, { readonly restorable: boolean }>>;
  readonly permissions: PluginPermissions;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly id?: string | undefined; readonly errors: readonly string[] };

const ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

const TOP_LEVEL = new Set([
  '$schema', 'id', 'version', 'engines', 'provides', 'requires', 'optional', 'consumes', 'commands', 'keybindings',
  'config', 'state', 'permissions', 'ui', 'documents', 'host', 'activation', 'lock',
]);

export function isValidId(value: string): boolean {
  return ID.test(value);
}

/** С `apiVersion` манифест под другой API при ошибках разбора отклоняется одной причиной - версией API. */
export function parseManifest(raw: unknown, apiVersion?: string): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['манифест не объект'] };

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) errors.push(`${key}: незнакомое поле манифеста`);
  }

  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (id === undefined || !isValidId(id)) errors.push(`id: ожидается имя вида "pin-lock" или "cyborg.files", получено ${show(raw.id)}`);
  else if (reservedId(id)) errors.push(`id: "${id}" занято командами окна ядра (${Object.keys(WINDOW_COMMANDS).join(', ')})`);

  const version = raw.version;
  if (typeof version !== 'string' || !parseVersion(version)) errors.push(`version: ожидается версия x.y.z, получено ${show(version)}`);

  const engines = isRecord(raw.engines) ? raw.engines.cyborg : undefined;
  if (typeof engines !== 'string' || !isValidRange(engines)) errors.push(`engines.cyborg: ожидается диапазон, получено ${show(engines)}`);

  const { provides, guards } = readProvides(raw.provides, errors);
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
  const keybindings = readKeybindings(raw.keybindings, commands, errors);
  const config = readSchemaVersion('config', raw.config, errors);
  const state = readSchemaVersion('state', raw.state, errors);
  const permissions = readPermissions(raw.permissions, errors);
  const ui = readUi(raw.ui, errors);
  const documents = readDocuments(raw.documents, errors);
  if (raw.host !== undefined && raw.host !== 'own') errors.push(`host: допустимо только "own", получено ${show(raw.host)}`);
  if (raw.activation !== undefined && raw.activation !== 'lazy') errors.push(`activation: допустимо только "lazy", получено ${show(raw.activation)}`);
  const lock = isRecord(raw.lock) && raw.lock.onStart === true && Object.keys(raw.lock).length === 1;
  if (raw.lock !== undefined && !lock) errors.push(`lock: допустимо только { "onStart": true }, получено ${show(raw.lock)}`);
  // Замок без своего экрана запер бы человека без способа открыть окно, экран без права замка не нужен.
  if (permissions['ui.lock'] === true && ui?.overlay === undefined) errors.push('permissions.ui.lock: нужен ui.overlay - экран, которым человек откроет окно');
  if (ui?.overlay !== undefined && permissions['ui.lock'] !== true) errors.push('ui.overlay: только с правом permissions.ui.lock');
  if (lock && permissions['ui.lock'] !== true) errors.push('lock.onStart: только с правом permissions.ui.lock');

  // Поле или значение новой версии API старое ядро не знает: причина отказа - версия, а не поле.
  if (errors.length > 0 && apiVersion !== undefined && typeof engines === 'string' && isValidRange(engines) && !satisfies(apiVersion, engines)) {
    return { ok: false, id, errors: [`engines.cyborg: нужен API Cyborg ${engines}, есть ${apiVersion}`] };
  }
  if (errors.length > 0 || id === undefined || typeof version !== 'string' || typeof engines !== 'string') return { ok: false, id, errors };
  return {
    ok: true,
    manifest: {
      id,
      version,
      engines: { cyborg: engines },
      provides,
      ...(guards && { guards }),
      requires,
      optional,
      consumes,
      commands,
      keybindings,
      permissions,
      ...(config && { config }),
      ...(state && { state }),
      ...(raw.host === 'own' && { host: 'own' as const }),
      ...(raw.activation === 'lazy' && { activation: 'lazy' as const }),
      ...(ui && { ui }),
      ...(lock && { lock: { onStart: true as const } }),
      ...(documents && { documents }),
    },
  };
}

interface Provides {
  readonly provides: Record<string, string[]>;
  readonly guards?: Record<string, MemberGuards>;
}

/** Значение - версия, список версий или `{ version, guard? }`. */
function readProvides(raw: unknown, errors: string[]): Provides {
  const out: Record<string, string[]> = {};
  const guards: Record<string, MemberGuards> = {};
  if (raw === undefined) return { provides: out };
  if (!isRecord(raw)) {
    errors.push('provides: ожидается объект');
    return { provides: out };
  }
  for (const [name, entry] of Object.entries(raw)) {
    if (!isValidId(name)) errors.push(`provides.${name}: недопустимое имя контракта`);
    const full = isRecord(entry) ? entry : undefined;
    for (const key of Object.keys(full ?? {})) if (!['version', 'guard'].includes(key)) errors.push(`provides.${name}.${key}: неизвестное поле`);
    const guard = readGuard(`provides.${name}.guard`, full?.guard, errors);
    if (guard) guards[name] = guard;
    const value = full ? full.version : entry;
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
  return { provides: out, ...(Object.keys(guards).length > 0 && { guards }) };
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

function readKeybindings(raw: unknown, commands: Readonly<Record<string, CommandSpec>>, errors: string[]): KeybindingSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push('keybindings: ожидается список { key, command }');
    return [];
  }
  const out: KeybindingSpec[] = [];
  for (const item of raw) {
    const key = isRecord(item) && typeof item.key === 'string' ? normalizeKey(item.key) : undefined;
    const command = isRecord(item) ? item.command : undefined;
    if (key === undefined) {
      errors.push(`keybindings: сочетание ${show(isRecord(item) ? item.key : item)} не разобрано, ожидается вида "CmdOrCtrl+Shift+K" или "F5"`);
      continue;
    }
    const spec = typeof command === 'string' ? commands[command] : undefined;
    if (typeof command !== 'string' || !spec) {
      errors.push(`keybindings.${key}: команда ${show(command)} не объявлена в commands этого плагина`);
      continue;
    }
    if (spec.args.some((a) => !a.optional)) errors.push(`keybindings.${key}: у ${command} обязательные аргументы, нажатие их не даст`);
    else if (out.some((k) => k.key === key)) errors.push(`keybindings.${key}: сочетание повторяется`);
    else out.push({ key, command });
  }
  return out;
}

const VIEW_NAME = /^[a-z][a-z0-9-]*$/;
// Путь попадает в атрибут страницы-оболочки и в import(): только вниз от каталога плагина, без экранируемых символов.
const VIEW_ENTRY = /^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/;

const isEntry = (entry: unknown): entry is string => typeof entry === 'string' && VIEW_ENTRY.test(entry) && !entry.split('/').includes('..');

function readUi(raw: unknown, errors: string[]): { views: Record<string, string>; overlay?: string } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || (raw.views !== undefined && !isRecord(raw.views)) || (raw.views === undefined && raw.overlay === undefined)) {
    errors.push('ui: ожидается { "views": { "<вид>": "./<модуль>.js" } } и/или { "overlay": "./<модуль>.js" }');
    return undefined;
  }
  for (const key of Object.keys(raw)) if (key !== 'views' && key !== 'overlay') errors.push(`ui.${key}: ядро знает только ui.views и ui.overlay`);
  const views: Record<string, string> = {};
  const rawViews = isRecord(raw.views) ? raw.views : {};
  for (const [name, entry] of Object.entries(rawViews)) {
    if (!VIEW_NAME.test(name)) errors.push(`ui.views.${name}: имя вида - строчные латинские буквы, цифры и дефис`);
    else if (name === 'overlay') errors.push('ui.views.overlay: имя занято экраном замка, его объявляют как ui.overlay');
    else if (!isEntry(entry)) errors.push(`ui.views.${name}: ожидается путь "./<модуль>.js" внутри каталога плагина, получено ${show(entry)}`);
    else views[name] = entry;
  }
  if (raw.views !== undefined && Object.keys(rawViews).length === 0) errors.push('ui.views: нет ни одного вида');
  if (raw.overlay === undefined) return { views };
  if (!isEntry(raw.overlay)) {
    errors.push(`ui.overlay: ожидается путь "./<модуль>.js" внутри каталога плагина, получено ${show(raw.overlay)}`);
    return { views };
  }
  return { views, overlay: raw.overlay };
}

const MAX_DOCUMENT_TYPES = 16;

function readDocuments(raw: unknown, errors: string[]): Record<string, { restorable: boolean }> | undefined {
  if (raw === undefined) return undefined;
  const form = 'documents: ожидается { "<тип>": { "restorable": true } }';
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    errors.push(form);
    return undefined;
  }
  if (Object.keys(raw).length > MAX_DOCUMENT_TYPES) errors.push(`documents: не больше ${String(MAX_DOCUMENT_TYPES)} типов`);
  const out: Record<string, { restorable: boolean }> = {};
  for (const [type, spec] of Object.entries(raw)) {
    if (!VIEW_NAME.test(type)) errors.push(`documents.${type}: имя типа - строчные латинские буквы, цифры и дефис`);
    else if (!isRecord(spec) || Object.keys(spec).some((k) => k !== 'restorable') || (spec.restorable !== undefined && typeof spec.restorable !== 'boolean')) errors.push(`documents.${type}: ${form.slice('documents: '.length)}`);
    else out[type] = { restorable: spec.restorable === true };
  }
  return out;
}

/** Модуль вида по имени: `overlay` - экран замка из `ui.overlay`. */
export function viewEntry(m: PluginManifest, view: string): string | undefined {
  if (typeof view !== 'string') return undefined;
  if (view === 'overlay') return m.ui?.overlay;
  const views = m.ui?.views;
  return views && Object.hasOwn(views, view) ? views[view] : undefined;
}

export interface SectionDecl {
  readonly version: number;
  readonly schema?: string;
}

const SCHEMA_FILE = /^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;

function readSchemaVersion(field: string, raw: unknown, errors: string[]): SectionDecl | undefined {
  if (raw === undefined) return undefined;
  const version = isRecord(raw) ? raw.version : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push(`${field}.version: ожидается целое >= 1, получено ${show(version)}`);
    return undefined;
  }
  const schema = isRecord(raw) ? raw.schema : undefined;
  if (schema === undefined) return { version };
  if (typeof schema !== 'string' || !SCHEMA_FILE.test(schema) || schema.split('/').includes('..')) {
    errors.push(`${field}.schema: ожидается путь "./<файл>.json" внутри каталога плагина, получено ${show(schema)}`);
    return undefined;
  }
  return { version, schema };
}

function show(value: unknown): string {
  return value === undefined ? 'ничего' : JSON.stringify(value);
}
