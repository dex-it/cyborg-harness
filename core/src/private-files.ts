import fs from 'node:fs';
import path from 'node:path';

/** Права файлов данных приложения в `userData` (TR-05, FR-CH-3026); umask их только сужает, а не задаёт. */
export const PRIVATE_FILE_MODE = 0o600;
/** Права своих каталогов данных приложения (`state`, `diagnostics`). */
export const PRIVATE_DIR_MODE = 0o700;

/** Сужает до `mode` права пути, открытые группе или остальным; чужой путь или отказ `chmod` оставляет как есть. */
export function narrowMode(target: string, mode: number): void {
  try {
    if ((fs.statSync(target).mode & 0o077) !== 0) fs.chmodSync(target, mode);
  } catch {
    // Отказ записи здесь был бы строже нормы: файл внутри всё равно пишется с закрытыми правами.
  }
}

/** Свой каталог данных приложения: создаётся `0700`, прежний открытый сужается; не для `userData` целиком и не для места, выбранного человеком. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  narrowMode(dir, PRIVATE_DIR_MODE);
}

/** Параметры `writeFileAtomic`. */
export interface AtomicWriteOptions {
  /** Права файла; rename подменяет файл целиком, поэтому прежний открытый заменяется закрытым. */
  readonly mode?: number;
  /** Каталог файла свой, `0700` (`ensurePrivateDir`). */
  readonly privateDir?: boolean;
}

/** Запись через временный файл и rename: оборванная запись не оставляет полупустой файл. */
export function writeFileAtomic(file: string, text: string, options: AtomicWriteOptions = {}): void {
  if (options.privateDir === true) ensurePrivateDir(path.dirname(file));
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  // pid в имени: два экземпляра приложения не делят временный файл.
  const tmp = `${file}.${String(process.pid)}.tmp`;
  const { mode } = options;
  fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  // Временный файл прошлого запуска с тем же pid мог остаться открытым: режим при создании к существующему не применяется.
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}
