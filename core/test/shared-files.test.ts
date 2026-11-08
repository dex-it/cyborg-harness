import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFileLock, writeJsonAtomic } from '../src/workspace.ts';

// K-20: несколько процессов приложения делят `userData`. Файлы, которые они пишут вместе, не теряют записей.

const writer = fileURLToPath(new URL('./fixtures/shared-writer.ts', import.meta.url));

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-shared-')));
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

/** Запускает писателей одновременно, каждый в своём процессе, и ждёт всех. */
async function race(mode: string, dir: string, writers: number, count: number): Promise<void> {
  const codes = await Promise.all(
    Array.from({ length: writers }, (_, i) => {
      const child = spawn(process.execPath, [writer, mode, dir, String(i), String(count)], { stdio: ['ignore', 'ignore', 'inherit'] });
      return new Promise<number | null>((resolve) => child.once('exit', resolve));
    }),
  );
  assert.deepEqual(codes, Array<number>(writers).fill(0), 'писатель упал');
}

const json = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

test('«Недавние» из четырёх процессов: ни одна запись не потеряна', async () => {
  await using box = await sandbox();
  await race('recent', box.root, 4, 25);
  const list = (await json(path.join(box.root, 'recent.json'))).recent as string[];
  assert.equal(list.length, 100);
  assert.equal(new Set(list).size, 100);
});

test('слой пользователя из трёх процессов: разделы разных процессов все на месте', async () => {
  await using box = await sandbox();
  await race('user', box.root, 3, 20);
  const settings = (await json(path.join(box.root, 'user', 'cyborg.json'))).settings as Record<string, unknown>;
  assert.equal(Object.keys(settings).length, 60);
});

test('withFileLock: чтение-изменение-запись из процессов не теряет приращений', async () => {
  await using box = await sandbox();
  await race('counter', box.root, 4, 15);
  assert.equal(await readFile(path.join(box.root, 'counter.txt'), 'utf8'), '60');
});

test('withFileLock: оставшийся от умершего процесса замок снимает один из шести, остальные его замок не крадут', async () => {
  await using box = await sandbox();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(path.join(box.root, 'counter.txt.write.lock'), JSON.stringify({ pid: dead }));
  await race('counter', box.root, 6, 10);
  assert.equal(await readFile(path.join(box.root, 'counter.txt'), 'utf8'), '60');
});

test('withFileLock: замок снят после ошибки, замок умершего процесса забирается, живой не отдаётся', async () => {
  await using box = await sandbox();
  const file = path.join(box.root, 'dir', 'shared.json');
  assert.throws(
    () =>
      withFileLock(file, () => {
        throw new Error('сбой');
      }),
    /сбой/,
  );
  assert.equal(
    withFileLock(file, () => 'взят'),
    'взят',
    'после ошибки замок остался',
  );
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(`${file}.write.lock`, JSON.stringify({ pid: dead }));
  assert.equal(
    withFileLock(file, () => 'забран'),
    'забран',
  );
  await writeFile(`${file}.write.lock`, JSON.stringify({ pid: process.ppid }));
  assert.throws(() => withFileLock(file, () => 'не должно', { timeoutMs: 100 }), new RegExp(`pid ${String(process.ppid)}`));
});

test('writeJsonAtomic: права файла задаются при создании, а не после', async () => {
  await using box = await sandbox();
  const file = path.join(box.root, 'secrets.json');
  writeJsonAtomic(file, { a: 1 }, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
