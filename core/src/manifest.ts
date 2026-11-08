import { CoreError } from './errors.ts';
import { isValidRange, parseVersion, satisfies } from './semver.ts';
import { normalizeKey } from './keys.ts';
import { isValidId, show, VIEW_NAME } from './manifest-fields.ts';
import { readProvides } from './manifest-provides.ts';
import { readUi } from './manifest-ui.ts';
import { readPermissions, type PluginPermissions } from './permissions.ts';
import { readRights, type Guard, type MemberGuards } from './via-contract.ts';
import { isRecord, isWireKind, matchesKind, own, type WireKind } from './wire.ts';
import { KERNEL_COMMANDS, reservedId, WINDOW_COMMANDS } from './window-layer.ts';

export { isRecord };
export { isValidId } from './manifest-fields.ts';

export interface ArgSpec {
  readonly kind: WireKind;
  readonly optional: boolean;
}

/** Кому открыта команда: `user` - палитре, клавишам, меню и виду своего плагина; `plugins` - ещё и главным частям других плагинов. */
export type CommandCallers = 'user' | 'plugins';

/** Аргументы команды: позиционные, необязательные только в хвосте; `rest` - вид всех остальных. */
export interface CommandSpec {
  readonly args: readonly ArgSpec[];
  readonly rest?: WireKind;
  /** Не объявлено - `user`. */
  readonly callers?: CommandCallers;
  /** Право чужого вызывающего на аргумент; только при `callers: "plugins"`. Ядро проверяет его до передачи вызова, как `guard` члена контракта. */
  readonly guard?: readonly Guard[];
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

const TOP_LEVEL = new Set([
  '$schema', 'id', 'version', 'engines', 'provides', 'requires', 'optional', 'consumes', 'commands', 'keybindings',
  'config', 'state', 'permissions', 'ui', 'documents', 'host', 'activation', 'lock',
]);

/** С `apiVersion` манифест под другой API при ошибках разбора отклоняется одной причиной - версией API. */
export function parseManifest(raw: unknown, apiVersion?: string): ManifestResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['манифест не объект'] };

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) errors.push(`${key}: незнакомое поле манифеста`);
  }

  const id = typeof raw.id === 'string' ? raw.id : undefined;
  if (id === undefined || !isValidId(id)) errors.push(`id: ожидается имя вида "pin-lock" или "cyborg.files", получено ${show(raw.id)}`);
  else if (reservedId(id)) errors.push(`id: "${id}" занято командами окна ядра (${[...Object.keys(WINDOW_COMMANDS), ...Object.values(KERNEL_COMMANDS)].join(', ')})`);

  const version = raw.version;
  if (typeof version !== 'string' || !parseVersion(version)) errors.push(`version: ожидается версия x.y.z, получено ${show(version)}`);

  const engines = isRecord(raw.engines) ? raw.engines.cyborg : undefined;
  if (typeof engines !== 'string' || !isValidRange(engines)) errors.push(`engines.cyborg: ожидается диапазон, получено ${show(engines)}`);

  const { provides, guards } = readProvides(raw.provides, errors);
  const requires = readRanges('requires', raw.requires, errors);
  const optional = readRanges('optional', raw.optional, errors);
  const consumes = readRanges('consumes', raw.consumes, errors);

  for (const name of Object.keys(requires)) {
    if (Object.hasOwn(optional, name)) errors.push(`${name}: контракт одновременно в requires и optional`);
  }
  for (const name of Object.keys(consumes)) {
    if (Object.hasOwn(requires, name) || Object.hasOwn(optional, name)) errors.push(`${name}: контракт кратности many не может быть в requires или optional`);
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
    errors.push(`${where}: ожидается объект { args, rest, callers, guard }`);
    return undefined;
  }
  const callers = readCallers(where, raw.callers, errors);
  const guard = readCommandGuard(where, raw.guard, callers, errors);
  const shape = readCommandShape(where, raw, errors);
  return shape && { ...shape, ...(callers !== undefined && { callers }), ...(guard !== undefined && { guard }) };
}

function readCallers(where: string, raw: unknown, errors: string[]): CommandCallers | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'user' || raw === 'plugins') return raw;
  errors.push(`${where}.callers: ожидается "user" или "plugins", получено ${show(raw)}`);
  return undefined;
}

/** `guard` защищает исполнителя от чужого вызывающего; у команды только для своих он ничего бы не проверял, поэтому без `callers: "plugins"` это ошибка. */
function readCommandGuard(where: string, raw: unknown, callers: CommandCallers | undefined, errors: string[]): readonly Guard[] | undefined {
  if (raw === undefined) return undefined;
  if (callers !== 'plugins') {
    errors.push(`${where}.guard: проверяет аргумент для чужих главных частей - нужен callers: "plugins"`);
    return undefined;
  }
  return readRights(`${where}.guard`, raw, errors);
}

function readCommandShape(where: string, raw: Record<string, unknown>, errors: string[]): CommandSpec | undefined {
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
    const spec = typeof command === 'string' ? own(commands, command) : undefined;
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
