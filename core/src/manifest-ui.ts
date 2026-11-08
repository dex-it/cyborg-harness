import { show, VIEW_NAME } from './manifest-fields.ts';
import { isRecord } from './wire.ts';

// Путь попадает в атрибут страницы-оболочки и в import(): только вниз от каталога плагина, без экранируемых символов.
const VIEW_ENTRY = /^\.\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/;

const isEntry = (entry: unknown): entry is string => typeof entry === 'string' && VIEW_ENTRY.test(entry) && !entry.split('/').includes('..');

export function readUi(raw: unknown, errors: string[]): { views: Record<string, string>; overlay?: string } | undefined {
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
