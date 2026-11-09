// Точка входа процесса pty-хоста (`utilityProcess` ядра, K-01): `node-pty` живёт здесь, а не в главном процессе.
// Права, владельцы и билеты остались в ядре главного процесса; здесь процессы pty, хвосты вывода и порты видов.
import type { MessagePortMain } from 'electron';
import * as nodePty from 'node-pty';
import { groupKilled, runPtyHost, type ViewPort } from '@cyborg-harness/core/pty-host';

const parent = process.parentPort;

/** Порт вида из главного процесса: `MessagePortMain` ждёт `start()`, пока на нём не повиснет слушатель. */
function adopt(raw: unknown): ViewPort {
  const port = raw as MessagePortMain;
  return {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', (event) => listener(event.data));
      port.start();
    },
    onClose: (listener) => {
      port.on('close', listener);
    },
    close: () => port.close(),
  };
}

runPtyHost(
  {
    post: (message) => parent.postMessage(message),
    onMessage: (listener) => {
      parent.on('message', (event) => listener(event.data, event.ports));
    },
  },
  { spawn: (file, args, options) => groupKilled(nodePty.spawn(file, args, options)) },
  { adopt },
);
