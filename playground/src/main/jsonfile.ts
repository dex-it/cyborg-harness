import fs from 'node:fs';

/** Запись через временный файл и rename: оборванная запись не оставляет полупустой файл. */
export function writeJsonAtomic(file: string, data: unknown): void {
  // pid в имени: два экземпляра приложения не делят временный файл.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
