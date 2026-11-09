import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileSecrets, type SecretCipher } from '../src/secrets-file.ts';

const writer = fileURLToPath(new URL('./fixtures/secrets-writer.ts', import.meta.url));

/** Подмена safeStorage: «шифр» обратим и не похож на открытый текст. */
function cipher(overrides: Partial<SecretCipher> = {}): SecretCipher {
  return {
    available: () => true,
    encrypt: async (text) => Buffer.from(`sealed:${text}`).reverse(),
    decrypt: async (sealed) => ({ result: Buffer.from(sealed).reverse().toString().replace(/^sealed:/, ''), shouldReEncrypt: false }),
    ...overrides,
  };
}

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-secrets-')));
  return { file: path.join(root, 'nested', 'secrets.json'), [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

const keysOf = async (file: string) => Object.keys(JSON.parse(await readFile(file, 'utf8')) as object).sort();

test('fileSecrets: значения лежат зашифрованными, get возвращает открытое, права файла 0600', async () => {
  await using box = await sandbox();
  const store = fileSecrets(box.file, cipher());
  assert.equal(await store.available(), true);
  await store.set('jira/token', 'открытый-текст');
  assert.equal(await store.get('jira/token'), 'открытый-текст');
  assert.equal(await store.get('jira/none'), undefined);
  assert.ok(!(await readFile(box.file, 'utf8')).includes('открытый-текст'));
  assert.equal((await stat(box.file)).mode & 0o777, 0o600);
});

test('fileSecrets: ключ ОС сменился - значение читается и перезаписывается новым шифрованием', async () => {
  await using box = await sandbox();
  await fileSecrets(box.file, cipher()).set('a/k', 'v');
  const before = await readFile(box.file, 'utf8');
  let sealedAgain = 0;
  const store = fileSecrets(
    box.file,
    cipher({
      decrypt: async (sealed) => ({ result: Buffer.from(sealed).reverse().toString().replace(/^sealed:/, ''), shouldReEncrypt: true }),
      encrypt: async (text) => {
        sealedAgain++;
        return Buffer.from(`new:${text}`);
      },
    }),
  );
  assert.equal(await store.get('a/k'), 'v');
  assert.equal(sealedAgain, 1);
  // Новый шифр отличим от прежнего: иначе файл без перезаписи совпал бы с записанным заново.
  assert.notEqual(await readFile(box.file, 'utf8'), before, 'перешифрованное значение не записано');
  const stored = JSON.parse(await readFile(box.file, 'utf8')) as Record<string, string>;
  assert.equal(Buffer.from(stored['a/k']!, 'base64').toString(), 'new:v');
});

test('fileSecrets: delete стирает один ключ', async () => {
  await using box = await sandbox();
  const store = fileSecrets(box.file, cipher());
  await store.set('a/x', '1');
  await store.set('a/y', '2');
  await store.delete('a/x');
  assert.deepEqual(await keysOf(box.file), ['a/y']);
});

test('fileSecrets: deletePrefix стирает ключи с префиксом `<id>/`, соседи с общим началом целы, возвращает число', async () => {
  await using box = await sandbox();
  const store = fileSecrets(box.file, cipher());
  for (const key of ['jira/token', 'jira/deep/key', 'jira2/token', 'jira.sub/token', 'other/jira/token']) await store.set(key, key);
  assert.equal(await store.deletePrefix('jira/'), 2);
  assert.deepEqual(await keysOf(box.file), ['jira.sub/token', 'jira2/token', 'other/jira/token']);
  assert.equal(await store.get('jira2/token'), 'jira2/token', 'оставшиеся значения читаются');
  assert.equal(await store.deletePrefix('jira/'), 0);
});

test('fileSecrets: deletePrefix не требует шифрования ОС и не создаёт файл, когда стирать нечего', async () => {
  await using box = await sandbox();
  const sealed = fileSecrets(box.file, cipher());
  await sealed.set('jira/token', 't');
  const locked = fileSecrets(box.file, cipher({ available: () => false }));
  assert.equal(await locked.available(), false);
  assert.equal(await locked.deletePrefix('jira/'), 1);
  assert.deepEqual(await keysOf(box.file), []);

  await using empty = await sandbox();
  assert.equal(await fileSecrets(empty.file, cipher()).deletePrefix('jira/'), 0);
  await assert.rejects(stat(empty.file), { code: 'ENOENT' });
});

test('fileSecrets: deletePrefix во время шифрования чужого set - стёртый ключ не возвращается', async () => {
  await using box = await sandbox();
  const slow = cipher({ encrypt: async (text) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Buffer.from(`sealed:${text}`).reverse();
  } });
  const store = fileSecrets(box.file, slow);
  await store.set('jira/token', 'x');
  const pending = store.set('other/token', 'y');
  assert.equal(await store.deletePrefix('jira/'), 1);
  await pending;
  assert.deepEqual(await keysOf(box.file), ['other/token']);
});

test('fileSecrets: битый файл не стирается молча и не падает на deletePrefix', async () => {
  await using box = await sandbox();
  const store = fileSecrets(box.file, cipher());
  await store.set('a/k', 'v');
  await writeFile(box.file, '{не json');
  assert.equal(await store.deletePrefix('a/'), 0);
  assert.equal(await readFile(box.file, 'utf8'), '{не json', 'файл не перезаписан');
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
