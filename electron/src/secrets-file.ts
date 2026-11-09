import fs from 'node:fs';
import { withFileLock, type SecretStore } from '@cyborg-harness/core';

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
  // Временный файл и rename: оборванная запись не оставляет полупустой файл, права 0600 ставятся при создании.
  const write = (data: Record<string, string>) => {
    const tmp = `${file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  // Файл в `userData` общий для всех экземпляров приложения (K-20): чтение, правка и запись идут под замком.
  // Шифрование (асинхронное) остаётся снаружи замка: внутри только синхронная работа с файлом.
  const update = (change: (data: Record<string, string>) => Record<string, string>) => {
    withFileLock(file, () => {
      write(change(read()));
    });
  };
  const set = async (key: string, value: string) => {
    const sealed = (await cipher.encrypt(value)).toString('base64');
    update((data) => ({ ...data, [key]: sealed }));
  };
  return {
    available: () => cipher.available(),
    get: async (key) => {
      const sealed = read()[key];
      if (sealed === undefined) return undefined;
      const { result, shouldReEncrypt } = await cipher.decrypt(Buffer.from(sealed, 'base64'));
      // Ключ ОС сменился: старое шифрование ещё читается, но перезаписываем новым. Пока шли шифры, значение могли
      // переписать или стереть (этот или другой процесс): перешифровывается только то, что было прочитано.
      if (shouldReEncrypt) {
        const fresh = (await cipher.encrypt(result)).toString('base64');
        update((data) => (data[key] === sealed ? { ...data, [key]: fresh } : data));
      }
      return result;
    },
    set,
    delete: (key) => {
      update((data) => Object.fromEntries(Object.entries(data).filter(([k]) => k !== key)));
      return Promise.resolve();
    },
  };
}
