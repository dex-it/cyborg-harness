import type { PtyExit, PtyInfo } from '@cyborg/contracts';
import { CoreError } from './errors.ts';

/** Процесс в псевдотерминале; форма совпадает с IPty из node-pty, так что адаптер Electron отдаёт его как есть. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyBackend {
  spawn(file: string, args: string[], options: { name: string; cwd?: string; env: Record<string, string>; cols: number; rows: number }): PtyProcess;
}

/** Что уходит в хост на spawn и attach: описание плюс хвост вывода. */
export interface PtyWire extends PtyInfo {
  readonly backlog: string;
}

interface Entry {
  readonly id: string;
  readonly pluginId: string;
  readonly proc: PtyProcess;
  readonly program: string;
  readonly args: readonly string[];
  readonly persist: boolean;
  cols: number;
  rows: number;
  backlog: string;
  attached: boolean;
  exit?: PtyExit;
}

export const PTY_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] as const;

/** pty всех плагинов: живут в главном процессе, переживают хост, если просили `persist`. */
export class PtyTable {
  readonly #backend: PtyBackend;
  readonly #push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void;
  readonly #limit: number;
  readonly #entries = new Map<string, Entry>();
  #next = 0;

  constructor(backend: PtyBackend, push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void, backlogLimit = 256 * 1024) {
    this.#backend = backend;
    this.#push = push;
    this.#limit = backlogLimit;
  }

  spawn(pluginId: string, o: { program: string; args: string[]; cwd?: string; env: Record<string, string>; cols: number; rows: number; persist: boolean }): PtyWire {
    const proc = this.#backend.spawn(o.program, o.args, { name: 'xterm-256color', ...(o.cwd !== undefined && { cwd: o.cwd }), env: o.env, cols: o.cols, rows: o.rows });
    const e: Entry = { id: `pty-${String(++this.#next)}`, pluginId, proc, program: o.program, args: o.args, persist: o.persist, cols: o.cols, rows: o.rows, backlog: '', attached: true };
    this.#entries.set(e.id, e);
    proc.onData((data) => {
      // Хвост держится и при живом владельце: после перезапуска хоста им восстанавливается экран, где TUI не перерисует себя сам.
      e.backlog = (e.backlog + data).slice(-this.#limit);
      if (e.attached) this.#push(pluginId, 'pty.data', { pluginId, id: e.id, data });
    });
    proc.onExit(({ exitCode, signal }) => {
      e.exit = { code: exitCode, ...(signal !== undefined && signal !== 0 && { signal }) };
      if (!e.attached) return;
      this.#entries.delete(e.id);
      this.#push(pluginId, 'pty.exit', { pluginId, id: e.id, exit: e.exit });
    });
    return { ...info(e), backlog: '' };
  }

  list(pluginId: string): PtyInfo[] {
    return [...this.#entries.values()].filter((e) => e.pluginId === pluginId).map(info);
  }

  attach(pluginId: string, id: string): PtyWire {
    const e = this.#own(pluginId, id);
    const wire = { ...info(e), backlog: e.backlog };
    if (e.exit) {
      this.#entries.delete(id);
      return wire;
    }
    e.attached = true;
    // Тот же размер SIGWINCH не даёт: шаг в сторону и обратно заставляет TUI перерисовать экран для нового владельца.
    e.proc.resize(Math.max(1, e.cols - 1), e.rows);
    e.proc.resize(e.cols, e.rows);
    return wire;
  }

  write(pluginId: string, id: string, data: string): void {
    this.#live(pluginId, id).proc.write(data);
  }

  resize(pluginId: string, id: string, cols: number, rows: number): void {
    const e = this.#live(pluginId, id);
    e.cols = cols;
    e.rows = rows;
    e.proc.resize(cols, rows);
  }

  kill(pluginId: string, id: string, signal: string | undefined): void {
    this.#live(pluginId, id).proc.kill(signal);
  }

  /** Хост плагина упал: `persist` ждут attach, прочие завершаются - их вывод больше некому принять. */
  detach(pluginId: string): void {
    for (const e of this.#of(pluginId)) {
      if (e.persist && !e.exit) e.attached = false;
      else this.#end(e);
    }
  }

  /** Плагин выключен, выгружен или не вернётся после падения хоста. */
  release(pluginId: string): void {
    for (const e of this.#of(pluginId)) this.#end(e);
  }

  #end(e: Entry): void {
    this.#entries.delete(e.id);
    if (!e.exit) e.proc.kill();
  }

  #of(pluginId: string): Entry[] {
    return [...this.#entries.values()].filter((e) => e.pluginId === pluginId);
  }

  #own(pluginId: string, id: string): Entry {
    const e = this.#entries.get(id);
    // Чужой id неотличим от несуществующего: список чужих pty плагину не виден.
    if (e?.pluginId !== pluginId) throw new CoreError('NotFound', `pty ${id} не найден`);
    return e;
  }

  #live(pluginId: string, id: string): Entry {
    const e = this.#own(pluginId, id);
    if (e.exit) throw new CoreError('NotFound', `pty ${id} завершён`);
    return e;
  }
}

function info(e: Entry): PtyInfo {
  return { id: e.id, pid: e.proc.pid, program: e.program, args: e.args, persist: e.persist, ...(e.exit && { exit: e.exit }) };
}
