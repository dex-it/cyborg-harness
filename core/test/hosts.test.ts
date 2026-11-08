import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { isRecord } from '../src/wire.ts';
import { forkHosts, type SpawnHost } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

const manifests = [
  { id: 'files', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'test.files': '1.0' } },
  { id: 'consumer', version: '1.0.0', engines: { cyborg: '^1' }, optional: { 'test.files': '^1' }, commands: { 'consumer.call': { args: ['string'], rest: 'any' }, 'consumer.state': {} } },
];

function start(strikes = 3, spawnHost: SpawnHost = forkHosts()): Promise<Kernel> {
  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['files', 'consumer'],
    manifests,
    hosts: { storage: ['files'], ui: ['consumer'] },
    spawnHost,
    entry: (m) => new URL(`./fixtures/${m.id}.ts`, import.meta.url).href,
    watchdog: { interval: 50, timeout: 400, strikes },
  });
}

interface State { changes: number; files: boolean; pid: number }
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

// Два плагина из поставки в одном хосте: busy виснет вне вызова ядра, calm - невиновный сосед.
const shared = [
  { id: 'busy', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'busy.timer': {}, 'busy.late': {}, 'busy.exit': {}, 'busy.focus': {}, 'busy.after': {} } },
  { id: 'calm', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'calm.echo': { args: ['any'] }, 'calm.pid': {} } },
];

function startShared(strikes = 3, spawnHost: SpawnHost = forkHosts()): Promise<Kernel> {
  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['busy', 'calm'],
    manifests: shared,
    hosts: { shared: ['busy', 'calm'] },
    bundled: ['busy', 'calm'],
    spawnHost,
    entry: (m) => new URL(`./fixtures/${m.id}.ts`, import.meta.url).href,
    watchdog: { interval: 50, timeout: 400, strikes },
  });
}

async function hostDown(k: Kernel): Promise<void> {
  const before = downs(k).length;
  for (let i = 0; i < 100 && downs(k).length === before; i++) await sleep(20);
  await k.idle();
}

test('сторож: завис таймер плагина - страйк ему, а не соседу, чей вызов хост принял и не успел выполнить', async () => {
  const k = await startShared();
  try {
    await k.run('busy.timer');
    await sleep(100);
    await assert.rejects(k.run('calm.echo', 1), { code: 'HostGone' });
    await k.idle();
    assert.deepEqual(downs(k), [['shared', 'hang', ['busy'], []]]);
  } finally {
    await k.unload();
  }
});

test('сторож: завис слушатель события окна - страйк его плагину', async () => {
  const k = await startShared();
  try {
    await k.run('busy.focus');
    k.emit({ kind: 'focus', focused: true });
    await hostDown(k);
    assert.deepEqual(downs(k).map((d) => d[2]), [['busy']]);
  } finally {
    await k.unload();
  }
});

test('сторож: продолжение после ответа ядра идёт от имени того, кто спросил, а не того, чей код шёл последним', async () => {
  const k = await startShared();
  try {
    await k.run('busy.after');
    await hostDown(k);
    assert.deepEqual(downs(k).map((d) => d[2]), [['busy']]);
  } finally {
    await k.unload();
  }
});

test('сторож: зависание без вызовов в полёте - страйк виновнику, хост не бросается целиком', async () => {
  const k = await startShared(2);
  try {
    for (let i = 0; i < 2; i++) {
      await k.run('busy.timer');
      await hostDown(k);
    }
    assert.deepEqual(downs(k).map((d) => d[2]), [['busy'], ['busy']]);
    assert.equal(k.journal.find((e) => e.kind === 'switched-off')?.pluginId, 'busy');
    assert.equal(k.journal.some((e) => e.kind === 'host-abandoned'), false);
    assert.deepEqual(k.active, ['calm']);
    assert.equal(await k.run('calm.echo', 2), 2);
  } finally {
    await k.unload();
  }
});

test('сторож: процесс упал в таймере плагина - страйк ему', async () => {
  const k = await startShared();
  try {
    await k.run('busy.exit');
    await hostDown(k);
    assert.deepEqual(downs(k), [['shared', 'crash', ['busy'], []]]);
  } finally {
    await k.unload();
  }
});

test('сторож: процесс хоста убит снаружи - сбой не вменяется плагину, чей код шёл последним', async () => {
  const k = await startShared();
  try {
    process.kill((await k.run('calm.pid')) as number, 'SIGKILL');
    await hostDown(k);
    assert.deepEqual(downs(k), [['shared', 'crash', [], []]]);
  } finally {
    await k.unload();
  }
});

test('сторож: хост не назвал, чей код шёл, - виновник по прежнему правилу, первый принятый вызов', async () => {
  const fork = forkHosts();
  const silent: SpawnHost = (id) => {
    const handle = fork(id);
    return { ...handle, port: { post: (m) => handle.port.post(m), onMessage: (l) => handle.port.onMessage((m) => isRecord(m) && m.m === 'running' ? undefined : l(m)) } };
  };
  const k = await start(3, silent);
  try {
    await assert.rejects(k.run('consumer.call', 'hang'), { code: 'HostGone' });
    await k.idle();
    assert.deepEqual(downs(k), [['storage', 'hang', ['files'], ['consumer']]]);
  } finally {
    await k.unload();
  }
});

test('сторож: ответ на пинг и следующее за ним уведомление о коде пришли одной порцией - отметка не стирается', async () => {
  const fork = forkHosts();
  // Ответ на пинг задерживается и выходит вместе с первым уведомлением о коде: так бывает, когда ядро занято и читает сообщения пачкой.
  const batched: SpawnHost = (id) => {
    const handle = fork(id);
    const pings = new Set<unknown>();
    let held: unknown;
    return {
      ...handle,
      port: {
        post: (m) => {
          if (isRecord(m) && m.t === 'req' && m.m === 'ping') pings.add(m.id);
          handle.port.post(m);
        },
        onMessage: (listener) =>
          handle.port.onMessage((m) => {
            if (isRecord(m) && m.t === 'res' && pings.has(m.id)) {
              held = m;
              return;
            }
            if (held !== undefined && isRecord(m) && m.t === 'note' && m.m === 'running') {
              const pong = held;
              held = undefined;
              listener(pong);
            }
            listener(m);
          }),
      },
    };
  };
  const k = await startShared(3, batched);
  try {
    await k.run('busy.late');
    await hostDown(k);
    assert.deepEqual(downs(k), [['shared', 'hang', ['busy'], []]]);
  } finally {
    await k.unload();
  }
});
