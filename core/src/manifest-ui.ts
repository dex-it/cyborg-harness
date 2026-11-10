import { isValidId, show, VIEW_NAME } from './manifest-fields.ts';
import { readPlace, readTitle, type Placement } from './manifest-layout.ts';
import { isRecord } from './wire.ts';

// Путь попадает в атрибут страницы-оболочки и в import(): только вниз от каталога плагина, без экранируемых символов.
const VIEW_ENTRY = /^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/;

const isEntry = (entry: unknown): entry is string => typeof entry === 'string' && VIEW_ENTRY.test(entry) && !entry.split('/').includes('..');

const ENTRY_HINT = 'ожидается путь "./<модуль>.js" внутри каталога плагина';
const VIEW_KEYS = new Set(['module', 'area', 'order', 'title']);

/** Вид-объект: `module` обязателен, остальное - размещение; в `placement` вид попадает, только если что-то объявил. */
function readViewObject(name: string, raw: Record<string, unknown>, views: Record<string, string>, placement: Record<string, Placement>, errors: string[]): void {
  const where = `ui.views.${name}`;
  for (const key of Object.keys(raw)) if (!VIEW_KEYS.has(key)) errors.push(`${where}.${key}: незнакомое поле вида`);
  if (isEntry(raw.module)) views[name] = raw.module;
  else errors.push(`${where}.module: ${ENTRY_HINT}, получено ${show(raw.module)}`);
  const title = readTitle(raw, where, errors);
  const place: Placement = { ...readPlace(raw, where, errors), ...(title !== undefined && { title }) };
  if (Object.keys(place).length > 0) placement[name] = place;
}

const GROUP_HINT = 'ожидается имя группы: строчные латинские буквы, цифры и дефис, части через точку';

/** Имя группы рендера становится хостом адреса вида (`cyborg-plugin://<группа>/`), поэтому грамматика та же, что у id плагина. */
export function readGroup(where: string, value: unknown, errors: string[]): string | undefined {
  if (typeof value === 'string' && isValidId(value)) return value;
  errors.push(`${where}: ${GROUP_HINT}, получено ${show(value)}`);
  return undefined;
}

export function readUi(raw: unknown, errors: string[]): { views: Record<string, string>; placement?: Record<string, Placement>; overlay?: string; group?: string } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || (raw.views !== undefined && !isRecord(raw.views)) || (raw.views === undefined && raw.overlay === undefined)) {
    errors.push('ui: ожидается { "views": { "<вид>": "./<модуль>.js" } } и/или { "overlay": "./<модуль>.js" }');
    return undefined;
  }
  for (const key of Object.keys(raw)) if (key !== 'views' && key !== 'overlay' && key !== 'group') errors.push(`ui.${key}: ядро знает только ui.views, ui.overlay и ui.group`);
  const views: Record<string, string> = {};
  const placement: Record<string, Placement> = {};
  const rawViews = isRecord(raw.views) ? raw.views : {};
  for (const [name, entry] of Object.entries(rawViews)) {
    if (!VIEW_NAME.test(name)) errors.push(`ui.views.${name}: имя вида - строчные латинские буквы, цифры и дефис`);
    else if (name === 'overlay') errors.push('ui.views.overlay: имя занято экраном замка, его объявляют как ui.overlay');
    else if (isRecord(entry)) readViewObject(name, entry, views, placement, errors);
    else if (typeof entry !== 'string') errors.push(`ui.views.${name}: ${ENTRY_HINT} или объект { module, area?, order?, title? }, получено ${show(entry)}`);
    else if (!isEntry(entry)) errors.push(`ui.views.${name}: ${ENTRY_HINT}, получено ${show(entry)}`);
    else views[name] = entry;
  }
  if (raw.views !== undefined && Object.keys(rawViews).length === 0) errors.push('ui.views: нет ни одного вида');
  const group = Object.hasOwn(raw, 'group') ? readGroup('ui.group', raw.group, errors) : undefined;
  const base = { views, ...(Object.keys(placement).length > 0 && { placement }), ...(group !== undefined && { group }) };
  if (raw.overlay === undefined) return base;
  if (!isEntry(raw.overlay)) {
    errors.push(`ui.overlay: ${ENTRY_HINT}, получено ${show(raw.overlay)}`);
    return base;
  }
  return { ...base, overlay: raw.overlay };
}
