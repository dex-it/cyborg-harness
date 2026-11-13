import { fork, spawn } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError, ignore } from './errors.ts';
import { runHost, type Importer } from './host-runtime.ts';
import type { HostIsolation } from './isolation.ts';
import type { Port } from './rpc.ts';
import { jsonPort, WIRE_JSON } from './wire-codec.ts';

/** Процесс хоста глазами ядра; в Electron его даст utilityProcess, здесь - Node. */
export interface HostHandle {
  readonly port: Port;
  /** Убивает без ожидания: зависший хост на просьбу завершиться не ответит. */
  kill(): void;
  onExit(listener: (code: number | null) => void): void;
  /**
   * Что запуск обещает об изоляции процесса (TR-21, TR-24): уровень, причина словами, проверка при старте. Без поля запуск об изоляции ничего не заявляет,
   * ядро ничего не проверяет и уровня не записывает.
   */
  readonly isolation?: HostIsolation;
  /** Идентификатор процесса хоста, если запуск его знает (окно роняет и вешает хост по нему; тесты проверяют, что хост убит). */
  readonly pid?: number;
}

/** Плагин, который будет жить в хосте. */
export interface HostPlugin {
  readonly id: string;
  /** Каталог плагина (где лежит его точка входа); запуск стороннего хоста разрешает чтение только его. Нет, если точка входа не `file:`. */
  readonly home?: string;
}

/**
 * Что ядро знает о хосте при его запуске (TR-21): кто в нём будет жить и из поставки ли он. Способ запуска выбирает адаптер по происхождению:
 * встроенные плагины - общий хост `utilityProcess`, сторонний - свой процесс Node под запретами. `thirdParty` - в хосте есть плагин не из `bundled`;
 * без `LoadOptions.bundled` поставку не от чего отличить и поле `false`.
 */
export interface HostRequest {
  readonly plugins: readonly HostPlugin[];
  readonly thirdParty: boolean;
}

export type SpawnHost = (hostId: string, request?: HostRequest) => HostHandle;

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
  /**
   * Обёртка запуска: ограничитель ОС (Seatbelt, Landlock и seccomp) оборачивает команду запуска процесса в свою (`sandbox-exec … node …`, `cyborg-confine … -- node …`).
   * Канал `ipc` и окружение процесс получает как обычно. С обёрткой процесс запускается через `spawn`, а не `fork`: `fork` приказывает ядру Node самому быть исполняемым файлом.
   */
  readonly wrap?: (command: HostCommand) => HostCommand;
  /** Рабочий каталог хоста. Ограничитель ОС читать позволяет только названное, поэтому каталог по умолчанию (унаследованный от ядра) там читать нельзя, а `process.cwd()` без чтения не работает. */
  readonly cwd?: string;
  /** Заявление об изоляции, которое хост-обработчик отдаёт ядру (`HostHandle.isolation`). Без него запуск ничего не заявляет. */
  readonly isolation?: HostIsolation;
}

/** Команда запуска процесса хоста: исполняемый файл и аргументы целиком (флаги Node, файл входа, id хоста). */
export interface HostCommand {
  readonly command: string;
  readonly args: readonly string[];
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
  const serialization = options.serialization ?? 'advanced';
  return (hostId) => {
    const stdio = options.silent ? 'ignore' : 'inherit';
    // Хост на `json` узнаёт об этом из аргумента: окружение пусто, а переменную канала Node снимает с процесса после подключения.
    const hostArgs = [hostId, ...(serialization === 'json' ? [WIRE_JSON] : [])];
    const stdioList: ['ignore' | 'inherit', 'ignore' | 'inherit', 'ignore' | 'inherit', 'ipc'] = [stdio, stdio, stdio, 'ipc'];
    const env = options.env === undefined ? undefined : { ...options.env };
    const child = options.wrap
      ? (() => {
          const { command, args } = options.wrap({ command: options.execPath ?? process.execPath, args: [...(options.execArgv ?? []), hostEntry, ...hostArgs] });
          return spawn(command, [...args], { serialization, stdio: stdioList, ...(env !== undefined && { env }), ...(options.cwd !== undefined && { cwd: options.cwd }) });
        })()
      : fork(hostEntry, hostArgs, {
          serialization,
          stdio: stdioList,
          ...(options.execPath !== undefined && { execPath: options.execPath }),
          ...(options.execArgv !== undefined && { execArgv: [...options.execArgv] }),
          ...(env !== undefined && { env }),
          ...(options.cwd !== undefined && { cwd: options.cwd }),
        });
    // Запись в канал хоста, который уже умер, а `connected` ещё держится, приходит событием error (EPIPE): без слушателя оно роняет процесс ядра. О гибели хоста скажет exit.
    child.on('error', ignore);
    const raw: Port = {
      post(message) {
        if (!child.connected) return;
        child.send(message as object);
      },
      onMessage: (listener) => void child.on('message', listener),
    };
    return {
      // `json` теряет типы structuredClone: кодек возвращает их и отвергает то, что structuredClone отвергает (ADR-CH-0019, п. 3).
      port: serialization === 'json' ? jsonPort(raw) : raw,
      kill: () => void child.kill('SIGKILL'),
      onExit: (listener) => void child.on('exit', (code) => listener(code)),
      ...(options.isolation !== undefined && { isolation: options.isolation }),
      ...(child.pid !== undefined && { pid: child.pid }),
    };
  };
}
