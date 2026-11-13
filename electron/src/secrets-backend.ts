import type { SecretCipher } from './secrets-file.ts';

/**
 * Хранилище паролей Linux глазами человека (TR-04, docs/research/trust-and-isolation): `safeStorage` на Linux без GNOME Keyring или KWallet
 * шифрует «зашитым открытым паролем» (`getSelectedStorageBackend() === 'basic_text'`), и такое шифрование защиты не даёт. Тогда хранилище секретов
 * объявляется недоступным (ADR-CH-0014, п. 1), а не принимает значения как будто они защищены. Другие платформы и backend-ы поведения не меняют.
 */
export function secretsBackendProblem(platform: NodeJS.Platform, backend: string | undefined): string | undefined {
  if (platform !== 'linux' || backend !== 'basic_text') return undefined;
  return 'на этом компьютере нет хранилища паролей (GNOME Keyring или KWallet), и Electron шифровал бы секреты открытым паролем внутри самой программы; запустите хранилище паролей и перезапустите приложение';
}

/** Часть `safeStorage` Electron, которую берёт шифр секретов; своя форма, чтобы проверять шифр юнит-тестом без Electron. */
export interface SafeStorageLike {
  getSelectedStorageBackend?(): string;
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(text: string): Promise<Buffer>;
  decryptStringAsync(sealed: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** Шифр секретов поверх `safeStorage`: на Linux с `basic_text` недоступен с причиной словами, не спрашивая `isAsyncEncryptionAvailable`. */
export function safeStorageCipher(storage: SafeStorageLike, platform: NodeJS.Platform): SecretCipher {
  const backend = (): string | undefined => {
    if (platform !== 'linux') return undefined;
    try {
      return storage.getSelectedStorageBackend?.();
    } catch {
      // Сбой вызова (до готовности приложения) не причина отказывать: backend неизвестен, решает сам safeStorage.
      return undefined;
    }
  };
  return {
    available: async () => secretsBackendProblem(platform, backend()) === undefined && (await storage.isAsyncEncryptionAvailable()),
    unavailableReason: () => secretsBackendProblem(platform, backend()),
    encrypt: (text) => storage.encryptStringAsync(text),
    decrypt: (sealed) => storage.decryptStringAsync(sealed),
  };
}
