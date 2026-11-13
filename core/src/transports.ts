import { fork } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError, ignore } from './errors.ts';
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

/** Как запускать процесс хоста: чем, с какими флагами и окружением. Без полей хост наследует окружение и флаги ядра, как раньше. */
export interface ForkHostOptions {
  readonly silent?: boolean;
  /** Путь к `host-entry` ядра (`@cyborg-harness/core/host-entry`); без него выводится из `import.meta.url`. */
  readonly entry?: string;
  /** Исполняемый файл Node: отдельный бинарник Node или бинарник Electron в режиме Node (тогда в `env` нужен `ELECTRON_RUN_AS_NODE=1`). По умолчанию - Node ядра. */
  readonly execPath?: string;
  /** Флаги Node хоста: `--permission`, `--allow-fs-read=<каталог>`. Не заданы - флаги ядра не наследуются, `fork` берёт `process.execArgv`. */
  readonly execArgv?: readonly string[];
  /** Окружение хоста целиком: `{}` - пустое. Не задано - окружение ядра. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Сериализация канала: по умолчанию `advanced` (structuredClone, как у utilityProcess). Процесс Node с другой версией V8, чем у ядра, `advanced` не читает: бинарник Electron 45 несёт V8 15.6,
   * стандартный Node 24 - V8 13.6, и хост на таком Node выходит с кодом 1 на первом сообщении. `json` с ним работает, но теряет Map, Set, Date, BigInt и типизированные массивы (docs/05-verification/spike-node-host.md).
   */
  readonly serialization?: 'advanced' | 'json';
}

/**
 * Хост - дочерний процесс Node; advanced-сериализация повторяет structuredClone, как у utilityProcess.
 * `entry` - путь к `host-entry` ядра (`@cyborg-harness/core/host-entry`). Без него путь выводится из `import.meta.url`
 * с тем же расширением, что у этого модуля: `.ts` из исходников, `.js` из собранного пакета.
 * `execArgv` и `env` дают хосту стороннего плагина запреты Node (`--permission`) и пустое окружение (TR-20, исследование доверия 5.3);
 * `execPath` выбирает процесс Node: отдельный бинарник или Electron в режиме Node.
 */
export function forkHosts(options: ForkHostOptions = {}): SpawnHost {
  // Не на верхнем уровне: в cjs-бандле главного процесса Electron import.meta.url пуст - там путь задаёт приложение.
  const hostEntry = options.entry ?? fileURLToPath(new URL(`./host-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url));
  return (hostId) => {
    const stdio = options.silent ? 'ignore' : 'inherit';
    const child = fork(hostEntry, [hostId], {
      serialization: options.serialization ?? 'advanced',
      stdio: [stdio, stdio, stdio, 'ipc'],
      ...(options.execPath !== undefined && { execPath: options.execPath }),
      ...(options.execArgv !== undefined && { execArgv: [...options.execArgv] }),
      ...(options.env !== undefined && { env: { ...options.env } }),
    });
    // Запись в канал хоста, который уже умер, а `connected` ещё держится, приходит событием error (EPIPE): без слушателя оно роняет процесс ядра. О гибели хоста скажет exit.
    child.on('error', ignore);
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
