import { utilityProcess } from 'electron';
import type { MessagePortMain } from 'electron';
import type { HostHandle, SpawnHost, SpawnPtyHost } from '@cyborg-harness/core';

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

export interface UtilityPtyHost {
  readonly spawn: SpawnPtyHost;
  /** Процесс живого pty-хоста: по нему smoke останавливает и роняет его. */
  readonly pid: () => number | undefined;
}

/** pty-хост ядра - utilityProcess с `node-pty` (K-01): не хост плагинов, код плагинов в нём не исполняется. Порты видов уходят ему переносом. */
export function utilityPtyHost(entry: string): UtilityPtyHost {
  let pid: number | undefined;
  const spawn = (): HostHandle => {
    const child = utilityProcess.fork(entry, [], { serviceName: 'Cyborg pty', stdio: 'inherit' });
    let alive = true;
    child.once('spawn', () => {
      pid = child.pid;
    });
    child.once('exit', () => {
      alive = false;
      if (pid === child.pid) pid = undefined;
    });
    return {
      port: {
        post(message, transfer) {
          if (alive) child.postMessage(message, transfer as MessagePortMain[] | undefined);
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
  return { spawn, pid: () => pid };
}
