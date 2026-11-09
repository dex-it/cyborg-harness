import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSecrets, type SecretCipher } from '../src/secrets-file.ts';

const writer = fileURLToPath(new URL('./fixtures/secrets-writer.ts', import.meta.url));

/** Подмена safeStorage: «шифр» обратим и не похож на открытый текст. */
function cipher(overrides: Partial<SecretCipher> = {}): SecretCipher {
  return {
    available: () => true,
    encrypt: (text) => Promise.resolve(Buffer.from(`sealed:${text}`).reverse()),
    decrypt: (sealed) => Promise.resolve({ result: Buffer.from(sealed).reverse().toString().replace(/^sealed:/, ''), shouldReEncrypt: false }),
    ...overrides,
  };
}

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-secrets-')));
  return { root, file: path.join(root, 'nested', 'secrets.json'), [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

test('fileSecrets: значения лежат зашифрованными, get возвращает открытое, права файла 0600, delete убирает', async () => {
  await using box = await sandbox();
  const store = fileSecrets(box.file, cipher());
  assert.equal(await store.available(), true);
  await store.set('jira/token', 'открытый-текст');
  assert.equal(await store.get('jira/token'), 'открытый-текст');
  assert.doesNotMatch(await readFile(box.file, 'utf8'), /открытый-текст/);
  if (process.platform !== 'win32') assert.equal(statSync(box.file).mode & 0o777, 0o600);
  await store.delete('jira/token');
  assert.equal(await store.get('jira/token'), undefined);
});

test('fileSecrets: ключ ОС сменился - значение перезаписывается новым шифрованием', async () => {
  await using box = await sandbox();
  await fileSecrets(box.file, cipher()).set('k', 'v');
  const before = await readFile(box.file, 'utf8');
  const rotated = fileSecrets(box.file, cipher({ encrypt: (text) => Promise.resolve(Buffer.from(`new:${text}`)), decrypt: (sealed) => Promise.resolve({ result: Buffer.from(sealed).reverse().toString().replace(/^sealed:/, ''), shouldReEncrypt: true }) }));
  assert.equal(await rotated.get('k'), 'v');
  assert.notEqual(await readFile(box.file, 'utf8'), before);
});

test('fileSecrets: перешифровка не возвращает значение, стёртое или переписанное во время расшифровки', async () => {
  await using box = await sandbox();
  await fileSecrets(box.file, cipher()).set('gone', 'старое');
  await fileSecrets(box.file, cipher()).set('newer', 'старое');
  let during: (() => Promise<void>) | undefined;
  const base = cipher();
  const rotated = fileSecrets(
    box.file,
    cipher({
      decrypt: async (sealed) => {
        const plain = await base.decrypt(sealed);
        await during?.();
        return { result: plain.result, shouldReEncrypt: true };
      },
    }),
  );
  const other = fileSecrets(box.file, cipher());
  during = () => other.delete('gone');
  assert.equal(await rotated.get('gone'), 'старое');
  assert.equal(await other.get('gone'), undefined, 'стёртый секрет вернулся');
  during = () => other.set('newer', 'новое');
  assert.equal(await rotated.get('newer'), 'старое');
  assert.equal(await other.get('newer'), 'новое', 'новое значение затёрто старым');
});

test('fileSecrets: запись не оставляет временных файлов и не рвёт файл', async () => {
  await using box = await sandbox();
  const store = fileSecrets(box.file, cipher());
  for (let i = 0; i < 5; i++) await store.set(`k${String(i)}`, 'v');
  assert.deepEqual((await readdir(path.dirname(box.file))).sort(), ['secrets.json']);
  assert.equal(Object.keys(JSON.parse(await readFile(box.file, 'utf8')) as object).length, 5);
});

test('fileSecrets из четырёх процессов одного userData: ни один секрет не потерян', async () => {
  await using box = await sandbox();
  const codes = await Promise.all(
    [0, 1, 2, 3].map((i) => {
      const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', writer, box.file, String(i), '20'], { stdio: ['ignore', 'ignore', 'inherit'] });
      return new Promise<number | null>((resolve) => child.once('exit', resolve));
    }),
  );
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const stored = JSON.parse(await readFile(box.file, 'utf8')) as Record<string, string>;
  assert.equal(Object.keys(stored).length, 80);
});
