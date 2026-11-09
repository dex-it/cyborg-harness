import { show, VIEW_NAME } from './manifest-fields.ts';
import { isRecord } from './wire.ts';

/*
 * Размещение вида и типа документа в манифесте: род области и порядок (SAD 3.8, ADR-CH-0007 п. 1).
 * Тут только разбор; упорядоченный снимок для приложения собирает `layout.ts`. Слой замка (`overlay`) родом области не задаётся:
 * его объявляют как `ui.overlay`, и он есть только у плагина с правом `ui.lock`.
 */

/** Род области окна: боковая колонка, основная область с группой документов, панель инструментов основной области, всплывающий слой. */
export const AREAS = ['sidebar', 'main', 'toolbar', 'popup'] as const;
export type Area = (typeof AREAS)[number];

/** Что вид объявил о своём месте; чего нет, то подставляет снимок раскладки (`layout.ts`). */
export interface Placement {
  readonly area?: Area;
  readonly order?: number;
  /** Заголовок вида: у боковой колонки он над видом. */
  readonly title?: string;
}

export interface DocumentDecl {
  readonly restorable: boolean;
  readonly area?: Area;
  readonly order?: number;
}

const MAX_TITLE = 80;
const MAX_DOCUMENT_TYPES = 16;

const isArea = (value: unknown): value is Area => AREAS.some((a) => a === value);

/** `area` и `order` из объекта вида или типа документа; ошибка называет поле целиком (`ui.views.<имя>.area`). */
export function readPlace(raw: Record<string, unknown>, where: string, errors: string[]): { area?: Area; order?: number } {
  const out: { area?: Area; order?: number } = {};
  if (raw.area !== undefined) {
    if (isArea(raw.area)) out.area = raw.area;
    else {
      const hint = raw.area === 'overlay' ? '; слой замка объявляют как ui.overlay' : '';
      errors.push(`${where}.area: ожидается ${AREAS.slice(0, -1).join(', ')} или ${AREAS[AREAS.length - 1] ?? ''}, получено ${show(raw.area)}${hint}`);
    }
  }
  if (raw.order !== undefined) {
    if (typeof raw.order === 'number' && Number.isFinite(raw.order)) out.order = raw.order;
    else errors.push(`${where}.order: ожидается число, получено ${show(raw.order)}`);
  }
  return out;
}

export function readTitle(raw: Record<string, unknown>, where: string, errors: string[]): string | undefined {
  if (raw.title === undefined) return undefined;
  if (typeof raw.title === 'string' && raw.title.length > 0 && raw.title.length <= MAX_TITLE) return raw.title;
  errors.push(`${where}.title: ожидается непустая строка до ${String(MAX_TITLE)} символов, получено ${show(raw.title)}`);
  return undefined;
}

export function readDocuments(raw: unknown, errors: string[]): Record<string, DocumentDecl> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    errors.push('documents: ожидается { "<тип>": { "restorable": true } }');
    return undefined;
  }
  if (Object.keys(raw).length > MAX_DOCUMENT_TYPES) errors.push(`documents: не больше ${String(MAX_DOCUMENT_TYPES)} типов`);
  const out: Record<string, DocumentDecl> = {};
  for (const [type, spec] of Object.entries(raw)) {
    const where = `documents.${type}`;
    if (!VIEW_NAME.test(type)) errors.push(`${where}: имя типа - строчные латинские буквы, цифры и дефис`);
    else if (!isRecord(spec)) errors.push(`${where}: ожидается объект { "restorable": true, "area"?, "order"? }, получено ${show(spec)}`);
    else {
      const before = errors.length;
      for (const key of Object.keys(spec)) if (key !== 'restorable' && key !== 'area' && key !== 'order') errors.push(`${where}.${key}: незнакомое поле типа документа`);
      if (spec.restorable !== undefined && typeof spec.restorable !== 'boolean') errors.push(`${where}.restorable: ожидается true или false, получено ${show(spec.restorable)}`);
      const place = readPlace(spec, where, errors);
      if (errors.length === before) out[type] = { restorable: spec.restorable === true, ...place };
    }
  }
  return out;
}
