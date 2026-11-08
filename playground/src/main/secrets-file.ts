import fs from 'node:fs';
import path from 'node:path';
import type { SecretStore } from '../../../core/src/index.ts';

/** Шифр ОС (в приложении - `safeStorage`); отдельно от файла, чтобы файловую часть проверял юнит-тест без Electron. */
export interface SecretCipher {
  available(): boolean | Promise<boolean>;
  encrypt(text: string): Promise<Buffer>;
  /** `shouldReEncrypt`: ключ ОС сменился, старое шифрование ещё читается. */
  decrypt(sealed: Buffer): Promise<{ readonly result: string; readonly shouldReEncrypt: boolean }>;
}

/** Секреты в файле, каждое значение зашифровано шифром ОС; без шифрования ОС хранилище недоступно, а не открыто. */
export function fileSecrets(file: string, cipher: SecretCipher): SecretStore {
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
  const set = async (key: string, value: string) => write({ ...read(), [key]: (await cipher.encrypt(value)).toString('base64') });
  return {
    available: () => cipher.available(),
    get: async (key) => {
      const sealed = read()[key];
      if (sealed === undefined) return undefined;
      const { result, shouldReEncrypt } = await cipher.decrypt(Buffer.from(sealed, 'base64'));
      // Ключ ОС сменился: старое шифрование ещё читается, но перезаписываем новым.
      if (shouldReEncrypt) await set(key, result);
      return result;
    },
    set,
    delete: async (key) => write(Object.fromEntries(Object.entries(read()).filter(([k]) => k !== key))),
    // Расшифровывать для стирания нечего: ключи в файле открытые, поэтому работает и без шифрования ОС.
    deletePrefix: async (prefix) => {
      const all = read();
      const kept = Object.entries(all).filter(([k]) => !k.startsWith(prefix));
      const removed = Object.keys(all).length - kept.length;
      if (removed > 0) write(Object.fromEntries(kept));
      return removed;
    },
  };
}
