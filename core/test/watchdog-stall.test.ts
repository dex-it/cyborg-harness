import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { inlineHosts, type HostHandle, type SpawnHost } from '../src/transports.ts';
import { trackKernels } from './kernels.ts';
import { waitFor } from './wait-for.ts';

// #146: цикл событий ядра простоял дольше watchdog.timeout. Таймеры сторожа идут раньше фазы poll, где обрабатываются ответ на пинг и выход
// процесса хоста; молчание, совпавшее с простоем самого ядра, зависанием хоста не считается.

const track = trackKernels();
const TIMEOUT = 100;
const STALL = 400;

/** Цикл ядра занят `ms` мс: ни таймеры, ни сообщения, ни выход процесса не обрабатываются. */
function stall(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

interface Rig {
  readonly k: Kernel;
  /** Сколько пингов ушло хостам. */
  readonly pings: () => number;
}

/** Хост в процессе теста, чей первый пинг занимает цикл ядра на `STALL` мс; `during` - что случилось с хостом, пока цикл стоял. */
async function stalled(during?: (real: HostHandle) => void): Promise<Rig> {
  const base = inlineHosts(async () => ({ activate: () => undefined }));
  let pings = 0;
  const spawnHost: SpawnHost = (id) => {
    const real = base(id);
    return {
      ...real,
      port: {
        onMessage: (listener) => {
          real.port.onMessage(listener);
        },
        post(message, transfer) {
          const ping = typeof message === 'object' && message !== null && (message as { t?: unknown; m?: unknown }).t === 'req' && (message as { m?: unknown }).m === 'ping';
          real.port.post(message, transfer);
          if (ping && ++pings === 1) {
            during?.(real);
            stall(STALL);
          }
        },
      },
    };
  };
  const k = track(await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['a'],
    manifests: [{ id: 'a', version: '1.0.0', engines: { cyborg: '^1' } }],
    spawnHost,
    watchdog: { interval: 20, timeout: TIMEOUT, strikes: 3 },
  }));
  return { k, pings: () => pings };
}

const downs = (k: Kernel) => k.journal.filter((e): e is Extract<JournalEntry, { kind: 'host-down' }> => e.kind === 'host-down');

test('сторож: хост ответил на пинг, пока цикл ядра стоял дольше срока, - это не зависание', async () => {
  const { k, pings } = await stalled();
  await waitFor('следующий пинг после простоя цикла', () => pings() >= 2);
  assert.deepEqual(downs(k).map((d) => d.reason), []);
  assert.deepEqual(k.active, ['a']);
});

test('сторож: хост упал, пока цикл ядра стоял дольше срока, - в журнале crash, а не hang', async () => {
  // Выход процесса доходит до ядра на итерацию цикла позже первого таймера сторожа.
  const { k } = await stalled((real) => {
    setImmediate(() => setImmediate(() => real.kill()));
  });
  await waitFor('перезапуск хоста', () => k.journal.some((e) => e.kind === 'host-restart'));
  await k.idle();
  assert.deepEqual(downs(k).map((d) => d.reason), ['crash']);
});

test('ST-1003/3: сторож: хост, который молчит по-настоящему, по-прежнему записывается как hang', async () => {
  const base = inlineHosts(async () => ({ activate: () => undefined }));
  const spawnHost: SpawnHost = (id) => {
    const real = base(id);
    // Хост не отвечает на пинг.
    return {
      ...real,
      port: {
        onMessage: (listener) => {
          real.port.onMessage(listener);
        },
        post(message, transfer) {
          if ((message as { m?: unknown }).m !== 'ping') real.port.post(message, transfer);
        },
      },
    };
  };
  const k = track(await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['a'],
    manifests: [{ id: 'a', version: '1.0.0', engines: { cyborg: '^1' } }],
    spawnHost,
    watchdog: { interval: 20, timeout: TIMEOUT, strikes: 3 },
  }));
  await waitFor('hang в журнале', () => downs(k).length > 0);
  assert.equal(downs(k)[0]?.reason, 'hang');
});
