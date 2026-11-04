import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { forkHosts } from '../src/transports.ts';

const manifests = [
  { id: 'files', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.files': '1.0' } },
  { id: 'consumer', version: '1.0.0', engines: { cyborg: '^1' }, optional: { 'cyborg.files': '^1' }, commands: ['consumer.call', 'consumer.state'] },
];

function start(strikes = 3): Promise<Kernel> {
  return load({
    apiVersion: '1.0.0',
    enabled: ['files', 'consumer'],
    manifests,
    hosts: { storage: ['files'], ui: ['consumer'] },
    spawnHost: forkHosts(),
    entry: (m) => new URL(`./fixtures/${m.id}.ts`, import.meta.url).href,
    watchdog: { interval: 50, timeout: 400, strikes },
  });
}

type State = { changes: number; files: boolean; pid: number };
const state = (k: Kernel) => k.run('consumer.state') as Promise<State>;
const downs = (k: Kernel) =>
  k.journal.filter((e): e is Extract<JournalEntry, { kind: 'host-down' }> => e.kind === 'host-down').map((d) => [d.hostId, d.reason, d.culprits, d.affects]);

test('вызов между процессами: данные, исключение и функция в результате', async () => {
  const k = await start();
  try {
    assert.equal(await k.run('consumer.call', 'read', 'a.txt'), 'data:a.txt');
    await assert.rejects(k.run('consumer.call', 'fail'), { code: 'Remote', message: 'нет файла' });
    await assert.rejects(k.run('consumer.call', 'leak'), { code: 'NotCloneable' });
    assert.notEqual((await state(k)).pid, process.pid);
  } finally {
    await k.unload();
  }
});

test('зависание: сторож убивает хост, виновник назван, соседний хост жив, поставщик возвращается', async () => {
  const k = await start();
  try {
    const before = await state(k);
    await assert.rejects(k.run('consumer.call', 'hang'), { code: 'HostGone' });
    await k.idle();
    assert.deepEqual(downs(k), [['storage', 'hang', ['files'], ['consumer']]]);
    assert.equal(await k.run('consumer.call', 'read', 'b'), 'data:b');
    const after = await state(k);
    assert.equal(after.pid, before.pid);
    assert.equal(after.changes - before.changes, 2);
  } finally {
    await k.unload();
  }
});

test('падение процесса идёт тем же путём, что и зависание', async () => {
  const k = await start();
  try {
    await assert.rejects(k.run('consumer.call', 'crash'), { code: 'HostGone' });
    await k.idle();
    assert.deepEqual(downs(k), [['storage', 'crash', ['files'], ['consumer']]]);
    assert.deepEqual(k.active.toSorted(), ['consumer', 'files']);
  } finally {
    await k.unload();
  }
});

test('после N сбоев виновник выключается, потребитель видит пропажу', async () => {
  const k = await start(2);
  try {
    await assert.rejects(k.run('consumer.call', 'hang'), { code: 'HostGone' });
    await k.idle();
    await assert.rejects(k.run('consumer.call', 'hang'), { code: 'HostGone' });
    await k.idle();
    const off = k.journal.find((e) => e.kind === 'switched-off');
    assert.deepEqual(off && [off.pluginId, off.affects], ['files', ['consumer']]);
    assert.deepEqual(k.active, ['consumer']);
    assert.equal((await state(k)).files, false);
    await assert.rejects(k.run('consumer.call', 'read', 'x'), { message: 'files нет' });
  } finally {
    await k.unload();
  }
});
