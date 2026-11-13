import fs from 'node:fs';
import path from 'node:path';
import { Diagnostics, narrowMode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, workspaceKey, type DiagnosticsFs, type DiagnosticsOptions } from '@cyborg-harness/core';

/** Каталог диагностики воркспейса: у каждого свой (K-20: несколько процессов делят `userData`, а прошлый запуск и ротация считаются на воркспейс). */
export function diagnosticsDir(userData: string, workspaceFile: string): string {
  return path.join(userData, 'diagnostics', workspaceKey(workspaceFile));
}

/** Права владельца на каталоги диагностики и её файлы (TR-05): прежние, созданные с правами по умолчанию, сужаются; чужое и недоступное остаётся как есть. */
function tighten(dir: string): void {
  narrowMode(path.dirname(dir), PRIVATE_DIR_MODE);
  narrowMode(dir, PRIVATE_DIR_MODE);
  for (const name of fs.readdirSync(dir)) narrowMode(path.join(dir, name), PRIVATE_FILE_MODE);
}

/** Файловая система хранилища диагностики на диске: файлы `0600` и каталоги `0700` независимо от umask, каталог заводится при первой записи. */
export function nodeDiagnosticsFs(dir: string): DiagnosticsFs {
  const at = (name: string) => path.join(dir, name);
  let tightened = false;
  return {
    list: () => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    read: (name) => fs.readFileSync(at(name), 'utf8'),
    append: (name, text) => {
      fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
      if (!tightened) {
        tighten(dir);
        tightened = true;
      }
      fs.appendFileSync(at(name), text, { mode: PRIVATE_FILE_MODE });
    },
    size: (name) => fs.statSync(at(name), { throwIfNoEntry: false })?.size ?? 0,
    rename: (from, to) => {
      fs.renameSync(at(from), at(to));
    },
    remove: (name) => {
      fs.rmSync(at(name), { force: true });
    },
  };
}

/** Хранилище диагностики воркспейса в `userData` (FR-CH-4012): создаётся до запуска ядра и передаётся в `StartOptions.diagnostics`. */
export function fileDiagnostics(userData: string, workspaceFile: string, options: Omit<DiagnosticsOptions, 'fs'> = {}): Diagnostics {
  return new Diagnostics({ ...options, fs: nodeDiagnosticsFs(diagnosticsDir(userData, workspaceFile)) });
}
