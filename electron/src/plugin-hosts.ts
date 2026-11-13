import { utilityProcess } from 'electron';
import type { MessagePortMain } from 'electron';
import type { HostHandle, HostIsolation, HostRequest, SpawnHost, SpawnPtyHost } from '@cyborg-harness/core';
import { hostEnv } from './host-env.ts';
import { pluginHosts, type IsolationSettings } from './node-hosts.ts';

export interface UtilityHosts {
  readonly spawn: SpawnHost;
  /** Процесс живого хоста: по нему окно роняет и вешает хост. */
  readonly pidOf: (hostId: string) => number | undefined;
}

/** Хост плагинов - utilityProcess: postMessage клонирует как structuredClone и бросает на функции, как ждёт Endpoint. Окружение хоста явное (`hostEnv`, TR-02), а не `process.env` главного процесса. */
export function utilityHosts(entry: string, isolation?: (request: HostRequest | undefined) => HostIsolation): UtilityHosts {
  const pids = new Map<string, number>();
  const spawn: SpawnHost = (hostId, request) => {
    const child = utilityProcess.fork(entry, [hostId], { serviceName: `Cyborg plugins: ${hostId}`, stdio: 'inherit', env: hostEnv() });
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
      // Заявление об изоляции (TR-24): utilityProcess запретов Node не знает, canary для него нет.
      ...(isolation !== undefined && { isolation: isolation(request) }),
    };
  };
  return { spawn, pidOf: (hostId) => pids.get(hostId) };
}

/**
 * Хосты плагинов по происхождению (TR-21, ADR-CH-0019): встроенные - общий `utilityProcess`, сторонний - свой процесс Node под запретами и ограничителем ОС, если они настроены
 * (`IsolationSettings`); без настроек все хосты - `utilityProcess`, как прежде, но каждый заявляет уровень изоляции для журнала.
 */
export function isolatedHosts(entry: string, settings: IsolationSettings = {}): UtilityHosts {
  return pluginHosts((isolation) => utilityHosts(entry, isolation), settings);
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
