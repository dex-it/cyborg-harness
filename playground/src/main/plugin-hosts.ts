import { utilityProcess } from 'electron';
import type { SpawnHost } from '../../../core/src/transports.ts';

export interface UtilityHosts {
  readonly spawn: SpawnHost;
  /** Процесс живого хоста: по нему окно роняет и вешает хост. */
  readonly pidOf: (hostId: string) => number | undefined;
}

/** Хост плагинов - utilityProcess: postMessage клонирует как structuredClone и бросает на функции, как ждёт Endpoint. */
export function utilityHosts(entry: string): UtilityHosts {
  const pids = new Map<string, number>();
  const spawn: SpawnHost = (hostId) => {
    const child = utilityProcess.fork(entry, [hostId], { serviceName: `Cyborg plugins: ${hostId}`, stdio: 'inherit' });
    let alive = true;
    child.once('spawn', () => {
      if (child.pid !== undefined) pids.set(hostId, child.pid);
    });
    child.once('exit', () => {
      alive = false;
      if (pids.get(hostId) === child.pid) pids.delete(hostId);
    });
    return {
      port: {
        post(message) {
          if (alive) child.postMessage(message);
        },
        onMessage: (listener) => void child.on('message', listener),
      },
      // SIGKILL, а не kill(): остановленный SIGSTOP процесс SIGTERM не получит, пока его не продолжат.
      kill() {
        if (!alive) return;
        if (child.pid === undefined) child.kill();
        else process.kill(child.pid, 'SIGKILL');
      },
      onExit: (listener) => void child.once('exit', listener),
    };
  };
  return { spawn, pidOf: (hostId) => pids.get(hostId) };
}
