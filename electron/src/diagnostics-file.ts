import fs from 'node:fs';
import path from 'node:path';
import { Diagnostics, workspaceKey, type DiagnosticsFs, type DiagnosticsOptions } from '@cyborg-harness/core';

/** Каталог диагностики воркспейса: у каждого свой (K-20: несколько процессов делят `userData`, а прошлый запуск и ротация считаются на воркспейс). */
export function diagnosticsDir(userData: string, workspaceFile: string): string {
  return path.join(userData, 'diagnostics', workspaceKey(workspaceFile));
}

/** Файловая система хранилища диагностики на диске: файлы с правами владельца, каталог заводится при первой записи. */
export function nodeDiagnosticsFs(dir: string): DiagnosticsFs {
  const at = (name: string) => path.join(dir, name);
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
