// TR-05, FR-CH-3026: одна запись приватных файлов данных приложения для ядра, адаптера и приложения.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensurePrivateDir, narrowMode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writeFileAtomic } from '../src/private-files.ts';

const posix = process.platform !== 'win32';
const mode = async (file: string): Promise<string> => ((await stat(file)).mode & 0o777).toString(8);

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-private-')));
  const before = process.umask(0o000);
  try {
    await run(root);
  } finally {
    process.umask(before);
    await rm(root, { recursive: true, force: true });
  }
}

test('ST-3004/6: writeFileAtomic с mode пишет файл 0600 при umask 000 и не оставляет временного файла', { skip: !posix }, () =>
  inTemp(async (root) => {
    const file = path.join(root, 'sub', 'cyborg.json');
    writeFileAtomic(file, '{"a":1}', { mode: PRIVATE_FILE_MODE });
    assert.equal(await readFile(file, 'utf8'), '{"a":1}');
    assert.equal(await mode(file), '600');
    assert.deepEqual(await readdir(path.dirname(file)), ['cyborg.json']);
  }));

test('ST-3004/6: writeFileAtomic заменяет прежний открытый файл закрытым, оставшийся открытый временный файл тоже сужается', { skip: !posix }, () =>
  inTemp(async (root) => {
    const file = path.join(root, 'secrets.json');
    await writeFile(file, 'old', { mode: 0o644 });
    await writeFile(`${file}.${String(process.pid)}.tmp`, 'tmp', { mode: 0o666 });
    writeFileAtomic(file, 'new', { mode: PRIVATE_FILE_MODE });
    assert.equal(await readFile(file, 'utf8'), 'new');
    assert.equal(await mode(file), '600');
  }));

test('ST-3004/6: writeFileAtomic без mode прав не задаёт, privateDir заводит каталог 0700', { skip: !posix }, () =>
  inTemp(async (root) => {
    const open = path.join(root, 'team', 'w.cyborg.json');
    writeFileAtomic(open, '{}');
    assert.equal(await mode(open), '666', 'файл воркспейса: права по umask');
    const own = path.join(root, 'state', 'k.json');
    writeFileAtomic(own, '{}', { mode: PRIVATE_FILE_MODE, privateDir: true });
    assert.equal(await mode(path.dirname(own)), '700');
  }));

test('ST-3004/6: narrowMode сужает открытое, закрытое не трогает, отсутствующий путь терпит', { skip: !posix }, () =>
  inTemp(async (root) => {
    const wide = path.join(root, 'wide');
    await writeFile(wide, '', { mode: 0o644 });
    narrowMode(wide, PRIVATE_FILE_MODE);
    assert.equal(await mode(wide), '600');
    const ownerOnly = path.join(root, 'owner-only');
    await writeFile(ownerOnly, '', { mode: 0o400 });
    narrowMode(ownerOnly, PRIVATE_FILE_MODE);
    assert.equal(await mode(ownerOnly), '400', 'права только владельца не расширяются');
    assert.doesNotThrow(() => {
      narrowMode(path.join(root, 'нет'), PRIVATE_FILE_MODE);
    });
  }));

test('ST-3004/6: ensurePrivateDir создаёт каталог 0700 и сужает прежний открытый', { skip: !posix }, () =>
  inTemp(async (root) => {
    const fresh = path.join(root, 'a', 'b');
    ensurePrivateDir(fresh);
    assert.equal(await mode(fresh), PRIVATE_DIR_MODE.toString(8));
    const old = path.join(root, 'old');
    await mkdir(old);
    await chmod(old, 0o755);
    ensurePrivateDir(old);
    assert.equal(await mode(old), '700');
  }));
