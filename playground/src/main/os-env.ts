import fs from 'node:fs';
import path from 'node:path';
import { clipboard, Notification, safeStorage } from 'electron';
import * as nodePty from 'node-pty';
import type { OsEnvironment, SecretStore } from '../../../core/src/index.ts';

/** Секреты в файле, каждое значение зашифровано safeStorage; без шифрования ОС хранилище недоступно, а не открыто. */
export function fileSecrets(file: string): SecretStore {
  const read = (): Record<string, string> => {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof data === 'object' && data !== null ? (data as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  const set = async (key: string, value: string) => write({ ...read(), [key]: (await safeStorage.encryptStringAsync(value)).toString('base64') });
  return {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    get: async (key) => {
      const sealed = read()[key];
      if (sealed === undefined) return undefined;
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));
      // Ключ ОС сменился: старое шифрование ещё читается, но перезаписываем новым.
      if (shouldReEncrypt) await set(key, result);
      return result;
    },
    set,
    delete: async (key) => write(Object.fromEntries(Object.entries(read()).filter(([k]) => k !== key))),
  };
}

export function electronOs(options: { userData: string; roots: () => readonly string[]; protectedPaths: readonly string[] }): OsEnvironment {
  return {
    dataDir: path.join(options.userData, 'plugin-data'),
    tempDir: path.join(options.userData, 'plugin-temp'),
    appDir: options.userData,
    protectedPaths: options.protectedPaths,
    roots: options.roots,
    secrets: fileSecrets(path.join(options.userData, 'secrets.json')),
    notify: (title, body) => new Notification({ title, ...(body !== undefined && { body }) }).show(),
    clipboard: { readText: () => clipboard.readText(), writeText: (text) => clipboard.writeText(text) },
    pty: { spawn: (file, args, o) => nodePty.spawn(file, args, o) },
  };
}
