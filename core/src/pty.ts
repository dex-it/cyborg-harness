import { randomUUID } from 'node:crypto';
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

/** Куда ядро шлёт вывод pty для UI-части: мимо хоста, прямо в документ вида. */
export interface TerminalSink {
  data(chunk: string): void;
  exit(exit: PtyExit): void;
}

/** Терминал, открытый видом по билету: ввод и размер идут в pty без хоста плагина. */
export interface TerminalView extends PtyWire {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
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
  readonly viewers: Set<TerminalSink>;
  exit?: PtyExit;
}

export const PTY_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] as const;

/** pty всех плагинов: живут в главном процессе, переживают хост, если просили `persist`. */
export class PtyTable {
  readonly #backend: PtyBackend;
  readonly #push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void;
  readonly #limit: number;
  readonly #ticketTtl: number;
  readonly #entries = new Map<string, Entry>();
  readonly #tickets = new Map<string, { pluginId: string; id: string; expires: number }>();
  #next = 0;

  constructor(backend: PtyBackend, push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void, backlogLimit = 256 * 1024, ticketTtl = 30_000) {
    this.#backend = backend;
    this.#push = push;
    this.#limit = backlogLimit;
    this.#ticketTtl = ticketTtl;
  }

  spawn(pluginId: string, o: { program: string; args: string[]; cwd?: string; env: Record<string, string>; cols: number; rows: number; persist: boolean }): PtyWire {
    const proc = this.#backend.spawn(o.program, o.args, { name: 'xterm-256color', ...(o.cwd !== undefined && { cwd: o.cwd }), env: o.env, cols: o.cols, rows: o.rows });
    const e: Entry = { id: `pty-${String(++this.#next)}`, pluginId, proc, program: o.program, args: o.args, persist: o.persist, cols: o.cols, rows: o.rows, backlog: '', attached: true, viewers: new Set() };
    this.#entries.set(e.id, e);
    proc.onData((data) => {
      // Хвост держится и при живом владельце: после перезапуска хоста им восстанавливается экран, где TUI не перерисует себя сам.
      e.backlog = (e.backlog + data).slice(-this.#limit);
      if (e.attached) this.#push(pluginId, 'pty.data', { pluginId, id: e.id, data });
      for (const v of e.viewers) v.data(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      const exit: PtyExit = { code: exitCode, ...(signal !== undefined && signal !== 0 && { signal }) };
      e.exit = exit;
      for (const v of e.viewers) v.exit(exit);
      e.viewers.clear();
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

  /** Билет на один `openTerminal` своего UI; живёт `ticketTtl` мс - забытый в журнале или логе билет быстро протухает. */
  share(pluginId: string, id: string): string {
    this.#live(pluginId, id);
    const now = Date.now();
    for (const [t, v] of this.#tickets) if (v.expires <= now) this.#tickets.delete(t);
    const ticket = randomUUID();
    this.#tickets.set(ticket, { pluginId, id, expires: now + this.#ticketTtl });
    return ticket;
  }

  /** Билет гасится при первом предъявлении, даже чужим плагином: второй попытки у перехватчика нет. */
  openTerminal(pluginId: string, ticket: string, sink: TerminalSink): TerminalView {
    const t = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (t?.pluginId !== pluginId || t.expires <= Date.now()) throw new CoreError('NotFound', 'билет терминала не найден, просрочен или уже использован');
    const e = this.#live(pluginId, t.id);
    e.viewers.add(sink);
    const own = () => {
      if (!e.viewers.has(sink) || e.exit) throw new CoreError('NotFound', `терминал ${e.id} закрыт`);
    };
    return {
      ...info(e),
      backlog: e.backlog,
      write: (data) => {
        own();
        e.proc.write(data);
      },
      resize: (cols, rows) => {
        own();
        e.cols = cols;
        e.rows = rows;
        e.proc.resize(cols, rows);
      },
      close: () => e.viewers.delete(sink),
    };
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
