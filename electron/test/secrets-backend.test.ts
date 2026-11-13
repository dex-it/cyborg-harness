import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { secretsBackendProblem } from '../src/secrets-backend.ts';
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
