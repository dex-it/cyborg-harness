import fs from 'node:fs';
import path from 'node:path';
import { frameAddress, groupOfOrigin } from './view-protocol.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // Шрифт значков Monaco (codicon.ttf) - единственный шрифт, который нужен Monaco и xterm (PL-05).
  '.ttf': 'font/ttf',
};

/**
 * Закрытая CSP вида (SAD 3.8, ADR-CH-0007 п. 2): `default-src 'none'` и явные источники, то есть только файлы origin группы и `data:` для картинок.
 * Сети нет (`connect-src 'self'` - свой origin), фреймов нет (`frame-src` берётся из `default-src`: сосед по группе в `<iframe>` не встраивается), встроенный скрипт и `eval` не выполняются.
 * Воркеры - файлы того же origin, им хватает `script-src 'self'` (пилот PL-05); `font-src 'self'` нужен шрифту значков Monaco.
 * Инлайн-стили (`<style>`, атрибут `style`: xterm, Monaco) - только при `inlineStyles` из манифеста плагина (`ui.inlineStyles`); элементы ядра берут стили через `adoptedStyleSheets` и флага не требуют.
 */
export function viewCsp(inlineStyles: boolean): string {
  const style = inlineStyles ? "'self' 'unsafe-inline'" : "'self'";
  return `default-src 'none'; script-src 'self'; style-src ${style}; connect-src 'self'; img-src 'self' data:; font-src 'self'`;
}

/** CSP вида без флага: политика по умолчанию для видов, которые инлайн-стилей не объявили. */
export const VIEW_CSP = viewCsp(false);

/** Файлы оболочки вида: их отдаёт приложение под origin группы (путь `/<плагин>/.cyborg/`), чтобы CSP `'self'` их пропустил. */
export const SHELL_PATH = '/.cyborg/';
export const SHELL_FILES = { 'shell.js': 'text/javascript; charset=utf-8', 'shell.css': 'text/css; charset=utf-8' } as const;

export interface PluginUi {
  /** Группа рендера плагина (`Kernel.groupOf`): адрес вида обслуживается только под её origin. */
  readonly group: string;
  /** Каталог плагина: модули видов и их файлы лежат в нём. */
  readonly dir: string;
  /** Вид -> модуль с `mount`, уже проверенный разбором манифеста. */
  readonly views: Readonly<Record<string, string>>;
  /** Экран замка `ui.overlay`: отдаётся как вид `overlay`. */
  readonly overlay?: string;
  /** `ui.inlineStyles` манифеста: CSP его видов разрешает инлайн-стили; без флага - нет. */
  readonly inlineStyles?: true;
}

export type ViewRequest = (
  | { readonly kind: 'shell'; readonly html: string }
  | { readonly kind: 'core'; readonly name: keyof typeof SHELL_FILES; readonly type: string }
  | { readonly kind: 'file'; readonly file: string; readonly type: string }
) & {
  /** Флаг плагина из `PluginUi.inlineStyles`: по нему считается CSP ответа. Поля нет, когда флага нет (в том числе у статики спайка). */
  readonly inlineStyles?: true;
};

/** CSP ответов вида вместо `viewCsp`: строка на всех, функция по плагину и группе из адреса запроса и флагу плагина `inlineStyles` (пилот PL-05 задаёт наборы строкой). */
export type ViewCsp = string | ((pluginId: string | undefined, group: string | undefined, inlineStyles: boolean) => string);

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Страница-оболочка: модуль плагина подключает скрипт ядра, а не своя разметка - так `mount` получает готовый `UiContext`. */
export function shellHtml(pluginId: string, view: string, entry: string): string {
  const shell = `/${pluginId}${SHELL_PATH}`;
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>${attr(pluginId)}: ${attr(view)}</title>
    <link rel="stylesheet" href="${attr(shell)}shell.css" />
  </head>
  <body>
    <div id="cyborg-view"></div>
    <script src="${attr(shell)}shell.js" data-plugin="${attr(pluginId)}" data-view="${attr(view)}" data-entry="${attr(entry)}"></script>
  </body>
</html>
`;
}

/** Хост адреса как имя каталога спайка: страница без оболочки и без плагина в пути. */
function hostOf(url: string): { url: URL; host: string } | undefined {
  try {
    const parsed = new URL(url);
    const host = groupOfOrigin(`${parsed.protocol}//${parsed.host}`);
    return host === undefined ? undefined : { url: parsed, host };
  } catch {
    return undefined;
  }
}

/** Файл по пути адреса внутри каталога; выход за каталог и неизвестный тип - undefined. */
function fileIn(dir: string, pathname: string): ViewRequest | undefined {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const root = path.resolve(dir);
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(root + path.sep)) return undefined;
  const type = TYPES[path.extname(file)];
  if (type === undefined) return undefined;
  // Симлинк в каталоге плагина отдал бы виду любой файл пользователя: граница - по настоящим путям.
  let real: string;
  try {
    real = fs.realpathSync(file);
    if (!real.startsWith(fs.realpathSync(root) + path.sep)) return undefined;
  } catch {
    return undefined;
  }
  return { kind: 'file', file: real, type };
}

/** Статика без оболочки: хост адреса - каталог, `/` - его index.html; так спайк отдаёт пробные страницы. */
export function resolveStaticFile(url: string, dirOf: (id: string) => string | undefined): ViewRequest | undefined {
  const found = hostOf(url);
  const dir = found && dirOf(found.host);
  if (!found || dir === undefined) return undefined;
  return fileIn(dir, found.url.pathname === '/' ? '/index.html' : found.url.pathname);
}

/**
 * Запрос `cyborg-plugin://<группа>/<плагин>/<путь>`: `/<плагин>/` и `?view=<вид>` - оболочка, `/<плагин>/.cyborg/*` - файлы ядра, прочее - файл из каталога плагина.
 * Плагин берётся из пути, а группа из хоста обязана быть его группой: адрес плагина под чужим origin, как и адрес без плагина, не вид.
 * `wake` вызывается только после этой сверки: показ вида - вызов ленивого плагина, но вид чужой группы разбудить его не должен.
 */
export function resolveViewRequest(
  url: string,
  uiOf: (pluginId: string) => PluginUi | undefined,
  wake?: (pluginId: string) => void,
): ViewRequest | undefined {
  const address = frameAddress(url);
  if (!address) return undefined;
  const ui = uiOf(address.plugin);
  if (ui?.group !== address.group) return undefined;
  wake?.(address.plugin);
  const found = resolveInPlugin(url, address.plugin, ui);
  return found && ui.inlineStyles === true ? { ...found, inlineStyles: true } : found;
}

/** Оболочка, файл ядра или файл каталога плагина по пути после `/<плагин>`; флаг плагина добавляет вызывающий. */
function resolveInPlugin(url: string, plugin: string, ui: PluginUi): ViewRequest | undefined {
  const parsed = new URL(url);
  const rest = parsed.pathname.slice(plugin.length + 1);
  if (rest === '/' || rest === '') {
    const view = parsed.searchParams.get('view') ?? Object.keys(ui.views)[0];
    const entry = view === 'overlay' ? ui.overlay : view !== undefined && Object.hasOwn(ui.views, view) ? ui.views[view] : undefined;
    return view === undefined || entry === undefined ? undefined : { kind: 'shell', html: shellHtml(plugin, view, entry) };
  }
  if (rest.startsWith(SHELL_PATH)) {
    const name = rest.slice(SHELL_PATH.length);
    if (!Object.hasOwn(SHELL_FILES, name)) return undefined;
    const known = name as keyof typeof SHELL_FILES;
    return { kind: 'core', name: known, type: SHELL_FILES[known] };
  }
  return fileIn(ui.dir, rest);
}

/** CSP ответа на запрос: без настройки - `viewCsp(inlineStyles)`, настройка приложения старше флага плагина. */
export function cspOf(csp: ViewCsp | undefined, url: string, inlineStyles: boolean): string {
  if (typeof csp === 'string') return csp;
  const address = frameAddress(url);
  return csp ? csp(address?.plugin, address?.group, inlineStyles) : viewCsp(inlineStyles);
}

/** Заголовки ответа на запрос вида: тип файла и CSP, посчитанная на ответ по флагу плагина. */
export function viewHeaders(found: ViewRequest, url: string, csp?: ViewCsp): Record<string, string> {
  return {
    'content-type': found.kind === 'shell' ? 'text/html; charset=utf-8' : found.type,
    'content-security-policy': cspOf(csp, url, found.inlineStyles === true),
  };
}
