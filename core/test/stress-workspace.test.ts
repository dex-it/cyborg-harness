import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { RecentWorkspaces } from '../src/recent.ts';
import { openWorkspace, readJson } from '../src/workspace.ts';
import { waitFor } from './wait-for.ts';

async function scratch(): Promise<{ dir: string; file: string; userFile: string; stateDir: string } & AsyncDisposable> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cyborg-stress-ws-'));
  return {
    dir,
    file: path.join(dir, 'ws.json'),
    userFile: path.join(dir, 'user', 'user.json'),
    stateDir: path.join(dir, 'state'),
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
}

const openIn = async (s: { file: string; userFile: string; stateDir: string }) => {
  const r = await openWorkspace({ file: s.file, userFile: s.userFile, stateDir: s.stateDir });
  assert.ok(r.ok);
  return r.workspace;
};

test('stress-workspace: замок воркспейса при одновременном старте нескольких экземпляров берёт ровно один', async () => {
  // SAD 3.1: один экземпляр - один воркспейс. Участники - потоки с чужими живыми pid, чтобы замок соседа не считался умершим.
  const holders = Array.from({ length: 3 }, () => spawn('sleep', ['30'], { stdio: 'ignore' }));
  await using s = await scratch();
  try {
    const rounds = 300;
    const shared = new SharedArrayBuffer(8);
    const runs = holders.map(
      (h) =>
        new Promise<number[]>((resolve, reject) => {
          const w = new Worker(new URL('./fixtures/lock-worker.ts', import.meta.url), { workerData: { shared, pid: h.pid, workers: holders.length, rounds, dir: s.dir } });
          w.once('message', resolve);
          w.once('error', reject);
        }),
    );
    const won = await Promise.all(runs);
    const doubled: number[] = [];
    for (let r = 0; r < rounds; r++) if (won.reduce((sum, w) => sum + (w[r] ?? 0), 0) > 1) doubled.push(r);
    assert.deepEqual(doubled, [], `раундов, где замок взяли двое и больше: ${String(doubled.length)} из ${String(rounds)}`);
  } finally {
    for (const h of holders) h.kill('SIGKILL');
  }
});

test('stress-workspace: одновременная запись разных разделов state не теряет ни один', async () => {
  await using s = await scratch();
  const ws = await openIn(s);
  try {
    await Promise.all([ws.state.write('workspace', 'alpha', 1, { n: 1 }), ws.state.write('workspace', 'beta', 1, { n: 2 }), ws.state.write('workspace', 'gamma', 1, { n: 3 })]);
    const onDisk = readJson(ws.stateFile);
    assert.deepEqual(Object.keys(onDisk ?? {}).sort(), ['alpha', 'beta', 'gamma'], 'на диске');
    const inMemory = ws.state.raw('beta')[0]?.[1];
    assert.deepEqual(inMemory, { $version: 1, n: 2 }, 'в памяти ядра');
  } finally {
    ws.close();
  }
});

test('stress-workspace: одновременная запись разных разделов config одного слоя не теряет ни один', async () => {
  await using s = await scratch();
  const ws = await openIn(s);
  try {
    await Promise.all([ws.config.write('workspace', 'alpha', 1, { n: 1 }), ws.config.write('workspace', 'beta', 1, { n: 2 })]);
    const settings = readJson(s.file)?.settings as Record<string, unknown>;
    assert.deepEqual(Object.keys(settings).sort(), ['alpha', 'beta']);
  } finally {
    ws.close();
  }
});

test('stress-workspace: битый файл state попадает в problems и запись в него отменяется, а не затирает его', async () => {
  await using s = await scratch();
  fs.mkdirSync(s.stateDir, { recursive: true });
  const ws0 = await openIn(s);
  const stateFile = ws0.stateFile;
  ws0.close();
  const garbage = '{"$documents": {"list": [ ';
  fs.writeFileSync(stateFile, garbage);
  const ws = await openIn(s);
  try {
    assert.equal(ws.problems.filter((p) => p.startsWith(stateFile)).length, 1, 'битый state назван в problems');
    // SAD 3.1: файл, который не разобрался, не перезаписывается (правка человека не затирается).
    await assert.rejects(ws.state.write('workspace', 'alpha', 1, { n: 1 }));
    assert.equal(fs.readFileSync(stateFile, 'utf8'), garbage);
  } finally {
    ws.close();
  }
});

test('stress-workspace: новый воркспейс за симлинком - state, записанный при первом открытии, виден при следующем', async () => {
  await using s = await scratch();
  const real = path.join(s.dir, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(s.dir, 'link'));
  const via = { ...s, file: path.join(s.dir, 'link', 'ws.json') };
  const first = await openIn(via);
  await first.state.write('workspace', 'alpha', 1, { n: 1 });
  const key = first.stateFile;
  first.close();
  const second = await openIn(via);
  try {
    assert.equal(second.stateFile, key, 'ключ воркспейса сменился, когда файл появился');
    assert.deepEqual(second.state.raw('alpha'), [['workspace', { $version: 1, n: 1 }]]);
  } finally {
    second.close();
  }
});

test('stress-workspace: правка файла воркспейса извне не стирается записью другого раздела до того, как слежение её подхватило', async () => {
  await using s = await scratch();
  const ws = await openIn(s);
  const seen: (readonly string[])[] = [];
  const sub = ws.watch((ids) => void seen.push(ids));
  try {
    const doc = readJson(s.file) ?? {};
    fs.writeFileSync(s.file, JSON.stringify({ ...doc, settings: { edited: { by: 'human' } } }));
    await ws.config.write('workspace', 'other', 1, { k: 1 });
    await waitFor('слежение сообщило о правке', () => seen.some((ids) => ids.includes('edited')));
    const settings = readJson(s.file)?.settings as Record<string, unknown>;
    assert.deepEqual(settings.edited, { by: 'human' }, 'правка человека осталась в файле');
    assert.ok(settings.other, 'запись плагина тоже на месте');
  } finally {
    sub.dispose();
    ws.close();
  }
});

test('stress-workspace: 150 циклов open/watch/close не оставляют замков, слежений и таймеров', async () => {
  await using s = await scratch();
  const count = (name: string) => process.getActiveResourcesInfo().filter((n) => n === name).length;
  await sleep(20);
  const before = { fs: count('FSEventWrap'), timers: count('Timeout') };
  for (let i = 0; i < 150; i++) {
    const ws = await openIn(s);
    const sub = ws.watch(() => undefined);
    await ws.config.write('workspace', 'p', 1, { i });
    sub.dispose();
    ws.close();
  }
  await waitFor('слежения и таймеры погашены', () => count('FSEventWrap') === before.fs && count('Timeout') <= before.timers);
  assert.equal(fs.existsSync(`${s.file}.lock`), false);
  const ws = await openIn(s);
  assert.deepEqual(ws.config.raw('p')[1]?.[1], { $version: 1, i: 149 });
  ws.close();
});

test('stress-workspace: «Недавние» - 1000 операций, не больше 10 записей, без повторов, битый файл не мешает', async () => {
  await using s = await scratch();
  const list = path.join(s.dir, 'recent.json');
  const recent = new RecentWorkspaces(list);
  const files: string[] = [];
  for (let i = 0; i < 40; i++) {
    const f = path.join(s.dir, `w${String(i)}.json`);
    fs.writeFileSync(f, '{}');
    files.push(f);
  }
  for (let i = 0; i < 1000; i++) {
    const f = files[(i * 7) % files.length]!;
    if (i % 5 === 4) recent.remove(f);
    else recent.add(f);
  }
  const got = recent.list();
  assert.ok(got.length <= 10);
  assert.equal(new Set(got).size, got.length);
  fs.writeFileSync(list, '{"recent": [');
  assert.deepEqual(recent.list(), []);
  recent.add(files[0]!);
  assert.deepEqual(recent.list(), [fs.realpathSync(files[0]!)]);
});
