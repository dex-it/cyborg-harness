// Фьюзы Electron без пакета @electron/fuses: чтение и переключение в бинарнике (TR-07, TR-20; docs/05-verification/spike-node-host.md, electron/README.md).
// Формат («провод» фьюзов) - sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, байт версии (1), байт длины N и N байт состояния: '1' - включён, '0' - выключен, 'r' - удалён.
// Порядок и имена - FuseV1Options из @electron/fuses 2.1.3 (dist/config.js); на Electron 45.2.3 в бинарнике 9 фьюзов, состояние по умолчанию сверено тестом playground/test/fuses.test.ts.
import { Buffer } from 'node:buffer';
import { closeSync, fstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
export const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers',
];

/** Файл, в котором лежит провод фьюзов: на macOS - бинарник фреймворка внутри пакета приложения (`bundle` - имя `.app`), на остальных - сам исполняемый файл. */
export function fuseFile(dist, bundle = 'Electron.app', executable = 'electron') {
  if (process.platform === 'darwin') return join(dist, bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  return join(dist, process.platform === 'win32' ? `${executable}.exe` : executable);
}

/** Положение провода в файле: позиция первого байта состояния и длина; провод должен быть ровно один. */
function locate(buffer) {
  const sentinel = Buffer.from(SENTINEL);
  const at = buffer.indexOf(sentinel);
  if (at === -1) throw new Error('в бинарнике нет провода фьюзов (sentinel не найден)');
  if (buffer.indexOf(sentinel, at + 1) !== -1) throw new Error('провод фьюзов найден дважды');
  const version = buffer[at + sentinel.length];
  const length = buffer[at + sentinel.length + 1];
  if (version !== 1) throw new Error(`версия провода фьюзов ${String(version)}, ожидалась 1`);
  return { start: at + sentinel.length + 2, length };
}

const STATE = { 0x31: 'on', 0x30: 'off', 0x72: 'removed' };

/** Состояние фьюзов: `{ RunAsNode: 'on', ... }`; фьюзы сверх известных имён получают имя `fuse<i>`. */
export function readFuses(file) {
  const buffer = readFileSync(file);
  const { start, length } = locate(buffer);
  return Object.fromEntries(Array.from({ length }, (_, i) => [FUSE_NAMES[i] ?? `fuse${String(i)}`, STATE[buffer[start + i]] ?? `?${String(buffer[start + i])}`]));
}

/** Записывает состояние: `{ RunAsNode: false }`. Меняет файл на месте (подпись macOS после этого недействительна - подписать заново). */
export function flipFuses(file, changes) {
  const buffer = readFileSync(file);
  const { start, length } = locate(buffer);
  const fd = openSync(file, 'r+');
  try {
    for (const [name, on] of Object.entries(changes)) {
      const index = FUSE_NAMES.indexOf(name);
      if (index === -1 || index >= length) throw new Error(`нет фьюза ${name} в бинарнике (фьюзов ${String(length)})`);
      if (buffer[start + index] === 0x72) throw new Error(`фьюз ${name} удалён из этой сборки Electron`);
      writeSync(fd, Buffer.from(on ? '1' : '0'), 0, 1, start + index);
    }
    if (fstatSync(fd).size !== buffer.length) throw new Error('размер файла изменился');
  } finally {
    closeSync(fd);
  }
}
