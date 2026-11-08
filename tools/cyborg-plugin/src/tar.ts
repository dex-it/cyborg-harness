import { gzipSync } from 'node:zlib';

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
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
