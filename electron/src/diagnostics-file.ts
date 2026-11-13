import fs from 'node:fs';
import path from 'node:path';
import { Diagnostics, workspaceKey, type DiagnosticsFs, type DiagnosticsOptions } from '@cyborg-harness/core';

/** Каталог диагностики воркспейса: у каждого свой (K-20: несколько процессов делят `userData`, а прошлый запуск и ротация считаются на воркспейс). */
export function diagnosticsDir(userData: string, workspaceFile: string): string {
  return path.join(userData, 'diagnostics', workspaceKey(workspaceFile));
}

/** Права владельца на каталоги диагностики и её файлы (TR-05): прежние, созданные с правами по умолчанию, сужаются; чужое и недоступное остаётся как есть. */
function tighten(dir: string): void {
  const narrow = (target: string, mode: number) => {
    try {
      if ((fs.statSync(target).mode & 0o077) !== 0) fs.chmodSync(target, mode);
    } catch {
      // Нет права менять - запись всё равно идёт в закрытый файл.
    }
  };
  narrow(path.dirname(dir), 0o700);
  narrow(dir, 0o700);
  for (const name of fs.readdirSync(dir)) narrow(path.join(dir, name), 0o600);
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
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!tightened) {
        tighten(dir);
        tightened = true;
      }
      fs.appendFileSync(at(name), text, { mode: 0o600 });
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
