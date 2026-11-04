import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreError } from './errors.ts';
import { runHost, type Importer } from './host-runtime.ts';
import type { Port } from './rpc.ts';

/** Процесс хоста глазами ядра; в Electron его даст utilityProcess, здесь - Node. */
export interface HostHandle {
  readonly port: Port;
  /** Убивает без ожидания: зависший хост на просьбу завершиться не ответит. */
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
}

export type SpawnHost = (hostId: string) => HostHandle;

/** Хост в том же процессе: граница данных та же, изоляции сбоев нет - для тестов и разработки. */
export function inlineHosts(importer: Importer): SpawnHost {
  return () => {
    let alive = true;
    const toHost = new Set<(m: unknown) => void>();
    const toKernel = new Set<(m: unknown) => void>();
    const exits = new Set<(code: number | null) => void>();
    const deliver = (listeners: Set<(m: unknown) => void>, message: unknown) => {
      const copy = structuredClone(message);
      setImmediate(() => {
        if (alive) for (const l of listeners) l(copy);
      });
    };
    const host = runHost({ post: (m) => deliver(toKernel, m), onMessage: (l) => void toHost.add(l) }, importer);
    return {
      port: { post: (m) => deliver(toHost, m), onMessage: (l) => void toKernel.add(l) },
      kill() {
        if (!alive) return;
        alive = false;
        host.close(new CoreError('HostGone', 'хост остановлен'));
        for (const l of exits) l(null);
      },
      onExit: (l) => void exits.add(l),
    };
  };
}

/** Хост - дочерний процесс Node; advanced-сериализация повторяет structuredClone, как у utilityProcess. */
export function forkHosts(options: { silent?: boolean } = {}): SpawnHost {
  // Не на верхнем уровне: в cjs-бандле главного процесса Electron import.meta.url пуст.
  const hostEntry = fileURLToPath(new URL('./host-entry.ts', import.meta.url));
  return (hostId) => {
    const stdio = options.silent ? 'ignore' : 'inherit';
    const child = fork(hostEntry, [hostId], { serialization: 'advanced', stdio: [stdio, stdio, stdio, 'ipc'] });
    return {
      port: {
        post(message) {
          if (!child.connected) return;
          child.send(message as object);
        },
        onMessage: (listener) => void child.on('message', listener),
      },
      kill: () => void child.kill('SIGKILL'),
      onExit: (listener) => void child.on('exit', (code) => listener(code)),
    };
  };
}
