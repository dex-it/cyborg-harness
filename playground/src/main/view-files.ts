import path from 'node:path';
import { pluginOfOrigin } from '../shared/views.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Вид видит только свой origin: ни сети, ни чужих видов, ни inline-скриптов. */
export const VIEW_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";

/** Файлы оболочки вида: их отдаёт приложение под origin плагина, чтобы CSP `'self'` их пропустил. */
export const SHELL_PATH = '/.cyborg/';
export const SHELL_FILES = { 'shell.js': 'text/javascript; charset=utf-8', 'shell.css': 'text/css; charset=utf-8' } as const;

export interface PluginUi {
  /** Каталог плагина: модули видов и их файлы лежат в нём. */
  readonly dir: string;
  /** Вид -> модуль с `mount`, уже проверенный разбором манифеста. */
  readonly views: Readonly<Record<string, string>>;
  /** Экран замка `ui.overlay`: отдаётся как вид `overlay`. */
  readonly overlay?: string;
}

export type ViewRequest =
  | { readonly kind: 'shell'; readonly html: string }
  | { readonly kind: 'core'; readonly name: keyof typeof SHELL_FILES; readonly type: string }
  | { readonly kind: 'file'; readonly file: string; readonly type: string };

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Страница-оболочка: модуль плагина подключает скрипт ядра, а не своя разметка - так `mount` получает готовый `UiContext`. */
export function shellHtml(pluginId: string, view: string, entry: string): string {
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>${attr(pluginId)}: ${attr(view)}</title>
    <link rel="stylesheet" href="${SHELL_PATH}shell.css" />
  </head>
  <body>
    <div id="cyborg-view"></div>
    <script src="${SHELL_PATH}shell.js" data-plugin="${attr(pluginId)}" data-view="${attr(view)}" data-entry="${attr(entry)}"></script>
  </body>
</html>
`;
}

function parse(url: string): { url: URL; id: string } | undefined {
  try {
    const parsed = new URL(url);
    const id = pluginOfOrigin(`${parsed.protocol}//${parsed.host}`);
    return id === undefined ? undefined : { url: parsed, id };
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
  return type === undefined ? undefined : { kind: 'file', file, type };
}

/** Статика без оболочки: `/` - index.html каталога; так спайк отдаёт пробные страницы. */
export function resolveStaticFile(url: string, dirOf: (id: string) => string | undefined): ViewRequest | undefined {
  const found = parse(url);
  const dir = found && dirOf(found.id);
  if (!found || dir === undefined) return undefined;
  return fileIn(dir, found.url.pathname === '/' ? '/index.html' : found.url.pathname);
}

/** Запрос `cyborg-plugin://<id>/<путь>`: `/` и `/?view=<вид>` - оболочка, `/.cyborg/*` - файлы ядра, прочее - файл из каталога плагина. */
export function resolveViewRequest(url: string, uiOf: (pluginId: string) => PluginUi | undefined): ViewRequest | undefined {
  const found = parse(url);
  const ui = found && uiOf(found.id);
  if (!found || ui === undefined) return undefined;
  const { url: parsed, id } = found;
  if (parsed.pathname === '/' || parsed.pathname === '') {
    const view = parsed.searchParams.get('view') ?? Object.keys(ui.views)[0];
    const entry = view === 'overlay' ? ui.overlay : view !== undefined && Object.hasOwn(ui.views, view) ? ui.views[view] : undefined;
    return view === undefined || entry === undefined ? undefined : { kind: 'shell', html: shellHtml(id, view, entry) };
  }
  if (parsed.pathname.startsWith(SHELL_PATH)) {
    const name = parsed.pathname.slice(SHELL_PATH.length);
    if (!Object.hasOwn(SHELL_FILES, name)) return undefined;
    const known = name as keyof typeof SHELL_FILES;
    return { kind: 'core', name: known, type: SHELL_FILES[known] };
  }
  return fileIn(ui.dir, parsed.pathname);
}
