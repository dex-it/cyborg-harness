import { randomUUID } from 'node:crypto';
import type { PtyExit, PtyInfo } from '@cyborg-harness/contracts';
import { CoreError } from './errors.ts';
import { LIMITS, type ResourceLimits } from './limits.ts';
import { InputBudget, inputBytes } from './pty-budget.ts';
import { BACKLOG_LIMIT } from './pty-tail.ts';
import { PtyLink, type PtyWatchdog, type SpawnPtyHost } from './pty-link.ts';
import type { PtyProcess, PtyWire } from './pty-types.ts';

export type { PtyBackend, PtyProcess, PtyWire } from './pty-types.ts';

/**
 * Канал вида к pty-хосту: вывод идёт из хоста прямо в этот порт, ввод и размер - обратно, главный процесс в потоке не участвует.
 * Главный процесс создаёт пару портов, отдаёт ядру один конец (`hostEnd`) и второй - фрейму вида.
 */
export interface TerminalChannel {
  /** Конец, который уходит pty-хосту переносом (в Electron - `MessagePortMain`). */
  readonly hostEnd: unknown;
  /** Главному процессу канал больше не нужен: pty завершён, вид закрыл порт или pty-хост потерян (`lost` - тогда порт молчит, и о конце вид узнает отсюда). */
  closed(lost?: PtyExit): void;
}

/** Терминал, открытый видом по билету: описание и хвост; ввод и размер вид шлёт сам в порт. */
export interface TerminalView extends PtyWire {
  /** Предел одного ввода, байт: вид отклоняет большее до порта (дальше то же самое проверит pty-хост). */
  readonly input: number;
  close(): void;
}

/** Код выхода pty, потерянных вместе с pty-хостом: процесса уже нет, настоящий код неизвестен. */
export const PTY_HOST_LOST: PtyExit = Object.freeze({ code: -1 });

interface Entry {
  readonly id: string;
  readonly pluginId: string;
  /** Нет, пока хост не подтвердил запуск. */
  pid: number | undefined;
  readonly program: string;
  readonly args: readonly string[];
  readonly persist: boolean;
  /** Вывод идёт в хост плагина. */
  attached: boolean;
  /** Хвост пропал вместе с pty-хостом. */
  lost: boolean;
  /** Сколько раз владелец уходил (`detach`, `park`): `attach` в пути сверяет это число с ответом pty-хоста. */
  turn: number;
  /** `attach` в пути: пока он есть, pty-хосту о потере владельца не напоминают - ответ решит сам. */
  attaching: number;
  readonly views: Set<string>;
  /** Запас ввода из хоста плагина: сразу `Invalid` в вызове; ввод вида проверяет свой запас pty-хост. */
  readonly budget: InputBudget;
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

export type PtyLimits = Pick<ResourceLimits, 'ptyInput' | 'ptyInputBurst' | 'ptyInputRate' | 'ptyQueue' | 'ptys' | 'ptyFlushMs' | 'ptyFlushChars'>;

/** Льготный срок pty без владельца и уведомления приложению: срок вышел, список оставленных поменялся. */
export interface PtyOrphan {
  readonly graceMs?: number;
  readonly expired?: (expiry: PtyExpiry) => void;
  readonly kept?: () => void;
}

/** Что случилось с самим pty-хостом: упал или завис (процессы потеряны), поднят снова, перестал подниматься. */
export interface PtyHostEvents {
  readonly hostDown?: (down: { readonly reason: 'hang' | 'crash'; /** Плагины, чьи живые pty потеряны. */ readonly plugins: readonly string[] }) => void;
  readonly hostRestarted?: () => void;
  readonly hostAbandoned?: (failures: number) => void;
}

export interface PtyTableOptions extends Partial<PtyLimits>, PtyOrphan, PtyHostEvents {
  /** Хвост вывода одного pty, символов. */
  readonly backlog?: number;
  /** Жизнь билета `share()`, мс. */
  readonly ticketTtl?: number;
  readonly watchdog?: Partial<PtyWatchdog> | undefined;
}

export const PTY_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'] as const;

export { BACKLOG_LIMIT, Tail } from './pty-tail.ts';

/** Столько ждёт pty с `persist`, чей хост упал: перезапуск и активация укладываются в секунды, как переподключение в VS Code. */
export const ORPHAN_GRACE = 60_000;

/**
 * pty всех плагинов в главном процессе: права, владельцы, билеты, льготный срок и список оставленных.
 * Процессы, хвосты и зрители живут в pty-хосте (`PtyHost`), связь с ним - `PtyLink`; сам pty-хост переживает хост плагина, а не ядро.
 */
export class PtyTable {
  readonly #link: PtyLink;
  readonly #push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void;
  readonly #ticketTtl: number;
  readonly #grace: number;
  readonly #expired: (expiry: PtyExpiry) => void;
  readonly #keptChanged: () => void;
  readonly #host: PtyHostEvents;
  readonly #entries = new Map<string, Entry>();
  readonly #tickets = new Map<string, { pluginId: string; id: string; expires: number }>();
  readonly #views = new Map<string, { entry: Entry; channel: TerminalChannel }>();
  readonly #max: PtyLimits;
  #next = 0;
  #nextView = 0;

  constructor(spawnHost: SpawnPtyHost, push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void, options: PtyTableOptions = {}) {
    this.#push = push;
    this.#ticketTtl = options.ticketTtl ?? 30_000;
    this.#grace = options.graceMs ?? ORPHAN_GRACE;
    this.#expired = options.expired ?? (() => undefined);
    this.#keptChanged = options.kept ?? (() => undefined);
    this.#host = options;
    this.#max = { ptyInput: options.ptyInput ?? LIMITS.ptyInput, ptyInputBurst: options.ptyInputBurst ?? LIMITS.ptyInputBurst, ptyInputRate: options.ptyInputRate ?? LIMITS.ptyInputRate, ptyQueue: options.ptyQueue ?? LIMITS.ptyQueue, ptys: options.ptys ?? LIMITS.ptys, ptyFlushMs: options.ptyFlushMs ?? LIMITS.ptyFlushMs, ptyFlushChars: options.ptyFlushChars ?? LIMITS.ptyFlushChars };
    this.#link = new PtyLink(spawnHost, {
      init: { ...this.#max, backlog: options.backlog ?? BACKLOG_LIMIT },
      watchdog: options.watchdog,
      events: {
        data: (key, data) => {
          const e = this.#entries.get(key);
          // Вывод - признак, что программа жива и читает: счёт непрочитанного ввода начинается заново (#167), кому бы вывод ни шёл.
          e?.budget.heard();
          if (e?.attached) this.#push(e.pluginId, 'pty.data', { pluginId: e.pluginId, id: e.id, data });
        },
        exit: (key, exit) => this.#exited(key, exit),
        viewClosed: (viewId) => this.#viewGone(viewId),
        lost: (reason) => this.#lost(reason),
        restarted: () => this.#host.hostRestarted?.(),
        abandoned: (failures) => this.#host.hostAbandoned?.(failures),
      },
    });
  }

  async spawn(pluginId: string, o: { program: string; args: string[]; cwd?: string; env: Record<string, string>; cols: number; rows: number; persist: boolean }): Promise<PtyWire> {
    if (this.#of(pluginId).filter((x) => !x.exit).length >= this.#max.ptys) throw new CoreError('Invalid', `${pluginId}: живых pty больше ${String(this.#max.ptys)} - завершите прежние`);
    // Терминал на той стороне - xterm.js вида: TERM и COLORTERM описывают его, а не окно, из которого запустили приложение.
    const env = { COLORTERM: 'truecolor', ...o.env };
    // Запись встаёт в таблицу до ответа хоста: предел живых pty и падение владельца видят и запуск, который ещё в пути.
    const e: Entry = { id: `pty-${String(++this.#next)}`, pluginId, pid: undefined, program: o.program, args: o.args, persist: o.persist, attached: true, lost: false, turn: 0, attaching: 0, views: new Set(), budget: new InputBudget(this.#max.ptyInputBurst, this.#max.ptyInputRate, this.#max.ptyQueue), keptAt: undefined };
    this.#entries.set(e.id, e);
    try {
      e.pid = await this.#link.spawn({ key: e.id, file: o.program, args: o.args, options: { name: 'xterm-256color', ...(o.cwd !== undefined && { cwd: o.cwd }), env, cols: o.cols, rows: o.rows } });
    } catch (error) {
      if (this.#entries.get(e.id) === e) this.#entries.delete(e.id);
      throw error;
    }
    if (this.#entries.get(e.id) !== e) {
      // Владелец ушёл, пока процесс запускался: он никому не нужен.
      this.#link.note('end', { key: e.id });
      throw new CoreError('NotFound', `pty ${e.id}: плагин ${pluginId} ушёл до запуска`);
    }
    // `detach` и `park` во время запуска слали `owner` в хост, где записи ещё не было: хост считает pty присоединённым.
    if (!e.attached) this.#link.note('owner', { key: e.id, attached: false });
    return { ...info(e as Started), backlog: '' };
  }

  list(pluginId: string): PtyInfo[] {
    return this.#of(pluginId).filter(started).map(info);
  }

  async attach(pluginId: string, id: string): Promise<PtyWire> {
    const e = this.#own(pluginId, id);
    clearTimeout(e.orphaned);
    if (e.keptAt !== undefined) {
      e.keptAt = undefined;
      this.#keptChanged();
    }
    const turn = e.turn;
    e.attaching++;
    let remote: { backlog: string; exit?: PtyExit };
    try {
      // Хвост пропал вместе с pty-хостом: спрашивать некого.
      remote = e.lost ? { backlog: '', ...(e.exit && { exit: e.exit }) } : await this.#link.attach(id);
    } finally {
      e.attaching--;
    }
    if (e.turn !== turn && this.#entries.get(id) === e) {
      // Владелец ушёл, пока pty-хост отвечал: ответ адресован мёртвому хосту плагина, срок сироты или выбор человека в силе.
      if (remote.exit) {
        // Хост свою запись с выходом уже отдал: следующий attach получит выход отсюда.
        e.exit ??= remote.exit;
        e.lost = true;
      } else if (e.attaching === 0 && !e.attached && !e.lost) this.#link.note('owner', { key: id, attached: false });
      throw new CoreError('NotFound', `pty ${id}: владелец ушёл до присоединения`);
    }
    if (e.exit ?? remote.exit) {
      this.#entries.delete(id);
      if (!e.lost) this.#link.note('end', { key: id });
      return { ...info(e), ...(remote.exit && { exit: remote.exit }), backlog: remote.backlog };
    }
    if (this.#entries.get(id) !== e) throw new CoreError('NotFound', `pty ${id} завершён`);
    e.attached = true;
    return { ...info(e), backlog: remote.backlog };
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
  async openTerminal(pluginId: string, ticket: string, channel: TerminalChannel): Promise<TerminalView> {
    const t = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (t?.pluginId !== pluginId || t.expires <= Date.now()) throw new CoreError('NotFound', 'билет терминала не найден, просрочен или уже использован');
    const e = this.#live(pluginId, t.id);
    const viewId = `view-${String(++this.#nextView)}`;
    this.#views.set(viewId, { entry: e, channel });
    e.views.add(viewId);
    let backlog: string;
    try {
      backlog = await this.#link.view(e.id, viewId, channel.hostEnd);
    } catch (error) {
      this.#forgetView(viewId);
      throw error;
    }
    return { ...info(e), backlog, input: this.#max.ptyInput, close: () => {
        if (this.#forgetView(viewId)) this.#link.note('closeView', { viewId });
      },
    };
  }

  write(pluginId: string, id: string, data: string): void {
    const e = this.#live(pluginId, id);
    e.budget.take(inputBytes(data, this.#max.ptyInput));
    this.#link.note('write', { key: e.id, data });
  }

  resize(pluginId: string, id: string, cols: number, rows: number): void {
    const e = this.#live(pluginId, id);
    this.#link.note('resize', { key: e.id, cols, rows });
  }

  kill(pluginId: string, id: string, signal: string | undefined): void {
    const e = this.#live(pluginId, id);
    this.#link.note('kill', { key: e.id, ...(signal !== undefined && { signal }) });
  }

  /** Хост плагина упал: `persist` ждут attach не дольше льготного срока, прочие завершаются - их вывод больше некому принять. */
  detach(pluginId: string): void {
    for (const e of this.#unkept(pluginId)) {
      if (!e.persist || e.exit) {
        this.#end(e);
        continue;
      }
      e.turn++;
      this.#unattach(e);
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
      if (e.exit) this.#drop(e);
      else {
        e.turn++;
        this.#unattach(e);
        e.keptAt ??= Date.now();
        kept++;
      }
    }
    if (kept > 0) this.#keptChanged();
    return kept;
  }

  /** Плагин удалён: уходят все его pty, и оставленные человеком тоже; число живых, которые это завершило. */
  endAll(pluginId: string): number {
    const mine = this.#of(pluginId);
    const live = mine.filter((e) => !e.exit).length;
    for (const e of mine) this.#end(e);
    if (mine.some((e) => e.keptAt !== undefined)) this.#keptChanged();
    return live;
  }

  /** Оставленные человеком процессы выключенных плагинов, в том числе завершившиеся сами. */
  kept(): KeptPty[] {
    return [...this.#entries.values()].filter(started).flatMap((e) => (e.keptAt === undefined ? [] : [{ ...info(e), pluginId: e.pluginId, keptAt: e.keptAt }]));
  }

  /** Человек завершил оставленный процесс или убрал завершившийся. */
  endKept(id: string): void {
    const e = this.#entries.get(id);
    if (e?.keptAt === undefined) throw new CoreError('NotFound', `оставленного pty ${id} нет`);
    this.#end(e);
    this.#keptChanged();
  }

  /** Приложение завершается: припаркованные pty выключенных плагинов тоже уходят, потом останавливается pty-хост. */
  async releaseAll(): Promise<void> {
    for (const e of [...this.#entries.values()]) this.#end(e);
    await this.#link.stop();
  }

  #unattach(e: Entry): void {
    if (!e.attached) return;
    e.attached = false;
    this.#link.note('owner', { key: e.id, attached: false });
  }

  /** Запись уходит из таблицы вместе с хвостом в хосте; процесс не трогается. */
  #drop(e: Entry): void {
    this.#entries.delete(e.id);
    this.#link.note('end', { key: e.id });
  }

  #end(e: Entry): void {
    clearTimeout(e.orphaned);
    this.#entries.delete(e.id);
    // Зрители узнают о конце от самого процесса: убитый pty пришлёт им `exit` по порту.
    for (const viewId of [...e.views]) this.#viewGone(viewId);
    this.#link.note('end', { key: e.id });
  }

  #exited(key: string, exit: PtyExit): void {
    const e = this.#entries.get(key);
    if (!e || e.exit) return;
    e.exit = exit;
    for (const viewId of [...e.views]) this.#viewGone(viewId);
    if (e.keptAt !== undefined) this.#keptChanged();
    if (!e.attached) return;
    this.#drop(e);
    this.#push(e.pluginId, 'pty.exit', { pluginId: e.pluginId, id: e.id, exit });
  }

  /** Хост упал или завис: процессов в нём больше нет, владельцы узнают об этом как о завершении. */
  #lost(reason: 'hang' | 'crash'): void {
    const plugins = new Set<string>();
    let kept = false;
    for (const e of [...this.#entries.values()]) {
      // Запуск в пути отклонится сам: его запрос оборван вместе с хостом.
      if (e.pid === undefined) continue;
      e.lost = true;
      if (e.exit) continue;
      plugins.add(e.pluginId);
      e.exit = PTY_HOST_LOST;
      for (const viewId of [...e.views]) this.#viewGone(viewId, PTY_HOST_LOST);
      kept ||= e.keptAt !== undefined;
      if (e.attached) {
        clearTimeout(e.orphaned);
        this.#entries.delete(e.id);
        this.#push(e.pluginId, 'pty.exit', { pluginId: e.pluginId, id: e.id, exit: PTY_HOST_LOST });
      }
    }
    if (kept) this.#keptChanged();
    this.#host.hostDown?.({ reason, plugins: [...plugins] });
  }

  #viewGone(viewId: string, lost?: PtyExit): void {
    const v = this.#views.get(viewId);
    if (!v || !this.#forgetView(viewId)) return;
    v.channel.closed(lost);
  }

  #forgetView(viewId: string): boolean {
    const v = this.#views.get(viewId);
    if (!v) return false;
    this.#views.delete(viewId);
    v.entry.views.delete(viewId);
    return true;
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

  #own(pluginId: string, id: string): Started {
    const e = this.#entries.get(id);
    // Чужой id неотличим от несуществующего: список чужих pty плагину не виден.
    if (e?.pluginId !== pluginId || !started(e)) throw new CoreError('NotFound', `pty ${id} не найден`);
    return e;
  }

  #live(pluginId: string, id: string): Started {
    const e = this.#own(pluginId, id);
    if (e.exit) throw new CoreError('NotFound', `pty ${id} завершён`);
    return e;
  }
}

type Started = Entry & { pid: number };

const started = (e: Entry): e is Started => e.pid !== undefined;

function info(e: Entry & { pid: number }): PtyInfo {
  return { id: e.id, pid: e.pid, program: e.program, args: e.args, persist: e.persist, ...(e.exit && { exit: e.exit }) };
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
