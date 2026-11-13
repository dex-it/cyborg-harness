import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SpawnHost } from '@cyborg-harness/core';

// Пакет electron под Node отдаёт путь к бинарнику: хост идёт на рантайме Electron, где queueMicrotask теряет AsyncLocalStorage.
const electron = createRequire(import.meta.url)('electron') as string;
const hostEntry = fileURLToPath(import.meta.resolve('@cyborg-harness/core/host-entry'));

export const electronHosts: SpawnHost = (hostId) => {
  const child = fork(hostEntry, [hostId], {
    execPath: electron,
    // Флаги процесса тестов (--secure-heap и др.) Electron не принимает.
    execArgv: [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // Формат V8 у Node тестов и у Electron разных версий не читается друг другом; сообщениям теста хватает JSON.
    serialization: 'json',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  // Запись в канал уже умершего хоста приходит событием error (EPIPE); без слушателя оно роняет процесс теста. О гибели хоста скажет exit.
  child.on('error', () => undefined);
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
