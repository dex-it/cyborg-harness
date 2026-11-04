import { utilityProcess } from 'electron';
import type { SpawnHost } from '../../../core/src/transports.ts';

/** Хост плагинов - utilityProcess: postMessage клонирует как structuredClone и бросает на функции, как ждёт Endpoint. */
export function utilityHosts(entry: string): SpawnHost {
  return (hostId) => {
    const child = utilityProcess.fork(entry, [hostId], { serviceName: `Cyborg plugins: ${hostId}`, stdio: 'inherit' });
    let alive = true;
    child.once('exit', () => (alive = false));
    return {
      port: {
        post(message) {
          if (alive) child.postMessage(message);
        },
        onMessage: (listener) => void child.on('message', listener),
      },
      kill: () => void child.kill(),
      onExit: (listener) => void child.once('exit', listener),
    };
  };
}
