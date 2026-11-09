import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
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

test('withFileLock: замки умерших процессов то и дело появляются - каждый снимает один процесс, замок живого соседа не крадётся', async () => {
  await using box = await sandbox();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = path.join(box.root, 'counter.txt.write.lock');
  // Подбрасывает замок «упавшего» процесса, как только место свободно: у участников постоянно идёт гонка за снятие.
  const saboteur = setInterval(() => {
    try {
      writeFileSync(lock, JSON.stringify({ pid: dead }), { flag: 'wx' });
    } catch {
      // Замок есть: чей-то живой или ещё не снятый мёртвый.
    }
  }, 1);
  try {
    await race('counter', box.root, 8, 60);
  } finally {
    clearInterval(saboteur);
  }
  assert.equal(await readFile(path.join(box.root, 'counter.txt'), 'utf8'), '480');
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
  // Процесс умер, держа охранный файл снятия: охрану снимает следующий, иначе замок умершего не забрать никогда.
  await writeFile(`${file}.write.lock`, JSON.stringify({ pid: dead }));
  await writeFile(`${file}.write.lock.reclaim`, JSON.stringify({ pid: dead }));
  assert.equal(
    withFileLock(file, () => 'охрана снята', { timeoutMs: 2000 }),
    'охрана снята',
  );
  await writeFile(`${file}.write.lock`, JSON.stringify({ pid: process.ppid }));
  assert.throws(() => withFileLock(file, () => 'не должно', { timeoutMs: 100, staleMs: 60_000 }), new RegExp(`pid ${String(process.ppid)}`));
});

test('withFileLock: замок записи старше срока забирается и при чужом живом pid (после перезагрузки pid занят чужим процессом)', async () => {
  await using box = await sandbox();
  const file = path.join(box.root, 'shared.json');
  await writeFile(`${file}.write.lock`, JSON.stringify({ pid: process.ppid }));
  // Свежий замок живого соседа не крадётся.
  assert.throws(() => withFileLock(file, () => 'не должно', { timeoutMs: 300, staleMs: 60_000 }), new RegExp(`pid ${String(process.ppid)}`));
  // Тот же замок, но оставленный давно: тело `run` по контракту короткое, значит держатель не мог его держать столько.
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.write.lock`, old, old);
  assert.equal(withFileLock(file, () => 'забран', { timeoutMs: 300, staleMs: 30_000 }), 'забран');
  assert.equal(statSync(`${file}.write.lock`, { throwIfNoEntry: false }), undefined, 'замок после забора снят');
});

test('withFileLock: забор по сроку не снимает замок, который успел взять сосед (замок сменился, пока мы решали)', async () => {
  await using box = await sandbox();
  const file = path.join(box.root, 'shared.json');
  // Устаревший замок живого pid и охрана снятия, занятая живым соседом: забирать нельзя, пока он в охране.
  await writeFile(`${file}.write.lock`, JSON.stringify({ pid: process.ppid }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.write.lock`, old, old);
  await writeFile(`${file}.write.lock.reclaim`, JSON.stringify({ pid: process.ppid }));
  assert.throws(() => withFileLock(file, () => 'не должно', { timeoutMs: 200, staleMs: 30_000 }), /не дождались/);
});

test('writeJsonAtomic: права файла задаются при создании, а не после', async () => {
  await using box = await sandbox();
  const file = path.join(box.root, 'secrets.json');
  writeJsonAtomic(file, { a: 1 }, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
