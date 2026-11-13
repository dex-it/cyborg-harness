import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CanaryReport } from './isolation.ts';

// TR-21 (ADR-CH-0019, п. 2): проверка эффективности запретов изнутри хоста. Ядро просит её до первой активации плагина: код плагина ещё не загружен, подменить результат нечем.
// Каждая проба - настоящее запрещённое действие, а не чтение флагов: `--permission` в `utilityProcess` принимается и не действует (опыт Б исследования доверия), и флаг в `execArgv`
// об этом не скажет. Отказ определяется по коду ошибки, любое другое исходило бы из причины, не связанной с запретом (нет файла, нет программы).

const attempt = (action: () => unknown): string => {
  try {
    action();
    return 'allowed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'error');
  }
};

/** Корень файловой системы, где лежит процесс: каталог вне всех разрешённых хосту (`--allow-fs-read` называет каталоги пакета, а не корень). */
const outside = (): string => path.parse(process.execPath).root;

function listens(open: (done: (ok: boolean) => void) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    open((ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/** Открывается ли сокет: TCP-сервер на loopback и UDP-сокет, оба сразу закрываются. Отказ ограничителя ОС (EPERM, EACCES) - сеть закрыта. */
export async function networkState(): Promise<'closed' | 'open'> {
  const tcp = await listens((done) => {
    try {
      const server = net.createServer();
      server.once('error', () => done(false));
      server.listen(0, '127.0.0.1', () => {
        server.close();
        done(true);
      });
    } catch {
      done(false);
    }
  });
  const udp = await listens((done) => {
    try {
      const socket = dgram.createSocket('udp4');
      socket.once('error', () => done(false));
      socket.bind(0, '127.0.0.1', () => {
        socket.close();
        done(true);
      });
    } catch {
      done(false);
    }
  });
  return tcp || udp ? 'open' : 'closed';
}

/** Пробы хоста под `--permission`: что отказано и что нет. Вызывается ядром командой `sandbox.canary`. */
export async function runCanary(): Promise<CanaryReport> {
  return {
    permission: typeof (process as { permission?: unknown }).permission === 'object',
    fsRead: attempt(() => fs.readdirSync(outside())),
    process: attempt(() => {
      const run = spawnSync(process.execPath, ['--version']);
      if (run.error) throw run.error;
    }),
    worker: attempt(() => {
      // Запрет бросает при создании; разрешённый поток тут же останавливается.
      void new Worker('0', { eval: true }).terminate();
    }),
    addon: attempt(() => process.dlopen({ exports: {} }, path.join(path.parse(process.execPath).root, 'cyborg-canary.node'))),
    network: await networkState(),
  };
}
