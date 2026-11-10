import { fileSecrets, type SecretCipher } from '../../src/secrets-file.ts';

/** Писатель секретов в отдельном процессе: `node secrets-writer.ts <файл> <номер> <записей>`; значения «шифруются» обратимо и без Electron. */
const [file, index, count] = process.argv.slice(2) as [string, string, string];
const cipher: SecretCipher = {
  available: () => true,
  encrypt: (text) => Promise.resolve(Buffer.from(`sealed:${text}`)),
  decrypt: (sealed) => Promise.resolve({ result: sealed.toString().replace(/^sealed:/, ''), shouldReEncrypt: false }),
};
const store = fileSecrets(file, cipher);
for (let i = 0; i < Number(count); i++) await store.set(`k${index}-${String(i)}`, `v${index}-${String(i)}`);
