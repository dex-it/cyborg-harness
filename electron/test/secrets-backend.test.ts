import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { safeStorageCipher, secretsBackendProblem, type SafeStorageLike } from '../src/secrets-backend.ts';
import { fileSecrets, type SecretCipher } from '../src/secrets-file.ts';

test('ST-3004/1: Linux с backend basic_text - причина словами; другие backend и платформы поведения не меняют', () => {
  const reason = secretsBackendProblem('linux', 'basic_text');
  assert.match(reason ?? '', /нет хранилища паролей/);
  for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'unknown', undefined]) {
    assert.equal(secretsBackendProblem('linux', backend), undefined, String(backend));
  }
  assert.equal(secretsBackendProblem('darwin', 'not_used'), undefined);
  assert.equal(secretsBackendProblem('darwin', 'basic_text'), undefined, 'backend читается только на Linux');
});

test('ST-3004/1: хранилище в файле отдаёт причину шифра ядру, а шифр без причины - прежняя форма без поля', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyborg-secrets-backend-'));
  try {
    const cipher: SecretCipher = {
      available: () => false,
      unavailableReason: () => 'причина',
      encrypt: () => Promise.reject(new Error('не шифровать')),
      decrypt: () => Promise.reject(new Error('не расшифровывать')),
    };
    const store = fileSecrets(path.join(dir, 'secrets.json'), cipher);
    assert.equal(await store.available(), false);
    assert.equal(store.unavailableReason?.(), 'причина');
    assert.deepEqual(await readdir(dir), [], 'файл секретов не создан');
    const plain = fileSecrets(path.join(dir, 'other.json'), { available: () => true, encrypt: () => Promise.resolve(Buffer.from('x')), decrypt: () => Promise.resolve({ result: 'x', shouldReEncrypt: false }) });
    assert.ok(!('unavailableReason' in plain));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeStorage(backend: () => string, encryption: boolean) {
  const calls = { backend: 0, available: 0 };
  const storage: SafeStorageLike = {
    getSelectedStorageBackend: () => (calls.backend++, backend()),
    isAsyncEncryptionAvailable: () => (calls.available++, Promise.resolve(encryption)),
    encryptStringAsync: (text) => Promise.resolve(Buffer.from(text)),
    decryptStringAsync: (sealed) => Promise.resolve({ result: sealed.toString(), shouldReEncrypt: false }),
  };
  return { storage, calls };
}

test('ST-3004/1: шифр safeStorage на Linux с basic_text недоступен с причиной и не спрашивает isAsyncEncryptionAvailable', async () => {
  const { storage, calls } = fakeStorage(() => 'basic_text', true);
  const cipher = safeStorageCipher(storage, 'linux');
  assert.equal(await cipher.available(), false);
  assert.equal(calls.available, 0);
  assert.match(cipher.unavailableReason?.() ?? '', /нет хранилища паролей/);
});

test('ST-3004/1: шифр safeStorage на Linux с gnome_libsecret - доступность решает safeStorage, причины нет', async () => {
  for (const encryption of [true, false]) {
    const { storage } = fakeStorage(() => 'gnome_libsecret', encryption);
    const cipher = safeStorageCipher(storage, 'linux');
    assert.equal(await cipher.available(), encryption);
    assert.equal(cipher.unavailableReason?.(), undefined);
  }
  const { storage } = fakeStorage(() => 'gnome_libsecret', true);
  const cipher = safeStorageCipher(storage, 'linux');
  assert.deepEqual(await cipher.decrypt(await cipher.encrypt('секрет')), { result: 'секрет', shouldReEncrypt: false });
});

test('ST-3004/1: сбой getSelectedStorageBackend не отказ - backend неизвестен, доступность решает safeStorage', async () => {
  const { storage, calls } = fakeStorage(() => {
    throw new Error('приложение ещё не готово');
  }, true);
  const cipher = safeStorageCipher(storage, 'linux');
  assert.equal(cipher.unavailableReason?.(), undefined);
  assert.equal(await cipher.available(), true);
  assert.equal(calls.available, 1);
});

test('ST-3004/1: на macOS backend не спрашивается: доступность только от safeStorage', async () => {
  const { storage, calls } = fakeStorage(() => 'basic_text', true);
  const cipher = safeStorageCipher(storage, 'darwin');
  assert.equal(await cipher.available(), true);
  assert.equal(cipher.unavailableReason?.(), undefined);
  assert.equal(calls.backend, 0);
});
