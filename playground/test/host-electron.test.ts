import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { load, type JournalEntry } from '@cyborg-harness/core';
import type { SpawnHost } from '@cyborg-harness/core';

// Пакет electron под Node отдаёт путь к бинарнику: хост идёт на рантайме Electron, где queueMicrotask теряет AsyncLocalStorage.
const electron = createRequire(import.meta.url)('electron') as string;
const hostEntry = fileURLToPath(import.meta.resolve('@cyborg-harness/core/host-entry'));

const electronHosts: SpawnHost = (hostId) => {
  const child = fork(hostEntry, [hostId], {
    execPath: electron,
    // Флаги процесса тестов (--secure-heap и др.) Electron не принимает.
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // Формат V8 у Node тестов и у Electron разных версий не читается друг другом; сообщениям теста хватает JSON.
    serialization: 'json',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  return {
    port: {
      post(message) {
        if (child.connected) child.send(message as object);
      },
      onMessage: (listener) => void child.on('message', listener),
    },
    kill: () => void child.kill('SIGKILL'),
    onExit: (listener) => void child.on('exit', (code) => listener(code)),
  };
};

const fixture = (id: string) => new URL(`../../core/test/fixtures/${id}.ts`, import.meta.url).href;

test('хост на рантайме Electron: исключение в queueMicrotask вменяется плагину, отклонение хост держит', async () => {
  const k = await load({
    apiVersion: '1.0.0',
    enabled: ['busy', 'calm'],
    manifests: [
      {
        id: 'busy',
        version: '1.0.0',
        engines: { cyborg: '^1' },
        commands: Object.fromEntries(
          ['timer', 'late', 'exit', 'focus', 'after', 'reject.timer', 'reject.focus', 'reject.await', 'throw.microtask', 'throw.tick', 'host.throw', 'host.reject', 'host.timer'].map((name) => [`busy.${name}`, name === 'reject.await' ? { args: ['number'] } : {}]),
        ),
      },
      { id: 'calm', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'calm.echo': { args: ['any'] }, 'calm.pid': {} } },
    ],
    hosts: { shared: ['busy', 'calm'] },
    bundled: ['busy', 'calm'],
    spawnHost: electronHosts,
    entry: (m) => fixture(m.id),
    watchdog: { interval: 50, timeout: 2000, strikes: 3 },
  });
  try {
    const pid = await k.run('calm.pid');
    await k.run('busy.reject.timer');
    for (let i = 0; i < 100 && !k.journal.some((e) => e.kind === 'unhandled-rejection'); i++) await sleep(20);
    assert.equal(k.journal.find((e) => e.kind === 'unhandled-rejection')?.pluginId, 'busy');
    assert.equal(await k.run('calm.pid'), pid);

    await k.run('busy.throw.microtask');
    const downs = () => k.journal.filter((e): e is Extract<JournalEntry, { kind: 'host-down' }> => e.kind === 'host-down');
    for (let i = 0; i < 100 && downs().length === 0; i++) await sleep(20);
    await k.idle();
    assert.deepEqual(downs().map((d) => [d.reason, d.culprits]), [['crash', ['busy']]]);
  } finally {
    await k.unload();
  }
});
