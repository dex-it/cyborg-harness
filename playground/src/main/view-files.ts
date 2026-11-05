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

export interface ViewFile {
  readonly file: string;
  readonly type: string;
}

/** Файл вида по адресу `cyborg-plugin://<id>/<путь>`; выход за каталог вида плагина - undefined. */
export function resolveViewFile(url: string, dirOf: (pluginId: string) => string | undefined): ViewFile | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const id = pluginOfOrigin(`${parsed.protocol}//${parsed.host}`);
  const dir = id === undefined ? undefined : dirOf(id);
  if (dir === undefined) return undefined;
  let relative: string;
  try {
    relative = decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
  if (relative === '/' || relative === '') relative = '/index.html';
  const root = path.resolve(dir);
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(root + path.sep)) return undefined;
  const type = TYPES[path.extname(file)];
  return type === undefined ? undefined : { file, type };
}
