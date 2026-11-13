import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_FILE_MODE } from './private-files.ts';
import { readJson, withFileLock, writeJsonAtomic } from './workspace.ts';

/** «Недавние» (SAD §3.1) - в ядре: воркспейс выбирается до загрузки любого плагина. */
export class RecentWorkspaces {
  readonly #file: string;
  readonly #limit: number;

  constructor(file: string, limit = 10) {
    this.#file = file;
    this.#limit = limit;
  }

  /** Сначала последний открытый; файла, которого больше нет, в списке нет. */
  list(): string[] {
    return this.#read().filter((f) => fs.existsSync(f));
  }

  // Файл в `userData` общий для всех экземпляров приложения (K-20): чтение и запись идут под замком, иначе запись соседа теряется.
  add(workspace: string): void {
    const file = real(workspace);
    withFileLock(this.#file, () => this.#write([file, ...this.#read().filter((f) => f !== file)]));
  }

  remove(workspace: string): void {
    const file = real(workspace);
    withFileLock(this.#file, () => this.#write(this.#read().filter((f) => f !== file)));
  }

  #read(): string[] {
    let doc: Record<string, unknown> | undefined;
    try {
      doc = readJson(this.#file);
    } catch {
      // Битый список - не повод не открыть окно: следующая запись его заменит.
      doc = undefined;
    }
    const list = Array.isArray(doc?.recent) ? doc.recent : [];
    return list.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f));
  }

  #write(list: readonly string[]): void {
    writeJsonAtomic(this.#file, { recent: list.slice(0, this.#limit) }, PRIVATE_FILE_MODE);
  }
}

const real = (file: string): string => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};
