// Сторона pty-хоста (K-01, ADR-CH-0012 п. 4-5): процессы pty, их кольцевые хвосты, склейка вывода и зрители-порты.
// Код исполняется в отдельном процессе ядра (в Electron - utilityProcess) поверх любого порта сообщений; права, владельцы и билеты остались в главном процессе (`PtyTable`).

import type { PtyExit } from '@cyborg-harness/contracts';
import type { MessagePort } from 'node:worker_threads';
import { CoreError, errorMessage } from './errors.ts';
import { LIMITS } from './limits.ts';
import { InputBudget, inputBytes } from './pty-budget.ts';
import { BACKLOG_LIMIT, Tail } from './pty-tail.ts';
import type { PtyBackend, PtyProcess } from './pty-types.ts';
import { Endpoint, type Port } from './rpc.ts';
import { isRecord } from './wire.ts';

/** Конец канала вида в pty-хосте: `MessagePortMain` в Electron, `MessagePort` в Node; сообщения - данные, ввод и ответы на него. */
export interface ViewPort {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

/** Перевод порта `node:worker_threads` в `ViewPort`: для хоста в том же процессе и для тестов. Порт не держит процесс: слушатель сам берёт его в цикл событий, поэтому `unref` после него. */
export function nodeViewPort(raw: unknown): ViewPort {
  const port = raw as MessagePort;
  return {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => {
      port.on('message', listener).unref();
    },
    onClose: (listener) => {
      port.on('close', listener).unref();
    },
    close: () => port.close(),
  };
}

/** Пределы, которые главный процесс передаёт хосту при каждом запуске: хост держит те же, что `PtyTable`. */
export interface PtyHostInit {
  readonly ptyInput: number;
  readonly ptyInputBurst: number;
  readonly ptyInputRate: number;
  readonly ptyFlushMs: number;
  readonly ptyFlushChars: number;
  readonly backlog: number;
}

export interface PtySpawnParams {
  readonly key: string;
  readonly file: string;
  readonly args: readonly string[];
  readonly options: { readonly name: string; readonly cwd?: string; readonly env: Record<string, string>; readonly cols: number; readonly rows: number };
}

/** Сообщение переноса: порт вида идёт отдельным сообщением с `transfer`, а запрос `view` называет его по `viewId`. */
export interface PtyPortMessage {
  readonly t: 'port';
  readonly viewId: string;
}

export const isPortMessage = (m: unknown): m is PtyPortMessage => isRecord(m) && m.t === 'port' && typeof m.viewId === 'string';

/** Столько живёт процесс после SIGHUP, прежде чем его добьёт SIGKILL: shell успевает сохранить историю, `trap '' HUP` - нет. */
export const END_GRACE = 3000;

export interface PtyHostOptions {
  /** Срок между SIGHUP завершаемому процессу и SIGKILL, мс. */
  readonly endGraceMs?: number;
  /** Превращает перенесённый порт в `ViewPort`; по умолчанию - порт `node:worker_threads`. */
  readonly adopt?: (raw: unknown) => ViewPort;
}

interface Entry {
  readonly key: string;
  readonly proc: PtyProcess;
  cols: number;
  rows: number;
  readonly tail: Tail;
  /** Запас ввода: программа может не читать stdin, а очередь записи node-pty не ограничена. */
  readonly budget: InputBudget;
  /** Вывод идёт и главному процессу: владелец плагин присоединён. */
  attached: boolean;
  readonly viewers: Map<string, ViewPort>;
  exit?: PtyExit;
  /** Срок добивания: процесс получил SIGHUP от `end` и ещё не вышел. */
  reaper?: ReturnType<typeof setTimeout> | undefined;
  pending: string[];
  pendingChars: number;
  flushed: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

const size = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000;

/**
 * Процессы pty и всё, что к ним привязано в процессе хоста. Один экземпляр на процесс хоста; ключи `key` выдаёт главный процесс.
 * Внешний порт хоста - запросы и уведомления главного процесса, ответы и события идут обратно тем же `Endpoint`.
 */
export class PtyHost {
  readonly #backend: PtyBackend;
  readonly #endpoint: Endpoint;
  readonly #adopt: (raw: unknown) => ViewPort;
  readonly #endGrace: number;
  readonly #entries = new Map<string, Entry>();
  /** Порты видов, пришедшие раньше запроса `view`. */
  readonly #ports = new Map<string, ViewPort>();
  /** Завершаемые, но не вышедшие процессы: из таблицы они уже убраны, а порты зрителей закрываются вместе с хостом. */
  readonly #ending = new Set<Entry>();
  /** Запуски в пути: `end` на них приходит раньше, чем процесс есть. */
  readonly #spawning = new Map<string, { ended: boolean }>();
  #limits: PtyHostInit = { ptyInput: LIMITS.ptyInput, ptyInputBurst: LIMITS.ptyInputBurst, ptyInputRate: LIMITS.ptyInputRate, ptyFlushMs: LIMITS.ptyFlushMs, ptyFlushChars: LIMITS.ptyFlushChars, backlog: BACKLOG_LIMIT };

  constructor(port: Port, backend: PtyBackend, options: PtyHostOptions = {}) {
    this.#backend = backend;
    this.#adopt = options.adopt ?? nodeViewPort;
    this.#endGrace = options.endGraceMs ?? END_GRACE;
    this.#endpoint = new Endpoint(port);
    port.onMessage((raw, transfer) => this.#received(raw, transfer));
    const e = this.#endpoint;
    e.handle('init', (p: PtyHostInit) => {
      // Недостающее берётся из умолчаний: главный процесс старой сборки не знает новых пределов.
      this.#limits = { ...this.#limits, ...p };
      return null;
    });
    e.handle('ping', () => null);
    e.handle('spawn', (p: PtySpawnParams) => this.#spawn(p));
    e.handle('attach', (p: { key: string }) => this.#attach(p.key));
    e.handle('view', (p: { key: string; viewId: string }) => this.#view(p.key, p.viewId));
    e.handle('kill', (p: { key: string; signal?: string }) => {
      this.#live(p.key).proc.kill(p.signal);
      return null;
    });
    // Ответ уходит, когда процессы вышли: ядро после него убивает хост, а недоставленный выход `node-pty` при очистке окружения роняет процесс (#185).
    e.handle('endAll', async () => {
      for (const key of [...this.#entries.keys()]) this.#end(key);
      await this.#backend.drain?.().catch(() => undefined);
      return null;
    });
    // Ввод, размер, смена владельца и конец - уведомления: ответа ждать некому, главный процесс уже проверил то же самое.
    e.handle('write', (p: { key: string; data: string }) => this.#write(p.key, p.data));
    e.handle('resize', (p: { key: string; cols: number; rows: number }) => this.#resize(p.key, p.cols, p.rows));
    e.handle('owner', (p: { key: string; attached: boolean }) => {
      const entry = this.#entries.get(p.key);
      if (entry) entry.attached = p.attached;
    });
    e.handle('end', (p: { key: string }) => this.#end(p.key));
    e.handle('closeView', (p: { viewId: string }) => {
      this.#ports.get(p.viewId)?.close();
      this.#ports.delete(p.viewId);
      for (const entry of this.#entries.values()) {
        entry.viewers.get(p.viewId)?.close();
        entry.viewers.delete(p.viewId);
      }
    });
  }

  /** Хост закрывается: процессы pty завершаются, порты видов закрыты. */
  dispose(): void {
    for (const key of [...this.#entries.keys()]) this.#end(key);
    for (const e of this.#ending) for (const view of e.viewers.values()) view.close();
    for (const port of this.#ports.values()) port.close();
    this.#ports.clear();
  }

  #received(raw: unknown, transfer: readonly unknown[] | undefined): void {
    if (!isPortMessage(raw) || transfer?.[0] === undefined) return;
    this.#ports.set(raw.viewId, this.#adopt(transfer[0]));
  }

  async #spawn(p: PtySpawnParams): Promise<{ pid: number }> {
    const pending = { ended: false };
    this.#spawning.set(p.key, pending);
    let proc: PtyProcess;
    try {
      proc = await this.#backend.spawn(p.file, [...p.args], { ...p.options });
    } finally {
      this.#spawning.delete(p.key);
    }
    // Главный процесс отозвал запуск, пока backend поднимал процесс: ему этот pty уже не нужен.
    if (pending.ended) {
      proc.kill();
      throw new CoreError('NotFound', `pty ${p.key} отозван до запуска`);
    }
    const entry: Entry = { key: p.key, proc, cols: p.options.cols, rows: p.options.rows, tail: new Tail(this.#limits.backlog), budget: new InputBudget(this.#limits.ptyInputBurst, this.#limits.ptyInputRate), attached: true, viewers: new Map(), pending: [], pendingChars: 0, flushed: -Infinity };
    this.#entries.set(p.key, entry);
    proc.onData((data) => this.#output(entry, data));
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(entry.reaper);
      this.#ending.delete(entry);
      this.#flush(entry);
      const exit: PtyExit = { code: exitCode, ...(signal !== undefined && signal !== 0 && { signal }) };
      entry.exit = exit;
      // Порт закрывает сам вид по `exit`: close() сразу после post мог бы обогнать доставку.
      for (const view of entry.viewers.values()) view.post({ exit });
      entry.viewers.clear();
      this.#endpoint.notify('exit', { key: entry.key, exit });
    });
    return { pid: proc.pid };
  }

  /** Накопленное уходит прежним получателям до хвоста; хвост хост отдаёт владельцу, и тот присоединяется к потоку. */
  #attach(key: string): { backlog: string; exit?: PtyExit } {
    const e = this.#own(key);
    this.#flush(e);
    const backlog = e.tail.text();
    if (e.exit) {
      this.#entries.delete(key);
      return { backlog, exit: e.exit };
    }
    e.attached = true;
    // Тот же размер SIGWINCH не даёт: шаг в сторону и обратно заставляет TUI перерисовать экран для нового владельца.
    e.proc.resize(Math.max(1, e.cols - 1), e.rows);
    e.proc.resize(e.cols, e.rows);
    return { backlog };
  }

  #view(key: string, viewId: string): { backlog: string } {
    const port = this.#ports.get(viewId);
    this.#ports.delete(viewId);
    if (!port) throw new CoreError('NotFound', `порт вида ${viewId} не получен`);
    const e = this.#entries.get(key);
    if (!e || e.exit) {
      port.close();
      throw new CoreError('NotFound', `pty ${key} завершён`);
    }
    // Накопленное уходит прежним зрителям до хвоста: в хвосте новому оно уже есть, повтора не будет.
    this.#flush(e);
    e.viewers.set(viewId, port);
    port.onMessage((m) => this.#fromView(e, viewId, port, m));
    port.onClose(() => {
      if (e.viewers.delete(viewId)) this.#endpoint.notify('viewClosed', { viewId });
    });
    return { backlog: e.tail.text() };
  }

  /** Ввод и размер от вида: ответ идёт в тот же порт, по номеру запроса. */
  #fromView(e: Entry, viewId: string, port: ViewPort, message: unknown): void {
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const { id } = message;
    try {
      if (!e.viewers.has(viewId) || e.exit) throw new CoreError('NotFound', `терминал ${e.key} закрыт`);
      if (message.op === 'write') {
        if (typeof message.data !== 'string') throw new CoreError('Invalid', 'terminal.write: ввод - строка');
        this.#write(e.key, message.data);
      } else if (message.op === 'resize') {
        if (!size(message.cols) || !size(message.rows)) throw new CoreError('Invalid', 'terminal.resize: размер - целые 1..1000');
        this.#resize(e.key, message.cols, message.rows);
      } else {
        throw new CoreError('Invalid', 'терминал: неизвестная операция');
      }
      port.post({ id, ok: true });
    } catch (error) {
      port.post({ id, error: errorMessage(error) });
    }
  }

  #write(key: string, data: string): void {
    const e = this.#live(key);
    e.budget.take(inputBytes(data, this.#limits.ptyInput));
    e.proc.write(data);
  }

  #resize(key: string, cols: number, rows: number): void {
    if (!size(cols) || !size(rows)) throw new CoreError('Invalid', 'pty: размер - целые 1..1000');
    const e = this.#live(key);
    e.cols = cols;
    e.rows = rows;
    e.proc.resize(cols, rows);
  }

  #end(key: string): void {
    const pending = this.#spawning.get(key);
    if (pending) pending.ended = true;
    const e = this.#entries.get(key);
    if (!e) return;
    this.#entries.delete(key);
    clearTimeout(e.timer);
    e.timer = undefined;
    e.pending = [];
    e.pendingChars = 0;
    // Зрители остаются: убитый процесс сообщит им `exit`, как сам вышедший.
    if (e.exit) return;
    e.proc.kill();
    // Переживший SIGHUP (`trap '' HUP`) остался бы без учёта, продолжая писать зрителям: добиваем по сроку.
    this.#ending.add(e);
    e.reaper = setTimeout(() => this.#reap(e), this.#endGrace);
    e.reaper.unref();
  }

  #reap(e: Entry): void {
    clearTimeout(e.reaper);
    e.reaper = undefined;
    if (!this.#ending.delete(e) || e.exit) return;
    e.proc.kill('SIGKILL');
  }

  /** Первый кусок после затишья уходит сразу - эхо клавиши не ждёт; поток под нагрузкой уходит пачками раз в `ptyFlushMs`. */
  #output(e: Entry, data: string): void {
    const { ptyFlushMs: ms, ptyFlushChars: chars } = this.#limits;
    if (ms === 0) {
      this.#deliver(e, data);
      return;
    }
    e.pending.push(data);
    e.pendingChars += data.length;
    const quiet = performance.now() - e.flushed;
    if (e.pendingChars >= chars || (e.timer === undefined && quiet >= ms)) this.#flush(e);
    else e.timer ??= setTimeout(() => this.#flush(e), ms - quiet);
  }

  #flush(e: Entry): void {
    clearTimeout(e.timer);
    e.timer = undefined;
    if (e.pending.length === 0) return;
    const data = e.pending.length === 1 ? (e.pending[0] ?? '') : e.pending.join('');
    e.pending = [];
    e.pendingChars = 0;
    e.flushed = performance.now();
    this.#deliver(e, data);
  }

  #deliver(e: Entry, data: string): void {
    // Хвост держится и при живом владельце: после перезапуска хоста плагина им восстанавливается экран, где TUI не перерисует себя сам.
    e.tail.push(data);
    if (e.attached) this.#endpoint.notify('data', { key: e.key, data });
    for (const view of e.viewers.values()) view.post({ data });
  }

  #own(key: string): Entry {
    const e = this.#entries.get(key);
    if (!e) throw new CoreError('NotFound', `pty ${key} не найден`);
    return e;
  }

  #live(key: string): Entry {
    const e = this.#own(key);
    if (e.exit) throw new CoreError('NotFound', `pty ${key} завершён`);
    return e;
  }
}

/** Запускает pty-хост поверх порта сообщений; `backend` - настоящий `node-pty` (в Electron) или поддельный (в тестах). */
export function runPtyHost(port: Port, backend: PtyBackend, options: PtyHostOptions = {}): PtyHost {
  return new PtyHost(port, backend, options);
}
