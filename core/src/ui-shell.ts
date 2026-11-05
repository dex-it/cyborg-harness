// Оболочка вида в его <iframe> (SAD2 §3.8) идёт в браузер: здесь нет node-модулей.

import type { Disposable, FeedLine, Reply, ThemeTokens, UiContext, ViewDrop } from '@cyborg/contracts';
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
}

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

/** Тема ставится до возврата: модуль плагина монтируется уже на своих токенах, без вспышки чужих цветов. */
export async function connectView(bridge: ViewBridge, target: ViewTarget): Promise<UiContext> {
  let tokens = await bridge.theme();
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
    drag: Object.freeze({ start: (path: string) => bridge.startDrag(path), drop: () => bridge.drop() }),
  });
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
