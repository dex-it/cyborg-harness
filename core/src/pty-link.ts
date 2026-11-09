// Связь главного процесса с pty-хостом (K-01, ADR-CH-0012 п. 4): запуск процесса хоста, запросы к нему и сторож за ним.
// Сторож устроен как у хостов плагинов (SAD 3.5: пинг, порог, перезапуск), но не знает плагинов: pty-хост кода плагинов не исполняет.

import type { PtyExit } from '@cyborg-harness/contracts';
import { CoreError, errorMessage, ignore } from './errors.ts';
import { PtyHost, type PtyHostInit, type PtyHostOptions, type PtySpawnParams } from './pty-host.ts';
import type { PtyBackend } from './pty.ts';
import { Endpoint } from './rpc.ts';
import type { HostHandle } from './transports.ts';

/** Процесс pty-хоста глазами ядра; в Electron его даёт `utilityProcess`, в тестах - `inlinePtyHost`. */
export type SpawnPtyHost = () => HostHandle;

export interface PtyWatchdog {
  /** Как часто пинговать pty-хост, мс. */
  readonly interval: number;
  /** Сколько ждать ответа на пинг, мс; дольше - хост завис. */
  readonly timeout: number;
  /** Сколько падений подряд, после которых хост не поднимается сам до следующего `spawn`. */
  readonly strikes: number;
  /** Падение позже стольких мс после прошлого - уже не «подряд». */
  readonly window: number;
}

export interface PtyLinkEvents {
  data(key: string, data: string): void;
  exit(key: string, exit: PtyExit): void;
  viewClosed(viewId: string): void;
  /** Хост упал или завис и убит: его процессы потеряны. */
  lost(reason: 'hang' | 'crash'): void;
  /** Сторож поднял хост после падения. */
  restarted(): void;
  /** Хост падает снова и снова: сам не поднимается, пока кто-то не запросит `spawn`. */
  abandoned(failures: number): void;
}

interface Connection {
  readonly handle: HostHandle;
  readonly endpoint: Endpoint;
  readonly ready: Promise<unknown>;
  timer?: ReturnType<typeof setInterval>;
  pingAt?: number | undefined;
  down: boolean;
}

export interface PtyLinkOptions {
  readonly init: PtyHostInit;
  readonly events: PtyLinkEvents;
  readonly watchdog?: Partial<PtyWatchdog> | undefined;
}

/** Сколько ждать ответа на `endAll` (сигнал завершения всем pty), прежде чем убить хост: зависший хост выгрузку дольше не держит. */
const STOP_WAIT = 2000;

/** Хост запускается при первом запросе, а не при старте ядра: без pty лишнего процесса нет. */
export class PtyLink {
  readonly #spawnHost: SpawnPtyHost;
  readonly #options: PtyLinkOptions;
  readonly #watchdog: PtyWatchdog;
  #conn: Connection | undefined;
  #stopped = false;
  #failures: number[] = [];

  constructor(spawnHost: SpawnPtyHost, options: PtyLinkOptions) {
    this.#spawnHost = spawnHost;
    this.#options = options;
    this.#watchdog = { interval: 1000, timeout: 5000, strikes: 3, window: 10 * 60_000, ...options.watchdog };
  }

  /** Живой хост или `Unavailable`; после отказа от перезапуска явный запрос пробует снова. */
  async #connection(): Promise<Connection> {
    if (this.#stopped) throw new CoreError('Unavailable', 'pty-хост остановлен вместе с ядром');
    let conn = this.#conn;
    if (conn === undefined) {
      this.#failures = [];
      conn = this.#start();
    }
    try {
      await conn.ready;
    } catch (error) {
      throw new CoreError('Unavailable', `pty-хост не поднялся: ${errorMessage(error)}`);
    }
    return conn;
  }

  #start(): Connection {
    const handle = this.#spawnHost();
    const endpoint = new Endpoint(handle.port);
    const events = this.#options.events;
    endpoint.handle('data', (p: { key: string; data: string }) => events.data(p.key, p.data));
    endpoint.handle('exit', (p: { key: string; exit: PtyExit }) => events.exit(p.key, p.exit));
    endpoint.handle('viewClosed', (p: { viewId: string }) => events.viewClosed(p.viewId));
    const conn: Connection = { handle, endpoint, down: false, ready: endpoint.request('init', this.#options.init) };
    conn.ready.catch(ignore);
    this.#conn = conn;
    handle.onExit(() => this.#down(conn, 'crash'));
    conn.timer = setInterval(() => {
      if (conn.down) return;
      if (conn.pingAt !== undefined) {
        if (performance.now() - conn.pingAt > this.#watchdog.timeout) this.#down(conn, 'hang');
        return;
      }
      conn.pingAt = performance.now();
      endpoint.request('ping', null).then(() => void (conn.pingAt = undefined), ignore);
    }, this.#watchdog.interval);
    conn.timer.unref();
    return conn;
  }

  #down(conn: Connection, reason: 'hang' | 'crash'): void {
    if (conn.down) return;
    conn.down = true;
    clearInterval(conn.timer);
    // SIGKILL, а не просьба завершиться: остановленный SIGSTOP процесс просьбы не услышит.
    conn.handle.kill();
    conn.endpoint.close(new CoreError('HostGone', `pty-хост ${reason === 'hang' ? 'завис' : 'упал'}`));
    if (this.#conn === conn) this.#conn = undefined;
    if (this.#stopped) return;
    this.#options.events.lost(reason);
    const now = Date.now();
    this.#failures = [...this.#failures.filter((t) => now - t < this.#watchdog.window), now];
    if (this.#failures.length >= this.#watchdog.strikes) {
      this.#options.events.abandoned(this.#failures.length);
      return;
    }
    this.#start();
    this.#options.events.restarted();
  }

  async spawn(params: PtySpawnParams): Promise<number> {
    const conn = await this.#connection();
    return (await conn.endpoint.request<{ pid: number }>('spawn', params)).pid;
  }

  async attach(key: string): Promise<{ backlog: string; exit?: PtyExit }> {
    const conn = await this.#connection();
    return conn.endpoint.request('attach', { key });
  }

  /** Порт вида идёт переносом перед запросом: сообщения одного канала приходят в порядке отправки. */
  async view(key: string, viewId: string, port: unknown): Promise<string> {
    const conn = await this.#connection();
    conn.handle.port.post({ t: 'port', viewId }, [port]);
    return (await conn.endpoint.request<{ backlog: string }>('view', { key, viewId })).backlog;
  }

  /** Односторонние сообщения: хост мёртв - адресата уже нет, `PtyTable` знает о потере по `lost`. */
  note(method: 'write' | 'resize' | 'kill' | 'owner' | 'end' | 'closeView', params: unknown): void {
    const conn = this.#conn;
    if (conn && !conn.down) conn.endpoint.notify(method, params);
  }

  /** Выгрузка ядра: процессы pty завершаются, потом хост убит. */
  async stop(): Promise<void> {
    const conn = this.#conn;
    this.#stopped = true;
    if (!conn || conn.down) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      conn.endpoint.request('endAll', null).catch(ignore),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, STOP_WAIT);
      }),
    ]);
    clearTimeout(timeout);
    clearInterval(conn.timer);
    conn.down = true;
    conn.handle.kill();
    conn.endpoint.close(new CoreError('HostGone', 'ядро выгружено'));
    this.#conn = undefined;
  }
}

/** pty-хост в том же процессе: граница данных та же (structuredClone, порядок сообщений), изоляции сбоев нет - для тестов и замеров. */
export function inlinePtyHost(backend: PtyBackend, options: PtyHostOptions = {}): SpawnPtyHost {
  return () => {
    let alive = true;
    type Listener = (message: unknown, transfer?: readonly unknown[]) => void;
    const toHost = new Set<Listener>();
    const toKernel = new Set<Listener>();
    const exits = new Set<(code: number | null) => void>();
    const deliver = (listeners: Set<Listener>, message: unknown, transfer?: readonly unknown[]) => {
      const copy = structuredClone(message);
      setImmediate(() => {
        if (alive) for (const l of listeners) l(copy, transfer);
      });
    };
    const host = new PtyHost({ post: (m, t) => deliver(toKernel, m, t), onMessage: (l) => void toHost.add(l) }, backend, options);
    return {
      port: { post: (m, t) => deliver(toHost, m, t), onMessage: (l) => void toKernel.add(l) },
      kill() {
        if (!alive) return;
        alive = false;
        // Процесс хоста ушёл бы вместе со своими pty: сигнал хвостов не оставляет и здесь.
        host.dispose();
        for (const l of exits) l(null);
      },
      onExit: (l) => void exits.add(l),
    };
  };
}
