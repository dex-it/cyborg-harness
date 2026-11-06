// Оболочка вида в его <iframe> (SAD §3.8) идёт в браузер: здесь нет node-модулей.

import type { DialogSpec, Disposable, FeedLine, PtyExit, PtyInfo, Reply, ThemeTokens, UiContext, UiTerminal, ViewDrop } from '@cyborg-harness/contracts';
import { toDisposable } from './disposable.ts';

/** Мост вида к главному процессу, его выдаёт preload приложения; плагин работает с `UiContext`, а не с ним. */
export interface ViewBridge {
  run(command: string, args: readonly unknown[]): Promise<Reply>;
  /** `value: true` - поставщик есть, `false` - нет. */
  contract(contract: string, major: number): Promise<Reply>;
  call(contract: string, major: number, method: string, args: readonly unknown[]): Promise<Reply>;
  theme(): Promise<ThemeTokens>;
  onTheme(listener: (tokens: ThemeTokens) => void): void;
  onVisibility(listener: (visible: boolean) => void): void;
  logs(): Promise<readonly FeedLine[]>;
  onLog(listener: (line: FeedLine) => void): void;
  startDrag(path: string): void;
  drop(): Promise<ViewDrop | null>;
  /** `value` - `TerminalOpened`. */
  terminalOpen(ticket: string): Promise<Reply>;
  terminalWrite(tid: number, data: string): Promise<Reply>;
  terminalResize(tid: number, cols: number, rows: number): Promise<Reply>;
  terminalClose(tid: number): void;
  onTerminal(listener: (event: TerminalEvent) => void): void;
  /** `value` - память вида или undefined. */
  state(view: string): Promise<Reply>;
  setState(view: string, value: unknown): Promise<Reply>;
  /** `value` - id выбранного пункта или undefined. */
  dialog(view: string, spec: DialogSpec): Promise<Reply>;
  /** Команды своего плагина -> сочетание; таблица сочетаний не меняется до перезапуска ядра. */
  keys(): Promise<Readonly<Record<string, string>>>;
}

/** Ответ на `terminalOpen`: описание pty, хвост и номер терминала в этом документе. */
export interface TerminalOpened extends PtyInfo {
  readonly tid: number;
  readonly backlog: string;
}

export type TerminalEvent = { readonly tid: number; readonly data: string } | { readonly tid: number; readonly exit: PtyExit };

export interface ViewTarget {
  readonly pluginId: string;
  readonly view: string;
  /** Ставит переменные темы на `:root` документа. */
  readonly applyTheme: (tokens: ThemeTokens) => void;
  /** Ошибка слушателя плагина: оболочка не падает из-за него. */
  readonly report: (error: unknown) => void;
}

function unwrap(reply: Reply): unknown {
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.value;
}

class Listeners<T> {
  readonly #set = new Set<(value: T) => void>();
  readonly #report: (error: unknown) => void;

  constructor(report: (error: unknown) => void) {
    this.#report = report;
  }

  add(listener: (value: T) => void): Disposable {
    const wrapped = (value: T) => listener(value);
    this.#set.add(wrapped);
    return toDisposable(() => this.#set.delete(wrapped));
  }

  get size(): number {
    return this.#set.size;
  }

  emit(value: T): void {
    for (const listener of [...this.#set]) {
      try {
        listener(value);
      } catch (error) {
        this.#report(error);
      }
    }
  }
}

// `then` не отдаётся: иначе await на вернувшемся объекте ушёл бы вызовом в главный процесс.
function remote(bridge: ViewBridge, contract: string, major: number): object {
  return new Proxy(Object.freeze({}), {
    get: (_target, key) => (typeof key !== 'string' || key === 'then' ? undefined : (...args: unknown[]) => bridge.call(contract, major, key, args).then(unwrap)),
  });
}

interface OpenTerminal {
  readonly data: Listeners<string>;
  readonly exit: Listeners<PtyExit>;
  readonly early: string[];
  exited?: PtyExit;
}

/** Терминалы документа: события по `tid` могут прийти раньше ответа на open, они ждут в `early`. */
class Terminals {
  readonly #bridge: ViewBridge;
  readonly #report: (error: unknown) => void;
  readonly #open = new Map<number, OpenTerminal>();
  readonly #pending = new Map<number, TerminalEvent[]>();

  constructor(bridge: ViewBridge, report: (error: unknown) => void) {
    this.#bridge = bridge;
    this.#report = report;
    bridge.onTerminal((event) => {
      const t = this.#open.get(event.tid);
      if (!t) {
        this.#pending.set(event.tid, [...(this.#pending.get(event.tid) ?? []), event]);
        return;
      }
      if ('data' in event) {
        if (t.data.size === 0) t.early.push(event.data);
        else t.data.emit(event.data);
        return;
      }
      t.exited = event.exit;
      t.exit.emit(event.exit);
      this.#open.delete(event.tid);
    });
  }

  async open(ticket: string): Promise<UiTerminal> {
    if (typeof ticket !== 'string') throw new Error('terminal.open: билет - строка от PtyHandle.share()');
    const { tid, ...info } = unwrap(await this.#bridge.terminalOpen(ticket)) as TerminalOpened;
    const t: OpenTerminal = { data: new Listeners<string>(this.#report), exit: new Listeners<PtyExit>(this.#report), early: [] };
    this.#open.set(tid, t);
    const pending = this.#pending.get(tid) ?? [];
    this.#pending.delete(tid);
    for (const event of pending) {
      if ('data' in event) t.early.push(event.data);
      else {
        t.exited = event.exit;
        this.#open.delete(tid);
      }
    }
    let closed = false;
    return Object.freeze({
      ...info,
      onData: (listener: (chunk: string) => void) => {
        const sub = t.data.add(listener);
        for (const chunk of t.early.splice(0)) t.data.emit(chunk);
        return sub;
      },
      onExit: (listener: (exit: PtyExit) => void) => {
        const exited = t.exited;
        if (exited) queueMicrotask(() => listener(exited));
        return t.exit.add(listener);
      },
      write: async (data: string) => void unwrap(await this.#bridge.terminalWrite(tid, data)),
      resize: async (cols: number, rows: number) => void unwrap(await this.#bridge.terminalResize(tid, cols, rows)),
      close: () => {
        if (closed) return;
        closed = true;
        this.#open.delete(tid);
        this.#bridge.terminalClose(tid);
      },
    });
  }
}

/** Тема ставится до возврата: модуль плагина монтируется уже на своих токенах, без вспышки чужих цветов. */
export async function connectView(bridge: ViewBridge, target: ViewTarget): Promise<UiContext> {
  const keysAsked = bridge.keys();
  let [tokens, memory] = await Promise.all([bridge.theme(), bridge.state(target.view).then(unwrap)]);
  const keys = { ...(await keysAsked) };
  target.applyTheme(tokens);
  let visible = true;
  const themes = new Listeners<ThemeTokens>(target.report);
  const visibility = new Listeners<boolean>(target.report);
  const logs = new Listeners<FeedLine>(target.report);
  bridge.onTheme((next) => {
    tokens = next;
    target.applyTheme(next);
    themes.emit(next);
  });
  bridge.onVisibility((next) => {
    if (next === visible) return;
    visible = next;
    visibility.emit(next);
  });
  bridge.onLog((line) => logs.emit(line));
  const terminals = new Terminals(bridge, target.report);
  return Object.freeze({
    pluginId: target.pluginId,
    view: target.view,
    commands: Object.freeze({ run: async (command: string, ...args: unknown[]) => unwrap(await bridge.run(command, args)) }),
    contracts: Object.freeze({
      get: async (contract: string, major: number) => ((await bridge.contract(contract, major).then(unwrap)) === true ? remote(bridge, contract, major) : undefined),
    }) as UiContext['contracts'],
    theme: Object.freeze({
      get tokens() {
        return tokens;
      },
      onChange: (listener: (tokens: ThemeTokens) => void) => themes.add(listener),
    }),
    get visible() {
      return visible;
    },
    onVisibilityChange: (listener: (visible: boolean) => void) => visibility.add(listener),
    logs: () => bridge.logs(),
    onLog: (listener: (line: FeedLine) => void) => logs.add(listener),
    terminal: Object.freeze({ open: (ticket: string) => terminals.open(ticket) }),
    state: Object.freeze({
      get value() {
        return memory === undefined ? undefined : structuredClone(memory);
      },
      set: async (value: unknown) => {
        unwrap(await bridge.setState(target.view, value));
        memory = value === undefined ? undefined : structuredClone(value);
      },
    }),
    dialogs: Object.freeze({ show: async (spec: DialogSpec) => unwrap(await bridge.dialog(target.view, spec)) as string | undefined }),
    keys: Object.freeze({ of: (command: string) => (Object.hasOwn(keys, command) ? keys[command] : undefined) }),
    drag: Object.freeze({ start: (path: string) => bridge.startDrag(path), drop: () => bridge.drop() }),
  });
}

/** Минимум DOM для `keepFocus`: ядро собирается без lib DOM. */
export interface FocusWindow {
  addEventListener(type: 'focus', listener: () => void): void;
  removeEventListener(type: 'focus', listener: () => void): void;
  readonly document: { readonly activeElement: unknown; readonly body: unknown };
}

export interface FocusRoot {
  querySelector(selectors: string): { focus(): void } | null;
}

// Не `[href]`: под него попадает <link> стилей вида; cy-* - хосты, их фокус в тени.
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), cy-button:not([disabled]), cy-field:not([disabled]), cy-list, cy-tree, cy-tabs';

/** Фокус пришёл во фрейм снаружи: в первый раз он лёг бы на body, и человек не видел бы, где он. Дальше документ сам помнит свой элемент. */
export function keepFocus(win: FocusWindow, root: FocusRoot): Disposable {
  const place = () => {
    const { activeElement, body } = win.document;
    if (activeElement === null || activeElement === body) (root.querySelector('[autofocus]') ?? root.querySelector(FOCUSABLE))?.focus();
  };
  win.addEventListener('focus', place);
  return toDisposable(() => win.removeEventListener('focus', place));
}

/** Вызывает `mount` модуля; не модуль вида - исключение с причиной, которую оболочка покажет вместо вида. */
export function mountModule(module: unknown, root: unknown, ctx: UiContext): Disposable {
  const mount = typeof module === 'object' && module !== null ? (module as { mount?: unknown }).mount : undefined;
  if (typeof mount !== 'function') throw new Error(`${ctx.pluginId}: модуль вида ${ctx.view} не экспортирует mount(root, ctx)`);
  const result: unknown = (mount as (root: unknown, ctx: UiContext) => unknown)(root, ctx);
  const dispose = typeof result === 'object' && result !== null ? (result as { dispose?: unknown }).dispose : undefined;
  return toDisposable(() => {
    if (typeof dispose === 'function') dispose.call(result);
  });
}
