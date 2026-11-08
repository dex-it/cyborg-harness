import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimInstance, instanceAddress } from '../src/instance.ts';

// K-20: по экземпляру на воркспейс. Второй запуск того же воркспейса просит первого поднять окно и уходит; разные воркспейсы не мешают друг другу.

const claimer = fileURLToPath(new URL('./fixtures/instance-claimer.ts', import.meta.url));
const posix = process.platform !== 'win32';

async function sandbox() {
  // Короткий путь: адрес сокета unix ограничен ~104 байтами.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ci-')));
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) };
}

const key = 'a1b2c3d4e5f60718';

test('второй запуск того же воркспейса: владелец получает данные раньше, чем второй узнаёт об этом, второй уходит', async () => {
  await using box = await sandbox();
  const asked: unknown[] = [];
  const first = await claimInstance(key, { safeMode: false }, (data) => asked.push(data), { dir: box.dir });
  assert.equal(first.kind, 'owner');
  const second = await claimInstance(key, { safeMode: true }, () => assert.fail('второй стал владельцем'), { dir: box.dir });
  assert.equal(second.kind, 'handed');
  assert.deepEqual(asked, [{ safeMode: true }]);
  first.close();
});

test('разные воркспейсы - независимые владельцы', async () => {
  await using box = await sandbox();
  const a = await claimInstance('aaaaaaaaaaaaaaaa', {}, () => undefined, { dir: box.dir });
  const b = await claimInstance('bbbbbbbbbbbbbbbb', {}, () => undefined, { dir: box.dir });
  assert.deepEqual([a.kind, b.kind], ['owner', 'owner']);
  for (const c of [a, b]) if (c.kind === 'owner') c.close();
});

test('close отдаёт воркспейс: адрес свободен, следующий запуск - владелец', async () => {
  await using box = await sandbox();
  const first = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.ok(first.kind === 'owner');
  first.close();
  if (posix) assert.equal(existsSync(instanceAddress(key, box.dir)), false, 'файл сокета остался');
  const again = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.equal(again.kind, 'owner');
  again.close();
});

test('сбой обработчика владельца не оставляет второго без ответа', async () => {
  await using box = await sandbox();
  const first = await claimInstance(key, {}, () => { throw new Error('окна нет'); }, { dir: box.dir });
  const second = await claimInstance(key, {}, () => undefined, { dir: box.dir });
  assert.equal(second.kind, 'handed');
  if (first.kind === 'owner') first.close();
});

test('владелец жив, но молчит: второй не становится владельцем, а сообщает об этом в срок', async () => {
  await using box = await sandbox();
  const mute = net.createServer(() => undefined);
  await new Promise<void>((resolve) => mute.listen(instanceAddress(key, box.dir), resolve));
  const started = Date.now();
  const claim = await claimInstance(key, {}, () => undefined, { dir: box.dir, askTimeoutMs: 200 });
  mute.close();
  assert.equal(claim.kind, 'unresponsive');
  assert.ok(Date.now() - started < 3000);
});

test('адрес не перепутан между воркспейсами и каталог закрыт для других пользователей', { skip: !posix }, async () => {
  await using box = await sandbox();
  const sub = path.join(box.dir, 'run');
  const first = await claimInstance(key, {}, () => undefined, { dir: sub });
  assert.equal(statSync(sub).mode & 0o777, 0o700);
  assert.notEqual(instanceAddress(key, sub), instanceAddress('ffffffffffffffff', sub));
  if (first.kind === 'owner') first.close();
});

const start = (dir: string, label: string) => {
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', claimer, dir, key, label], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return { child, lines, exited };
};

const until = async (what: string, probe: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('шесть процессов стартуют разом: владелец один, остальные его просили', async () => {
  await using box = await sandbox();
  const procs = Array.from({ length: 6 }, (_, i) => start(box.dir, `p${String(i)}`));
  await until('все определились', () => procs.every((p) => p.lines.some((l) => l === 'owner' || l === 'handed' || l === 'unresponsive')));
  const kinds = procs.map((p) => p.lines.find((l) => l === 'owner' || l === 'handed' || l === 'unresponsive'));
  assert.deepEqual(kinds.filter((k) => k === 'owner').length, 1, `владельцев не один: ${kinds.join(',')}`);
  assert.deepEqual(kinds.filter((k) => k === 'handed').length, 5, `остальные не передали запрос: ${kinds.join(',')}`);
  const owner = procs[kinds.indexOf('owner')];
  assert.ok(owner);
  await until('владелец получил пять запросов', () => owner.lines.filter((l) => l.startsWith('asked ')).length === 5);
  owner.child.stdin.end();
  await Promise.all(procs.map((p) => p.exited));
});

test('сокет остался от убитого процесса: из шести стартующих владелец один, чужой живой сокет никто не удаляет', { skip: !posix }, async () => {
  await using box = await sandbox();
  const dead = start(box.dir, 'dead');
  await until('первый владелец', () => dead.lines.includes('owner'));
  dead.child.kill('SIGKILL');
  await dead.exited;
  assert.ok(existsSync(instanceAddress(key, box.dir)), 'нет устаревшего сокета для проверки');
  const procs = Array.from({ length: 6 }, (_, i) => start(box.dir, `p${String(i)}`));
  await until('все определились', () => procs.every((p) => p.lines.some((l) => l === 'owner' || l === 'handed' || l === 'unresponsive')));
  const kinds = procs.map((p) => p.lines.find((l) => l === 'owner' || l === 'handed' || l === 'unresponsive'));
  assert.deepEqual(kinds.filter((k) => k === 'owner').length, 1, `владельцев не один: ${kinds.join(',')}`);
  assert.deepEqual(kinds.filter((k) => k === 'handed').length, 5, `остальные не передали запрос: ${kinds.join(',')}`);
  procs[kinds.indexOf('owner')]?.child.stdin.end();
  await Promise.all(procs.map((p) => p.exited));
});
