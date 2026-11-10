import { normalizeKey } from './keys.ts';
import { isValidId, show, VIEW_NAME } from './manifest-fields.ts';
import { readTitle } from './manifest-layout.ts';
import { allowsMajor, parseVersion } from './semver.ts';
import { isRecord, own } from './wire.ts';

/*
 * Вклады плагина в меню окна (`contributes.menus`, SAD 3.9, FR-CH-2025). Тут только разбор; упорядоченный снимок для приложения собирает `menus.ts`.
 * Меню - вид ядра: плагин вкладывает пункты в меню из закрытого списка, а подпись, порядок и состояние пункта задаёт его манифест.
 */

/** Меню, которые держит ядро; приложение рисует их подписи и решает, где они стоят. Список расширяют без поломки: новое имя старые манифесты не затрагивает. */
export const MENU_NAMES = ['workspace', 'view', 'tools', 'window'] as const;
export type MenuName = (typeof MENU_NAMES)[number];

/** Откуда пункт берёт `enabled` или `checked`: булев член контракта, который этот плагин получает (requires, optional) или сам отдаёт (provides). */
export interface StateSource {
  readonly contract: string;
  readonly major: number;
  readonly member: string;
}

export interface MenuItemDecl {
  /** Имя пункта внутри плагина; в таблице сочетаний пункт называется `<плагин>/<id>`. */
  readonly id: string;
  readonly menu: MenuName;
  readonly title: string;
  /** Своя команда плагина без обязательных аргументов. */
  readonly command: string;
  readonly order?: number;
  /** Сочетание в записи `normalizeKey`; занято в едином реестре клавиш (K-07) наравне с акселераторами меню приложения. */
  readonly accelerator?: string;
  /** Нет источника - пункт доступен, пока работает плагин. */
  readonly enabled?: StateSource;
  /** Есть источник - пункт с галочкой; нет - обычный. */
  readonly checked?: StateSource;
}

export interface Contributes {
  readonly menus: readonly MenuItemDecl[];
}

/** Что пункту нужно знать о команде плагина: структурный тип вместо `CommandSpec`, чтобы манифест и разбор меню не зависели друг от друга по кругу. */
export interface MenuCommand {
  readonly args: readonly { readonly optional?: boolean }[];
}

const MAX_ITEMS = 32;
const ITEM_KEYS = new Set(['id', 'menu', 'title', 'command', 'order', 'accelerator', 'enabled', 'checked']);
const SOURCE_KEYS = new Set(['contract', 'major', 'member']);
const MEMBER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const isMenuName = (value: unknown): value is MenuName => MENU_NAMES.some((m) => m === value);

/** Что плагин объявил о контрактах: по этому источник и проверяется. */
export interface ContractDecls {
  readonly provides: Readonly<Record<string, readonly string[]>>;
  readonly requires: Readonly<Record<string, string>>;
  readonly optional: Readonly<Record<string, string>>;
}

/** Уже занятое в манифесте: id пунктов и сочетания (сочетание -> пункт). */
interface Taken {
  readonly ids: Set<string>;
  readonly keys: Map<string, string>;
}

function readSource(where: string, raw: unknown, decls: ContractDecls, errors: string[]): StateSource | undefined {
  if (!isRecord(raw)) {
    errors.push(`${where}: ожидается { contract, major, member }, получено ${show(raw)}`);
    return undefined;
  }
  const before = errors.length;
  for (const key of Object.keys(raw)) if (!SOURCE_KEYS.has(key)) errors.push(`${where}.${key}: незнакомое поле источника`);
  const { contract, major, member } = raw;
  if (typeof contract !== 'string' || !isValidId(contract)) errors.push(`${where}.contract: ожидается имя контракта, получено ${show(contract)}`);
  if (typeof major !== 'number' || !Number.isInteger(major) || major < 0) errors.push(`${where}.major: ожидается целое >= 0, получено ${show(major)}`);
  if (typeof member !== 'string' || !MEMBER.test(member)) errors.push(`${where}.member: ожидается имя члена контракта строкой, получено ${show(member)}`);
  if (errors.length > before || typeof contract !== 'string' || typeof major !== 'number' || typeof member !== 'string') return undefined;

  const given = own(decls.provides, contract);
  const required = own(decls.requires, contract);
  const range = required ?? own(decls.optional, contract);
  if (given === undefined && range === undefined) {
    errors.push(`${where}.contract: ${contract} нет в requires, optional и provides этого плагина (consumes не годится: поставщиков несколько)`);
    return undefined;
  }
  if (given !== undefined) {
    const majors = [...new Set(given.map((v) => parseVersion(v)?.[0] ?? -1))];
    if (!majors.includes(major)) {
      errors.push(`${where}.major: плагин отдаёт ${contract} только мажорных версий ${majors.join(', ')}`);
      return undefined;
    }
  } else if (range !== undefined && !allowsMajor(range, major)) {
    errors.push(`${where}.major: у ${contract} в ${required === undefined ? 'optional' : 'requires'} "${range}" нет мажорной версии ${String(major)}`);
    return undefined;
  }
  return { contract, major, member };
}

function readItem(index: number, raw: unknown, commands: Readonly<Record<string, MenuCommand>>, decls: ContractDecls, taken: Taken, errors: string[]): MenuItemDecl | undefined {
  if (!isRecord(raw)) {
    errors.push(`contributes.menus[${String(index)}]: ожидается объект { id, menu, title, command, ... }, получено ${show(raw)}`);
    return undefined;
  }
  const before = errors.length;
  const id = raw.id;
  if (typeof id !== 'string' || !VIEW_NAME.test(id)) {
    errors.push(`contributes.menus[${String(index)}].id: ожидается имя вида "open" (строчные латинские буквы, цифры и дефис), получено ${show(id)}`);
    return undefined;
  }
  const where = `contributes.menus.${id}`;
  if (taken.ids.has(id)) errors.push(`${where}: id повторяется`);
  for (const key of Object.keys(raw)) if (!ITEM_KEYS.has(key)) errors.push(`${where}.${key}: незнакомое поле пункта меню`);
  if (!isMenuName(raw.menu)) errors.push(`${where}.menu: ожидается ${MENU_NAMES.slice(0, -1).join(', ')} или ${MENU_NAMES[MENU_NAMES.length - 1] ?? ''}, получено ${show(raw.menu)}`);
  const title = readTitle(raw, where, errors);
  if (raw.title === undefined) errors.push(`${where}.title: ожидается непустая строка до 80 символов, получено ничего`);

  const command = raw.command;
  const spec = typeof command === 'string' ? own(commands, command) : undefined;
  if (typeof command !== 'string' || !spec) errors.push(`${where}.command: команда ${show(command)} не объявлена в commands этого плагина`);
  else if (spec.args.some((a) => !a.optional)) errors.push(`${where}.command: у ${command} обязательные аргументы, пункт меню их не даст`);

  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) errors.push(`${where}.order: ожидается число, получено ${show(raw.order)}`);
  let accelerator: string | undefined;
  if (raw.accelerator !== undefined) {
    accelerator = typeof raw.accelerator === 'string' ? normalizeKey(raw.accelerator) : undefined;
    if (accelerator === undefined) errors.push(`${where}.accelerator: сочетание ${show(raw.accelerator)} не разобрано, ожидается вида "CmdOrCtrl+Shift+K" или "F5"`);
    else if (taken.keys.has(accelerator)) errors.push(`${where}.accelerator: сочетание ${accelerator} уже у пункта ${taken.keys.get(accelerator) ?? ''}`);
  }
  const enabled = raw.enabled === undefined ? undefined : readSource(`${where}.enabled`, raw.enabled, decls, errors);
  const checked = raw.checked === undefined ? undefined : readSource(`${where}.checked`, raw.checked, decls, errors);

  if (errors.length > before || !isMenuName(raw.menu) || title === undefined || typeof command !== 'string') return undefined;
  taken.ids.add(id);
  if (accelerator !== undefined) taken.keys.set(accelerator, id);
  return {
    id,
    menu: raw.menu,
    title,
    command,
    ...(typeof raw.order === 'number' && { order: raw.order }),
    ...(accelerator !== undefined && { accelerator }),
    ...(enabled && { enabled }),
    ...(checked && { checked }),
  };
}

export function readContributes(raw: unknown, commands: Readonly<Record<string, MenuCommand>>, decls: ContractDecls, errors: string[]): Contributes | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`contributes: ожидается { "menus": [...] }, получено ${show(raw)}`);
    return undefined;
  }
  for (const key of Object.keys(raw)) if (key !== 'menus') errors.push(`contributes.${key}: ядро знает только contributes.menus`);
  if (raw.menus === undefined) return undefined;
  if (!Array.isArray(raw.menus)) {
    errors.push(`contributes.menus: ожидается список пунктов { id, menu, title, command, ... }, получено ${show(raw.menus)}`);
    return undefined;
  }
  if (raw.menus.length === 0) {
    errors.push('contributes.menus: нет ни одного пункта');
    return undefined;
  }
  if (raw.menus.length > MAX_ITEMS) {
    errors.push(`contributes.menus: не больше ${String(MAX_ITEMS)} пунктов`);
    return undefined;
  }
  const taken: Taken = { ids: new Set(), keys: new Map() };
  const menus: MenuItemDecl[] = [];
  raw.menus.forEach((item: unknown, i) => {
    const parsed = readItem(i, item, commands, decls, taken, errors);
    if (parsed) menus.push(parsed);
  });
  return menus.length === 0 ? undefined : { menus };
}
