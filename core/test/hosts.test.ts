import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { pluginStatuses } from '../src/status.ts';
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
  {
    id: 'busy',
    version: '1.0.0',
    engines: { cyborg: '^1' },
    commands: Object.fromEntries(
      ['timer', 'late', 'exit', 'focus', 'after', 'reject.timer', 'reject.focus', 'reject.await', 'throw.microtask', 'throw.tick', 'host.throw', 'host.reject', 'host.timer'].map((name) => [`busy.${name}`, name === 'reject.await' ? { args: ['number'] } : {}]),
    ),
  },
  { id: 'calm', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'calm.echo': { args: ['any'], callers: 'plugins' }, 'calm.pid': {} } },
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

const rejections = (k: Kernel) =>
  k.journal.filter((e): e is Extract<JournalEntry, { kind: 'unhandled-rejection' }> => e.kind === 'unhandled-rejection').map((e) => [e.pluginId, e.error]);

async function rejected(k: Kernel, run: () => Promise<unknown>): Promise<void> {
  const before = rejections(k).length;
  await run();
  for (let i = 0; i < 100 && rejections(k).length === before; i++) await sleep(20);
}

test('сторож: необработанное отклонение плагина - запись на него, хост и сосед живут', async () => {
  const k = await startShared(5);
  try {
    const pid = await k.run('calm.pid');
    await rejected(k, () => k.run('busy.reject.timer'));
    await rejected(k, async () => {
      await k.run('busy.reject.focus');
      k.emit({ kind: 'focus', focused: true });
    });
    await rejected(k, () => k.run('busy.reject.await', 0));
    assert.deepEqual(rejections(k), [
      ['busy', 'busy: таймер'],
      ['busy', 'busy: слушатель'],
      ['busy', 'busy: после await'],
    ]);
    assert.deepEqual(downs(k), []);
    assert.equal(await k.run('calm.pid'), pid);
    assert.deepEqual(k.active, ['busy', 'calm']);
    assert.equal(pluginStatuses(k.journal).find((s) => s.id === 'busy')?.state, 'active');
  } finally {
    await k.unload();
  }
});

test('сторож: отклонение после await вменяется начавшему цепочку, а не соседу, чей код шёл последним', async () => {
  const k = await startShared();
  try {
    await rejected(k, async () => {
      await k.run('busy.reject.await', 150);
      for (let i = 0; i < 5; i++) await k.run('calm.echo', i);
    });
    assert.deepEqual(rejections(k), [['busy', 'busy: после await']]);
  } finally {
    await k.unload();
  }
});

test('сторож: исключение в queueMicrotask и process.nextTick - хост падает, виновник назван', async () => {
  const k = await startShared();
  try {
    for (const command of ['busy.throw.microtask', 'busy.throw.tick']) {
      await k.run(command);
      await hostDown(k);
    }
    assert.deepEqual(downs(k), [
      ['shared', 'crash', ['busy'], []],
      ['shared', 'crash', ['busy'], []],
    ]);
    assert.deepEqual(k.active, ['busy', 'calm']);
  } finally {
    await k.unload();
  }
});

test('сторож: плагин, снятый по страйкам, остаётся в раскладке с меткой disabled, сосед без метки', async () => {
  const withView = shared.map((m) => ({ ...m, ui: { views: { main: './main.js' } } }));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['busy', 'calm'],
    manifests: withView,
    hosts: { shared: ['busy', 'calm'] },
    bundled: ['busy', 'calm'],
    spawnHost: forkHosts(),
    entry: (m) => new URL(`./fixtures/${m.id}.ts`, import.meta.url).href,
    watchdog: { interval: 50, timeout: 400, strikes: 3 },
  });
  try {
    const marks = () => Object.fromEntries(k.layout.map((e) => [e.pluginId, e.mark ?? 'ok']));
    assert.deepEqual(marks(), { busy: 'ok', calm: 'ok' });
    for (let i = 0; i < 3; i++) await rejected(k, () => k.run('busy.reject.timer'));
    await k.idle();
    assert.deepEqual(k.journal.filter((e) => e.kind === 'switched-off').map((e) => e.pluginId), ['busy'], 'снят сторожем, а не человеком');
    assert.deepEqual(marks(), { busy: 'disabled', calm: 'ok' });
  } finally {
    await k.unload();
  }
});

test('сторож: три отклонения подряд выключают только виновника - хост не падает и не бросается, сосед работает', async () => {
  const k = await startShared(3);
  try {
    const pid = await k.run('calm.pid');
    for (let i = 0; i < 3; i++) await rejected(k, () => k.run('busy.reject.timer'));
    await k.idle();
    const off = k.journal.filter((e) => e.kind === 'switched-off');
    assert.deepEqual(off.map((e) => [e.pluginId, e.strikes]), [['busy', 3]]);
    assert.equal(k.journal.some((e) => e.kind === 'host-abandoned'), false);
    assert.deepEqual(downs(k), []);
    assert.deepEqual(k.active, ['calm']);
    assert.equal(await k.run('calm.pid'), pid);
    const busy = pluginStatuses(k.journal).find((s) => s.id === 'busy');
    assert.deepEqual([busy?.state, busy?.cause?.kind, busy?.revivable], ['stopped', 'switched-off', true]);
  } finally {
    await k.unload();
  }
});

test('сторож: исключение, отклонение и таймер вне цепочки плагина - сбой кода хоста, виновника нет', async () => {
  const k = await startShared();
  try {
    for (const command of ['busy.host.throw', 'busy.host.reject', 'busy.host.timer']) {
      await k.run(command);
      await hostDown(k);
    }
    assert.deepEqual(downs(k), [
      ['shared', 'crash', [], []],
      ['shared', 'crash', [], []],
      ['shared', 'crash', [], []],
    ]);
    assert.deepEqual(rejections(k), []);
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

test('forkHosts: явный путь входа хоста берётся как есть - в cjs-бандле import.meta.url пуст и вывести путь нельзя', async () => {
  const missing = fileURLToPath(new URL('./fixtures/нет-такого-входа.js', import.meta.url));
  const host = forkHosts({ silent: true, entry: missing })('explicit');
  const code = await Promise.race([new Promise<number | null>((resolve) => host.onExit(resolve)), sleep(5000).then(() => 'жив' as const)]);
  host.kill();
  assert.notEqual(code, 'жив', 'хост запущен по выведенному пути, а не по заданному');
  assert.equal(code, 1);
});

test('forkHosts: заданный путь входа работает и используется, а не выведенный - вызов между процессами идёт через него', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-entry-'));
  const marker = join(dir, 'marker');
  // Обёртка отличается от выведенного пути и оставляет след, затем отдаёт управление настоящему входу: если entry игнорируется, следа нет.
  const wrapper = join(dir, 'wrapper-entry.mjs');
  const real = pathToFileURL(fileURLToPath(new URL('../src/host-entry.ts', import.meta.url))).href;
  writeFileSync(wrapper, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nawait import(${JSON.stringify(real)});\n`);
  const k = await start(3, forkHosts({ entry: wrapper }));
  try {
    assert.equal(await k.run('consumer.call', 'read', 'a.txt'), 'data:a.txt');
    assert.ok(existsSync(marker), 'хост запущен не через заданный путь входа');
  } finally {
    await k.unload();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forkHosts: запись в канал уже убитого хоста - не необработанное событие error процесса ядра (EPIPE), хост просто сообщает о выходе', async () => {
  const host = forkHosts({ silent: true })('epipe');
  const exit = new Promise<number | null>((resolve) => host.onExit(resolve));
  // Пока цикл событий занят, канал ещё `connected`, а собеседник уже мёртв: запись идёт в закрытый конец.
  host.kill();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  host.port.post({ t: 'note', m: 'system', p: null });
  host.port.post({ t: 'note', m: 'system', p: null });
  await exit;
  await sleep(100);
});
