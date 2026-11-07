import { randomUUID } from 'node:crypto';
import type { PtyExit, PtyInfo } from '@cyborg-harness/contracts';
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
  readonly tail: Tail;
  attached: boolean;
  readonly viewers: Set<TerminalSink>;
  exit?: PtyExit;
  orphaned?: ReturnType<typeof setTimeout>;
  /** Оставлен человеком при выключении плагина; снимается, когда плагин вернулся. */
  keptAt: number | undefined;
}

/** pty без владельца завершён по сроку: плагин не вернулся и не сделал `attach`. */
export interface PtyExpiry {
  readonly pluginId: string;
  readonly id: string;
  readonly program: string;
  readonly graceMs: number;
}

/** Оставленный человеком процесс выключенного плагина: ждёт без срока, пока плагин не вернётся. */
export interface KeptPty extends PtyInfo {
  readonly pluginId: string;
  /** Когда оставлен, мс от эпохи. */
  readonly keptAt: number;
}

export const PTY_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] as const;

/** pty всех плагинов: живут в главном процессе, переживают хост, если просили `persist`. */
/** Хвост вывода: куски склеиваются при чтении и изредка при сжатии, а не копией всего хвоста на каждый кусок. */
export class Tail {
  readonly #limit: number;
  #chunks: string[] = [];
  #size = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(data: string): void {
    this.#chunks.push(data);
    this.#size += data.length;
    let first = this.#chunks[0];
    while (first !== undefined && this.#chunks.length > 1 && this.#size - first.length >= this.#limit) {
      this.#chunks.shift();
      this.#size -= first.length;
      first = this.#chunks[0];
    }
    if (this.#chunks.length > 1024) {
      const text = this.text();
      this.#chunks = [text];
      this.#size = text.length;
    }
  }

  text(): string {
    const all = this.#chunks.join('');
    return all.length > this.#limit ? all.slice(-this.#limit) : all;
  }

  take(): string {
    const text = this.text();
    this.#chunks = [];
    this.#size = 0;
    return text;
  }
}

export const BACKLOG_LIMIT = 256 * 1024;
/** Столько ждёт pty с `persist`, чей хост упал: перезапуск и активация укладываются в секунды, как переподключение в VS Code. */
export const ORPHAN_GRACE = 60_000;

export class PtyTable {
  readonly #backend: PtyBackend;
  readonly #push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void;
  readonly #limit: number;
  readonly #ticketTtl: number;
  readonly #grace: number;
  readonly #expired: (expiry: PtyExpiry) => void;
  readonly #keptChanged: () => void;
  readonly #entries = new Map<string, Entry>();
  readonly #tickets = new Map<string, { pluginId: string; id: string; expires: number }>();
  #next = 0;

  constructor(
    backend: PtyBackend,
    push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void,
    backlogLimit = BACKLOG_LIMIT,
    ticketTtl = 30_000,
    orphan: { readonly graceMs?: number; readonly expired?: (expiry: PtyExpiry) => void; readonly kept?: () => void } = {},
  ) {
    this.#backend = backend;
    this.#push = push;
    this.#limit = backlogLimit;
    this.#ticketTtl = ticketTtl;
    this.#grace = orphan.graceMs ?? ORPHAN_GRACE;
    this.#expired = orphan.expired ?? (() => undefined);
    this.#keptChanged = orphan.kept ?? (() => undefined);
  }

  spawn(pluginId: string, o: { program: string; args: string[]; cwd?: string; env: Record<string, string>; cols: number; rows: number; persist: boolean }): PtyWire {
    const proc = this.#backend.spawn(o.program, o.args, { name: 'xterm-256color', ...(o.cwd !== undefined && { cwd: o.cwd }), env: o.env, cols: o.cols, rows: o.rows });
    const e: Entry = { id: `pty-${String(++this.#next)}`, pluginId, proc, program: o.program, args: o.args, persist: o.persist, cols: o.cols, rows: o.rows, tail: new Tail(this.#limit), attached: true, viewers: new Set(), keptAt: undefined };
    this.#entries.set(e.id, e);
    proc.onData((data) => {
      // Хвост держится и при живом владельце: после перезапуска хоста им восстанавливается экран, где TUI не перерисует себя сам.
      e.tail.push(data);
      if (e.attached) this.#push(pluginId, 'pty.data', { pluginId, id: e.id, data });
      for (const v of e.viewers) v.data(data);
    });
    proc.onExit(({ exitCode, signal }) => {
      const exit: PtyExit = { code: exitCode, ...(signal !== undefined && signal !== 0 && { signal }) };
      e.exit = exit;
      for (const v of e.viewers) v.exit(exit);
      e.viewers.clear();
      if (e.keptAt !== undefined) this.#keptChanged();
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
    const wire = { ...info(e), backlog: e.tail.text() };
    clearTimeout(e.orphaned);
    if (e.keptAt !== undefined) {
      e.keptAt = undefined;
      this.#keptChanged();
    }
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
      backlog: e.tail.text(),
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

  /** Хост плагина упал: `persist` ждут attach не дольше льготного срока, прочие завершаются - их вывод больше некому принять. */
  detach(pluginId: string): void {
    for (const e of this.#unkept(pluginId)) {
      if (!e.persist || e.exit) {
        this.#end(e);
        continue;
      }
      e.attached = false;
      this.#orphan(e);
    }
  }

  /** Плагин активирован: его pty без владельца, оставленные человеком тоже, ждут attach не дольше льготного срока. */
  claim(pluginId: string): void {
    let unkept = false;
    for (const e of this.#of(pluginId)) {
      if (e.attached) continue;
      unkept ||= e.keptAt !== undefined;
      e.keptAt = undefined;
      this.#orphan(e);
    }
    if (unkept) this.#keptChanged();
  }

  /** Плагин выключен, выгружен или не вернётся после падения хоста; оставленные человеком ждут дальше. */
  release(pluginId: string): void {
    for (const e of this.#unkept(pluginId)) this.#end(e);
  }

  /** Человек выключил плагин и оставил его процессы: живые ждут без срока, пока плагин не вернётся; число оставленных. */
  park(pluginId: string): number {
    let kept = 0;
    for (const e of this.#of(pluginId)) {
      // Выбор человека сильнее срока, взведённого падением хоста.
      clearTimeout(e.orphaned);
      if (e.exit) this.#entries.delete(e.id);
      else {
        e.attached = false;
        e.keptAt ??= Date.now();
        kept++;
      }
    }
    if (kept > 0) this.#keptChanged();
    return kept;
  }

  /** Оставленные человеком процессы выключенных плагинов, в том числе завершившиеся сами. */
  kept(): KeptPty[] {
    return [...this.#entries.values()].flatMap((e) => (e.keptAt === undefined ? [] : [{ ...info(e), pluginId: e.pluginId, keptAt: e.keptAt }]));
  }

  /** Человек завершил оставленный процесс или убрал завершившийся. */
  endKept(id: string): void {
    const e = this.#entries.get(id);
    if (e?.keptAt === undefined) throw new CoreError('NotFound', `оставленного pty ${id} нет`);
    this.#end(e);
    this.#keptChanged();
  }

  /** Приложение завершается: припаркованные pty выключенных плагинов тоже уходят. */
  releaseAll(): void {
    for (const e of [...this.#entries.values()]) this.#end(e);
  }

  #end(e: Entry): void {
    clearTimeout(e.orphaned);
    this.#entries.delete(e.id);
    if (!e.exit) e.proc.kill();
  }

  #orphan(e: Entry): void {
    clearTimeout(e.orphaned);
    e.orphaned = setTimeout(() => {
      if (e.attached || this.#entries.get(e.id) !== e) return;
      // Завершившийся сам процесс сроком не убит: запись просто уходит.
      const alive = !e.exit;
      this.#end(e);
      if (alive) this.#expired({ pluginId: e.pluginId, id: e.id, program: e.program, graceMs: this.#grace });
    }, this.#grace);
    // Ждущий срока pty не держит процесс приложения: выход из него и так завершит все.
    e.orphaned.unref();
  }

  #of(pluginId: string): Entry[] {
    return [...this.#entries.values()].filter((e) => e.pluginId === pluginId);
  }

  #unkept(pluginId: string): Entry[] {
    return this.#of(pluginId).filter((e) => e.keptAt === undefined);
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

const send = (target: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
};

/** Сигнал группе, лидер которой `pid`: потомки (сборка, MCP-серверы агента) уходят вместе с ним. Группы нет - только самому процессу. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || !send(-pid, signal)) send(pid, signal);
}

/** node-pty делает процесс лидером группы, но `kill` шлёт сигнал только ему. */
export function groupKilled(proc: PtyProcess): PtyProcess {
  if (process.platform === 'win32') return proc;
  return {
    get pid() {
      return proc.pid;
    },
    onData: (listener) => proc.onData(listener),
    onExit: (listener) => proc.onExit(listener),
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: (signal) => killGroup(proc.pid, (signal ?? 'SIGHUP') as NodeJS.Signals),
  };
}
