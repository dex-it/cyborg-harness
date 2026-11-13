import { gunzipSync, gzipSync } from 'node:zlib';

// Минимальный писатель tar (ustar) для pack: без зависимостей и воспроизводимый - одни и те же файлы дают один и тот же архив
// (время 0, владелец 0, права 0644, порядок задаёт вызывающий). Читает такой архив любой tar.

export interface TarEntry {
  /** Путь внутри архива, через `/`. */
  readonly name: string;
  readonly data: Uint8Array;
}

const BLOCK = 512;

function field(header: Buffer, offset: number, length: number, text: string): void {
  header.write(text, offset, length, 'utf8');
}

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, '0')}\0`;

/** Имя делится на `prefix` (до 155 байт) и `name` (до 100) по границе `/`; `undefined`, если не делится. */
export function splitName(name: string): { prefix: string; name: string } | undefined {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', name };
  for (let i = name.indexOf('/'); i >= 0; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest !== '') return { prefix, name: rest };
  }
  return undefined;
}

function header(entry: TarEntry, parts: { prefix: string; name: string }): Buffer {
  const h = Buffer.alloc(BLOCK);
  field(h, 0, 100, parts.name);
  field(h, 100, 8, octal(0o644, 8));
  field(h, 108, 8, octal(0, 8));
  field(h, 116, 8, octal(0, 8));
  field(h, 124, 12, octal(entry.data.length, 12));
  field(h, 136, 12, octal(0, 12));
  field(h, 148, 8, '        ');
  field(h, 156, 1, '0');
  field(h, 257, 6, 'ustar\0');
  field(h, 263, 2, '00');
  field(h, 345, 155, parts.prefix);
  let sum = 0;
  for (const byte of h) sum += byte;
  field(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

/** tar.gz из записей в заданном порядке; бросает, если имя не помещается в ustar. */
export function tarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const parts = splitName(entry.name);
    if (parts === undefined) throw new Error(`${entry.name}: имя не помещается в tar (ustar: до 100 байт в имени и 155 в каталоге)`);
    blocks.push(header(entry, parts), Buffer.from(entry.data));
    const tail = entry.data.length % BLOCK;
    if (tail !== 0) blocks.push(Buffer.alloc(BLOCK - tail));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  // Байт ОС заголовка gzip (RFC 1952) zlib берёт из платформы сборки: 3 на Linux, 19 на macOS, 10 на Windows. 255 - «неизвестно» везде.
  gz[9] = 255;
  return gz;
}

export interface TarContents {
  /** Обычные файлы: путь внутри архива -> содержимое. */
  readonly files: Map<string, Buffer>;
  /** Символические ссылки: путь -> цель. */
  readonly links: Map<string, string>;
}

const MAX_UNPACKED = 512 * 1024 * 1024;

const text = (block: Buffer, offset: number, length: number): string => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
};

/** Расширенный заголовок pax: `<длина> <ключ>=<значение>\n`; нужен только `path`. */
function paxPath(data: Buffer): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < data.length; ) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const length = Number(data.subarray(i, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= space - i) break;
    const record = data.subarray(space + 1, i + length - 1).toString('utf8');
    if (record.startsWith('path=')) found = record.slice('path='.length);
    i += length;
  }
  return found;
}

/**
 * Читает tar.gz в память, ничего не распаковывая на диск: проверка подписи работает над теми же байтами, которые потом лягут в каталог плагина.
 * Принимаются обычные файлы, каталоги и ссылки; устройства и прочее - ошибка. Путь с `..` или абсолютный - ошибка.
 */
export function untarGz(archive: Uint8Array): TarContents {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED });
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  let nextPath: string | undefined;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = parseInt(text(block, 124, 12).trim() || '0', 8);
    if (!Number.isInteger(size) || size < 0) throw new Error('tar: размер записи не прочитан');
    const type = String.fromCharCode(block[156] ?? 0x30);
    const prefix = text(block, 345, 155);
    const stored = text(block, 0, 100);
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length !== size) throw new Error('tar: архив оборван');
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      nextPath = paxPath(body);
      continue;
    }
    if (type === 'g') continue;
    const name = (nextPath ?? (prefix === '' ? stored : `${prefix}/${stored}`)).replace(/\/$/, '');
    nextPath = undefined;
    if (type === '5') continue;
    if (name === '' || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '' || part === '.')) throw new Error(`tar: недопустимый путь ${JSON.stringify(name)}`);
    if (type === '0' || type === '\0') files.set(name, Buffer.from(body));
    else if (type === '2') links.set(name, text(block, 157, 100));
    else throw new Error(`tar: ${name}: запись типа «${type}» в пакет плагина не входит`);
  }
  return { files, links };
}
