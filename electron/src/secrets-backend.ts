/**
 * Хранилище паролей Linux глазами человека (TR-04, docs/research/trust-and-isolation): `safeStorage` на Linux без GNOME Keyring или KWallet
 * шифрует «зашитым открытым паролем» (`getSelectedStorageBackend() === 'basic_text'`), и такое шифрование защиты не даёт. Тогда хранилище секретов
 * объявляется недоступным (ADR-CH-0014, п. 1), а не принимает значения как будто они защищены. Другие платформы и backend-ы поведения не меняют.
 */
export function secretsBackendProblem(platform: NodeJS.Platform, backend: string | undefined): string | undefined {
  if (platform !== 'linux' || backend !== 'basic_text') return undefined;
  return 'на этом компьютере нет хранилища паролей (GNOME Keyring или KWallet), и Electron шифровал бы секреты открытым паролем внутри самой программы; запустите хранилище паролей и перезапустите приложение';
}
