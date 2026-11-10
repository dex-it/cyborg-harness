import { AsyncLocalStorage } from 'node:async_hooks';
import { splitSignal, withSignal } from './cancel.ts';
import { resolveSection, VERSION_KEY, type SectionResult } from './config.ts';
import { DisposableStore, toDisposable, type Disposable } from './disposable.ts';
import { loadEntry } from './entry-load.ts';
import { compileSchema } from './json-schema.ts';
import type { AskDialog, ContractName, ContractType, DocumentChange, DocumentInfo, DocumentInit, HttpServer, Major, PluginOs, PluginPermissions, PtyExit, PtyHandle, Remote, SecretValue, ServeRequest, ServeResponse, ViewChannel, ModalInit } from '@cyborg-harness/contracts';
import { CoreError, errorMessage } from './errors.ts';
import type { PluginManifest } from './manifest.ts';
import type { CommandHandler, PluginContext, PluginModule, PluginSection } from './plugin.ts';
import { ContractRegistry, type ContractImpl } from './registry.ts';
import { Endpoint, type Owner, type Port } from './rpc.ts';
import { captureOutput } from './host-output.ts';
import { LOG_LEVELS } from './log-text.ts';
import { BACKLOG_LIMIT, Tail } from './pty-tail.ts';
import type { PtyWire } from './pty-types.ts';
import { isRecord, own } from './wire.ts';

/** Описание отданного контракта на проводе: данные как есть, методы - только именами. */
export interface ContractDescriptor {
  readonly pluginId: string;
  readonly contract: string;
  readonly version: string;
  readonly data: Record<string, unknown>;
  readonly methods: readonly string[];
}

export interface SectionInput {
  readonly version: number;
  readonly layers: readonly (readonly [string, unknown])[];
  /** Схема из файла манифеста; ядро уже проверило, что она разбирается. */
  readonly schema?: unknown;
}

export type ActivateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'config' | 'state'; readonly result: SectionResult };

export type Importer = (entry: string) => Promise<PluginModule>;

interface Loaded {
  readonly store: DisposableStore;
  readonly provided: Map<string, ContractImpl>;
  readonly commands: Map<string, CommandHandler>;
  /** Подписки, которые плагин держит как поставщик: номер ядра -> снятие. */
  readonly served: Map<number, Disposable>;
}

/** Колбэк на проводе: у потребителя - его номер в хосте, у поставщика - номер аргумента. */
export const CALLBACK = '$cyborg.callback';
/** Ответ поставщика на вызов с колбэками: подписка открыта, снимает её ядро. */
export const SUBSCRIPTION = '$cyborg.subscription';

export function marker(value: unknown, key: string): unknown {
  return isRecord(value) && Object.keys(value).length === 1 ? value[key] : undefined;
}

const isDisposable = (value: unknown): value is Disposable => isRecord(value) && typeof value.dispose === 'function';

export const handleKey = (pluginId: string, contract: string, version: string): string => `${pluginId}|${contract}|${version}`;

export interface OsPaths {
  readonly data: string;
  readonly temp: string;
  readonly home: string;
}

/** Слушатели pty в хосте; вывод, пришедший до первого onData, копится - иначе первые байты ушли бы мимо подписки. */
class HostPtys {
  readonly #items = new Map<string, { data: Set<(c: string) => void>; exit: Set<(e: PtyExit) => void>; early: Tail; exited?: PtyExit }>();

  #key = (pluginId: string, id: string) => `${pluginId}\0${id}`;

  open(endpoint: Endpoint, pluginId: string, wire: PtyWire): PtyHandle {
    // Вывод до подписки копится тем же хвостом, что держит ядро: без предела `yes` в pty съел бы память хоста.
    const item = { data: new Set<(c: string) => void>(), exit: new Set<(e: PtyExit) => void>(), early: new Tail(BACKLOG_LIMIT), ...(wire.exit && { exited: wire.exit }) };
    if (!wire.exit) this.#items.set(this.#key(pluginId, wire.id), item);
    const call =
      (method: string) =>
      (...args: unknown[]): Promise<undefined> =>
        endpoint.request<undefined>('os', { pluginId, method, args: [wire.id, ...args] });
    return Object.freeze({
      ...wire,
      onData: (listener: (c: string) => void) => {
        item.data.add(listener);
        const early = item.early.take();
        if (early) listener(early);
        return toDisposable(() => item.data.delete(listener));
      },
      onExit: (listener: (e: PtyExit) => void) => {
        const exited = item.exited;
        if (exited) queueMicrotask(() => listener(exited));
        else item.exit.add(listener);
        return toDisposable(() => item.exit.delete(listener));
      },
      write: call('pty.write'),
      resize: call('pty.resize'),
      kill: call('pty.kill'),
      share: () => endpoint.request<string>('os', { pluginId, method: 'pty.share', args: [wire.id] }),
    });
  }

  data(p: { pluginId: string; id: string; data: string }): void {
    const item = this.#items.get(this.#key(p.pluginId, p.id));
    if (!item) return;
    if (item.data.size === 0) item.early.push(p.data);
    for (const l of item.data) l(p.data);
  }

  exit(p: { pluginId: string; id: string; exit: PtyExit }): void {
    const key = this.#key(p.pluginId, p.id);
    const item = this.#items.get(key);
    if (!item) return;
    this.#items.delete(key);
    item.exited = p.exit;
    for (const l of item.exit) l(p.exit);
  }

  forget(pluginId: string): void {
    for (const key of [...this.#items.keys()]) if (key.startsWith(`${pluginId}\0`)) this.#items.delete(key);
  }
}

/** Слушатели `fs.watch` в хосте: id даёт хост, чтобы событие, пришедшее раньше ответа ядра, нашло слушателя. */
class HostWatches {
  readonly #items = new Map<string, { readonly listener: (names: readonly string[]) => void; readonly onClose: ((reason: string) => void) | undefined }>();
  #seq = 0;

  async watch(endpoint: Endpoint, pluginId: string, target: unknown, listener: (names: readonly string[]) => void, onClose?: (reason: string) => void): Promise<Disposable> {
    if (typeof listener !== 'function') throw new CoreError('Invalid', `${pluginId}: fs.watch ждёт слушателя`);
    const id = `w${String(++this.#seq)}`;
    const key = `${pluginId}\0${id}`;
    this.#items.set(key, { listener, onClose: typeof onClose === 'function' ? onClose : undefined });
    try {
      await endpoint.request('os', { pluginId, method: 'fs.watch', args: [target, id] });
    } catch (error) {
      this.#items.delete(key);
      throw error;
    }
    return toDisposable(() => {
      if (this.#items.delete(key)) void endpoint.request('os', { pluginId, method: 'fs.unwatch', args: [id] }).catch(() => undefined);
    });
  }

  change(endpoint: Endpoint, p: { pluginId: string; id: string; names: string[]; closed?: unknown }): void {
    const key = `${p.pluginId}\0${p.id}`;
    const item = this.#items.get(key);
    if (!item) return;
    try {
      if (typeof p.closed !== 'string') item.listener(p.names);
      else {
        this.#items.delete(key);
        item.onClose?.(p.closed);
      }
    } catch (error) {
      endpoint.notify('log', { pluginId: p.pluginId, message: `слушатель fs.watch упал: ${error instanceof Error ? error.message : String(error)}`, level: 'error' });
    }
  }

  forget(pluginId: string): void {
    for (const key of [...this.#items.keys()]) if (key.startsWith(`${pluginId}\0`)) this.#items.delete(key);
  }
}

/** Обработчики `serve.http` в хосте: запрос от ядра находит свой по id сервера. */
class HostServes {
  readonly #items = new Map<string, (request: ServeRequest) => ServeResponse | Promise<ServeResponse>>();
  #seq = 0;

  async open(endpoint: Endpoint, pluginId: string, handler: (request: ServeRequest) => ServeResponse | Promise<ServeResponse>): Promise<HttpServer> {
    if (typeof handler !== 'function') throw new CoreError('Invalid', `${pluginId}: serve.http ждёт обработчика`);
    const id = `h${String(++this.#seq)}`;
    const key = `${pluginId}\0${id}`;
    this.#items.set(key, handler);
    let url: string;
    try {
      url = await endpoint.request<string>('os', { pluginId, method: 'serve.http', args: [id] });
    } catch (error) {
      this.#items.delete(key);
      throw error;
    }
    return Object.freeze({
      url,
      dispose: () => {
        if (this.#items.delete(key)) void endpoint.request('os', { pluginId, method: 'serve.close', args: [id] }).catch(() => undefined);
      },
    });
  }

  request(p: { pluginId: string; id: string; request: ServeRequest }): ServeResponse | Promise<ServeResponse> {
    const handler = this.#items.get(`${p.pluginId}\0${p.id}`);
    if (!handler) throw new CoreError('NotFound', `${p.pluginId}: сервера ${p.id} нет`);
    return handler(p.request);
  }

  forget(pluginId: string): void {
    for (const key of [...this.#items.keys()]) if (key.startsWith(`${pluginId}\0`)) this.#items.delete(key);
  }
}

export type SystemEvent = { readonly kind: 'focus'; readonly focused: boolean } | { readonly kind: 'suspend' | 'resume' | 'screen-lock' };

type Listener = (value?: boolean | string) => unknown;

interface ViewListener {
  readonly pluginId: string;
  readonly view: string;
  readonly fn: (message: unknown) => unknown;
}

/** Слушатели событий окна и ОС всех плагинов хоста; ядро шлёт событие хосту один раз. */
class HostSystem {
  readonly #listeners = new Set<{ pluginId: string; kind: string; fn: Listener }>();
  readonly #idle = new Map<string, () => void>();
  readonly #views = new Set<ViewListener>();
  readonly endpoint: Endpoint;
  readonly #running: Running;
  #seq = 0;

  constructor(endpoint: Endpoint, running: Running) {
    this.endpoint = endpoint;
    this.#running = running;
  }

  on(pluginId: string, kind: string, fn: Listener): Disposable {
    const item = { pluginId, kind, fn };
    this.#listeners.add(item);
    return toDisposable(() => this.#listeners.delete(item));
  }

  /** Слушатель канала «главная часть - вид» (`ctx.views.channel(view).onMessage`). */
  onView(pluginId: string, view: string, fn: (message: unknown) => unknown): Disposable {
    const item = { pluginId, view, fn };
    this.#views.add(item);
    return toDisposable(() => this.#views.delete(item));
  }

  /** Сообщение вида: только слушателям канала этого плагина с этим именем вида. */
  viewMessage(p: { readonly pluginId: string; readonly view: string; readonly message: unknown }): void {
    for (const l of [...this.#views]) if (l.pluginId === p.pluginId && l.view === p.view) this.#safely(l.pluginId, `канала ${p.view}`, () => l.fn(p.message));
  }

  onIdle(pluginId: string, seconds: number, fn: () => void): Disposable {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new CoreError('Invalid', `${pluginId}: onIdle ждёт секунды больше нуля, получено ${String(seconds)}`);
    const id = `${pluginId}#${++this.#seq}`;
    this.#idle.set(id, fn);
    this.endpoint.notify('idle.watch', { pluginId, id, seconds });
    return toDisposable(() => {
      if (this.#idle.delete(id)) this.endpoint.notify('idle.unwatch', { pluginId, id });
    });
  }

  dispatch(event: SystemEvent | { readonly kind: 'idle'; readonly id: string }): void {
    if (event.kind === 'idle') {
      const fn = this.#idle.get(event.id);
      if (fn) this.#safely(event.id.slice(0, event.id.lastIndexOf('#')), 'onIdle', fn);
      return;
    }
    for (const l of [...this.#listeners]) {
      if (l.kind !== event.kind) continue;
      this.#safely(l.pluginId, event.kind, () => l.fn(event.kind === 'focus' ? event.focused : undefined));
    }
  }

  async beforeQuit(): Promise<void> {
    const quitting = [...this.#listeners].filter((l) => l.kind === 'quit');
    await Promise.allSettled(quitting.map(async (l) => {
      try {
        await this.#running.run(l.pluginId, l.fn);
      } catch (error) {
        this.#log(l.pluginId, 'onBeforeQuit', error);
      }
    }));
  }

  /** Документ закрыл человек: событие только его владельцу. */
  documentClosed(p: { readonly pluginId: string; readonly id: string }): void {
    for (const l of [...this.#listeners]) if (l.kind === 'document-closed' && l.pluginId === p.pluginId) this.#safely(l.pluginId, 'documents.onClose', () => l.fn(p.id));
  }

  forget(pluginId: string): void {
    for (const l of [...this.#listeners]) if (l.pluginId === pluginId) this.#listeners.delete(l);
    for (const l of [...this.#views]) if (l.pluginId === pluginId) this.#views.delete(l);
    for (const id of [...this.#idle.keys()]) if (id.startsWith(`${pluginId}#`)) this.#idle.delete(id);
  }

  #safely(pluginId: string, what: string, fn: () => unknown): void {
    try {
      const r = this.#running.run(pluginId, fn);
      if (r instanceof Promise) r.catch((error: unknown) => this.#log(pluginId, what, error));
    } catch (error) {
      this.#log(pluginId, what, error);
    }
  }

  #log(pluginId: string, what: string, error: unknown): void {
    this.endpoint.notify('log', { pluginId, message: `слушатель ${what} упал: ${error instanceof Error ? error.message : String(error)}`, level: 'error' });
  }
}

/** `ctx.os` по правам манифеста: нет права - нет члена; проверяет всё равно шлюз ядра, здесь только форма. */
function osOf(endpoint: Endpoint, pluginId: string, p: PluginPermissions, paths: OsPaths, ptys: HostPtys, watches: HostWatches, serves: HostServes): PluginOs {
  const call =
    <R>(method: string) =>
    (...args: unknown[]): Promise<R> =>
      endpoint.request<R>('os', { pluginId, method, args });
  const opens = p.shell ?? [];
  const schemes = opens.filter((v) => v.endsWith(':') && !v.startsWith('/') && !v.startsWith('~'));
  const shell = opens.length > 0 && {
    ...(opens.length > schemes.length && { openPath: call<undefined>('shell.openPath') }),
    ...(schemes.length > 0 && { openExternal: call<undefined>('shell.openExternal') }),
  };
  const clipboard = p.clipboard && {
    ...(p.clipboard.includes('read') && { readText: call<string>('clipboard.readText') }),
    ...(p.clipboard.includes('write') && { writeText: call<undefined>('clipboard.writeText') }),
  };
  return Object.freeze({
    paths: Object.freeze({ ...paths }),
    fs: Object.freeze({
      readText: call('fs.readText'),
      list: call('fs.list'),
      stat: call('fs.stat'),
      realpath: call('fs.realpath'),
      readSlice: call('fs.readSlice'),
      watch: (target: string, listener: (names: readonly string[]) => void, onClose?: (reason: string) => void) => watches.watch(endpoint, pluginId, target, listener, onClose),
      writeText: call('fs.writeText'),
      mkdir: call('fs.mkdir'),
      remove: call('fs.remove'),
    }),
    secrets: Object.freeze({ get: call('secrets.get'), set: call('secrets.set'), delete: call('secrets.delete') }),
    ...(p.process && {
      process: Object.freeze({
        run(program: string, args: readonly string[], options?: { signal?: AbortSignal }) {
          // Сигнал не переживает structuredClone: отмена едет сообщением cancel, ядро завершает программу и её группу.
          const { signal, ...rest } = options ?? {};
          return endpoint.request('os', { pluginId, method: 'process.run', args: options === undefined ? [program, args] : [program, args, rest] }, signal);
        },
      }),
    }),
    ...(p.pty && {
      pty: Object.freeze({
        spawn: async (options: unknown) => ptys.open(endpoint, pluginId, await call<PtyWire>('pty.spawn')(options)),
        list: call('pty.list'),
        attach: async (id: string) => ptys.open(endpoint, pluginId, await call<PtyWire>('pty.attach')(id)),
      }),
    }),
    ...(p.net && { net: Object.freeze({ fetch: call('net.fetch') }) }),
    ...(p.serve && { serve: Object.freeze({ http: (handler: (request: ServeRequest) => ServeResponse | Promise<ServeResponse>) => serves.open(endpoint, pluginId, handler) }) }),
    ...(p.env && { env: Object.freeze({ get: call('env.get') }) }),
    ...(p.notify && { notify: Object.freeze({ show: call<string>('notify.show'), close: call<undefined>('notify.close') }) }),
    ...(clipboard && { clipboard: Object.freeze(clipboard) }),
    ...(p['security.roots'] && { security: Object.freeze({ setRoots: call('security.setRoots') }) }),
    ...(shell && { shell: Object.freeze(shell) }),
    dialog: Object.freeze({ open: call<string[]>('dialog.open') }),
    ...(p['ui.lock'] && {
      ui: Object.freeze({
        lock: async (options?: { hideNotifications?: boolean }) => {
          await call('ui.lock')({ hideNotifications: options?.hideNotifications === true });
          return Object.freeze({ release: () => call<undefined>('ui.unlock')() });
        },
      }),
    }),
  }) as PluginOs;
}

/** Чей код выполняет хост: ядро узнаёт о смене до входа в код, поэтому зависший хост успел назвать виновника. */
class Running implements Owner {
  #endpoint: Endpoint | undefined;
  #current: string | undefined;
  #reported: string | undefined;
  #sent = 0;
  // Последний вошедший не годится в виновники ошибки: продолжение чужой цепочки идёт после него, а хранилище несёт имя вдоль цепочки.
  readonly #chain = new AsyncLocalStorage<string>();
  // Обработчик исключения видит хранилище уже снятым, а после queueMicrotask в Electron - пустым: имя остаётся на самой ошибке.
  readonly #thrown = new WeakMap<object, string>();

  bind(endpoint: Endpoint): void {
    this.#endpoint = endpoint;
  }

  current(): string | undefined {
    return this.#chain.getStore() ?? this.#current;
  }

  /** Колбэк, заведённый сейчас, пойдёт в той же цепочке; заведённый вне цепочки лишь отметится для сторожа зависаний, вины не неся. */
  schedule<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const chain = this.#chain.getStore();
    if (chain !== undefined) return this.as(chain, fn);
    const last = this.#current;
    if (last === undefined) return fn;
    return (...args) => {
      this.enter(last);
      return fn(...args);
    };
  }

  /** Плагин, с чьего входа началась цепочка, бросившая или отклонившая `error`; ошибка кода самого хоста ничья. */
  blame(error?: unknown): string | undefined {
    return (isObject(error) ? this.#thrown.get(error) : undefined) ?? this.#chain.getStore();
  }

  enter(pluginId: string | undefined): void {
    this.#current = pluginId;
    if (pluginId === undefined || pluginId === this.#reported) return;
    this.#reported = pluginId;
    this.#sent++;
    this.#endpoint?.notify('running', { pluginId });
  }

  run<R>(pluginId: string, fn: () => R): R {
    this.enter(pluginId);
    try {
      return this.#chain.run(pluginId, fn);
    } catch (error) {
      if (isObject(error) && !this.#thrown.has(error)) this.#thrown.set(error, pluginId);
      throw error;
    }
  }

  as<A extends unknown[], R>(pluginId: string, fn: (...args: A) => R): (...args: A) => R {
    return (...args) => this.run(pluginId, () => fn(...args));
  }

  // Ответ на пинг стирает отметку в ядре: первый вход после него называет себя заново.
  // Число уже посланных `running` ядро сверяет со своим счётом: уведомление, обогнавшее ответ на пинг, отметку не стирает.
  answered(): number {
    this.#reported = undefined;
    return this.#sent;
  }
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Таймеры и микрозадачи процесса хоста помнят, чей код их завёл: зависший или упавший колбэк иначе остался бы без имени. */
function attributeTimers(running: Running): void {
  for (const name of ['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const) {
    const original = globalThis[name] as (fn: unknown, ...rest: unknown[]) => unknown;
    const patched = (fn: unknown, ...rest: unknown[]) => {
      return original(typeof fn === 'function' ? running.schedule(fn as (...args: unknown[]) => unknown) : fn, ...rest);
    };
    // Свойства оригинала (util.promisify.custom) переносятся: promisify(setTimeout) должен работать как прежде.
    Object.defineProperties(patched, Object.getOwnPropertyDescriptors(original));
    Object.assign(globalThis, { [name]: patched });
  }
}

/** Отклонение плагина хост держит и называет ядру; исключение и ничейное отклонение завершают процесс, назвав виновника. */
function attributeFailures(running: Running, endpoint: Endpoint): void {
  let fatal: { readonly pluginId: string | undefined } | undefined;
  process.on('unhandledRejection', (reason) => {
    const pluginId = running.blame(reason);
    // Ничейное отклонение - сбой самого хоста: процесс завершается, как без обработчика.
    if (pluginId === undefined) throw reason;
    endpoint.notify('rejected', { pluginId, error: errorMessage(reason) });
  });
  process.on('uncaughtExceptionMonitor', (error) => {
    fatal = { pluginId: running.blame(error) };
  });
  // exit приходит от process.exit и необработанного исключения, но не от сигнала: убийство снаружи плагину не вменяется.
  process.on('exit', () => {
    const pluginId = fatal ? fatal.pluginId : running.blame();
    if (pluginId !== undefined) endpoint.notify('exiting', { pluginId });
  });
}

export interface HostOptions {
  /** Процесс принадлежит хосту: подменить его таймеры и назвать ядру плагин, чей код завершает процесс или не обработал отклонение промиса. Не для хоста внутри ядра. */
  readonly ownsProcess?: boolean;
}

/** Среда хоста: плагины видят только ctx, всё остальное - сообщения в ядро. */
export function runHost(port: Port, importer: Importer, options: HostOptions = {}): Endpoint {
  const running = new Running();
  const endpoint = new Endpoint(port, running);
  running.bind(endpoint);
  if (options.ownsProcess) {
    attributeTimers(running);
    attributeFailures(running, endpoint);
    captureOutput(process, console, () => running.blame(), (note) => endpoint.notify('output', note));
  }
  let manifests = new Map<string, PluginManifest>();
  let mirror: ContractRegistry | undefined;
  const plugins = new Map<string, Loaded>();
  const reloaders = new Map<string, (layers: SectionInput['layers']) => Promise<SectionResult>>();
  const proxies = new Proxies(endpoint, (caller) => plugins.get(caller)?.store, running);
  const to =
    <P extends { pluginId: string }, R>(fn: (p: P, signal: AbortSignal) => R) =>
    (p: P, signal: AbortSignal): R =>
      running.run(p.pluginId, () => fn(p, signal));
  const ptys = new HostPtys();
  endpoint.handle('pty.data', to((p: { pluginId: string; id: string; data: string }) => ptys.data(p)));
  endpoint.handle('pty.exit', to((p: { pluginId: string; id: string; exit: PtyExit }) => ptys.exit(p)));
  const watches = new HostWatches();
  endpoint.handle('fs.change', to((p: { pluginId: string; id: string; names: string[]; closed?: unknown }) => watches.change(endpoint, p)));
  const serves = new HostServes();
  endpoint.handle('serve.request', to((p: { pluginId: string; id: string; request: ServeRequest }) => serves.request(p)));
  const system = new HostSystem(endpoint, running);
  endpoint.handle('system', (event: SystemEvent | { kind: 'idle'; id: string }) => system.dispatch(event));
  endpoint.handle('system.beforeQuit', () => system.beforeQuit());
  endpoint.handle('document.closed', (p: { pluginId: string; id: string }) => system.documentClosed(p));
  endpoint.handle('view.message', (p: { pluginId: string; view: string; message: unknown }) => system.viewMessage(p));

  endpoint.handle('ping', () => running.answered());

  endpoint.handle('init', (p: { manifests: PluginManifest[]; bindings: [string, [string, string][]][] }) => {
    manifests = new Map(p.manifests.map((m) => [m.id, m]));
    mirror = new ContractRegistry(p.manifests, new Map(p.bindings.map(([id, b]) => [id, new Map(b)])));
  });

  endpoint.handle('contracts', (p: { contract: string; providers: ContractDescriptor[] }) => {
    mirror?.replace(
      p.contract,
      p.providers.map((d) => ({ pluginId: d.pluginId, version: d.version, impl: proxies.template(d) })),
    );
  });

  endpoint.handle('activate', (p: { pluginId: string; entry: string; paths: OsPaths; config?: SectionInput; state?: SectionInput }) => running.run(p.pluginId, async () => {
    const manifest = manifests.get(p.pluginId);
    if (!manifest || !mirror) throw new CoreError('Remote', `хост не знает плагин ${p.pluginId}`);
    const module = await loadEntry(importer, p.entry);
    running.enter(p.pluginId);
    const loaded: Loaded = { store: new DisposableStore(), provided: new Map(), commands: new Map(), served: new Map() };
    loaded.store.add(toDisposable(() => [...loaded.served.values()].forEach((d) => d.dispose())));
    const config = await section(endpoint, p.pluginId, 'config', module, p.config);
    if (config && 'failed' in config) return { ok: false, kind: 'config', result: config.failed } satisfies ActivateResult;
    const state = await section(endpoint, p.pluginId, 'state', module, p.state);
    if (state && 'failed' in state) return { ok: false, kind: 'state', result: state.failed } satisfies ActivateResult;

    plugins.set(p.pluginId, loaded);
    for (const [kind, s] of [['config', config], ['state', state]] as const) {
      if (!s) continue;
      reloaders.set(`${p.pluginId}/${kind}`, s.reload);
      loaded.store.add(toDisposable(() => reloaders.delete(`${p.pluginId}/${kind}`)));
    }
    try {
      running.enter(p.pluginId);
      const result = await module.activate(context(endpoint, proxies, running, manifest, mirror, loaded, p.paths, config?.handle, state?.handle, ptys, system, watches, serves));
      if (result) loaded.store.add(result);
      return { ok: true } satisfies ActivateResult;
    } catch (error) {
      plugins.delete(p.pluginId);
      loaded.store.dispose();
      throw error;
    }
  }));

  endpoint.handle('section.reload', to((p: { pluginId: string; kind: 'config' | 'state'; layers: SectionInput['layers'] }) => {
    const reload = reloaders.get(`${p.pluginId}/${p.kind}`);
    if (!reload) throw new CoreError('Unavailable', `${p.pluginId}: раздела ${p.kind} нет`);
    return reload(p.layers);
  }));

  endpoint.handle('deactivate', to((p: { pluginId: string }) => {
    const loaded = plugins.get(p.pluginId);
    plugins.delete(p.pluginId);
    ptys.forget(p.pluginId);
    watches.forget(p.pluginId);
    serves.forget(p.pluginId);
    loaded?.store.dispose();
    system.forget(p.pluginId);
  }));

  endpoint.handle('call', to(async (p: { pluginId: string; contract: string; version: string; member: string; args: unknown[]; subscription?: number }, signal) => {
    const loaded = plugins.get(p.pluginId);
    const impl = loaded?.provided.get(handleKey(p.pluginId, p.contract, p.version));
    const member = impl?.[p.member];
    if (!loaded || typeof member !== 'function') throw new CoreError('Unavailable', `${p.contract}@${p.version}.${p.member} у ${p.pluginId} нет`);
    const subscription = p.subscription;
    // Метка сигнала на последнем месте становится сигналом запроса: он срабатывает по отмене вызывающего, по сроку и при закрытии канала.
    const given = withSignal(p.args, signal);
    if (subscription === undefined) return member.apply(impl, given) as unknown;

    let alive = true;
    signal.addEventListener('abort', () => (alive = false), { once: true });
    const args = given.map((arg) => {
      const index = marker(arg, CALLBACK);
      if (typeof index !== 'number') return arg;
      return (...values: unknown[]) => {
        if (alive) endpoint.notify('emit', { subscription, index, args: values });
      };
    });
    const result: unknown = await member.apply(impl, args);
    if (!isDisposable(result)) {
      alive = false;
      return result;
    }
    // Вызов отменён, пока поставщик готовил подписку: открытое снимается сразу, вызывающему оно не достанется.
    if (signal.aborted) {
      alive = false;
      result.dispose();
      throw signal.reason;
    }
    loaded.served.set(
      subscription,
      toDisposable(() => {
        alive = false;
        loaded.served.delete(subscription);
        result.dispose();
      }),
    );
    return { [SUBSCRIPTION]: subscription };
  }));

  endpoint.handle('release', (p: { subscription: number }) => {
    for (const [pluginId, loaded] of plugins) {
      const served = loaded.served.get(p.subscription);
      if (!served) continue;
      running.run(pluginId, () => served.dispose());
    }
  });

  endpoint.handle('callback', (p: { id: string; args: unknown[] }) => proxies.deliver(p.id, p.args));
  endpoint.handle('forget', (p: { ids: string[] }) => proxies.forget(p.ids));

  endpoint.handle('command', to((p: { pluginId: string; name: string; args: unknown[] }, signal) => {
    const handler = plugins.get(p.pluginId)?.commands.get(p.name);
    if (!handler) throw new CoreError('CommandNotFound', `команды ${p.name} нет`);
    return handler(...withSignal(p.args, signal));
  }));

  return endpoint;
}

/** Чужой контракт в хосте: в зеркале лежит заготовка, потребитель получает свою копию, и ядро видит в invoke, кто зовёт. */
class Proxies {
  readonly #endpoint: Endpoint;
  readonly #storeOf: (caller: string) => DisposableStore | undefined;
  readonly #running: Running;
  readonly #descriptors = new WeakMap<ContractImpl, ContractDescriptor>();
  // Своя копия на потребителя одна: плагин вправе сравнивать полученное из get по ссылке.
  readonly #bound = new WeakMap<ContractImpl, Map<string, ContractImpl>>();
  readonly #listeners = new Map<string, (...args: unknown[]) => unknown>();
  #seq = 0;

  constructor(endpoint: Endpoint, storeOf: (caller: string) => DisposableStore | undefined, running: Running) {
    this.#endpoint = endpoint;
    this.#storeOf = storeOf;
    this.#running = running;
  }

  template(d: ContractDescriptor): ContractImpl {
    const impl: ContractImpl = { ...d.data };
    this.#descriptors.set(impl, d);
    return impl;
  }

  forCaller(impl: ContractImpl, caller: string): ContractImpl {
    const d = this.#descriptors.get(impl);
    if (!d) return impl;
    const copies = this.#bound.get(impl) ?? new Map<string, ContractImpl>();
    this.#bound.set(impl, copies);
    let copy = copies.get(caller);
    if (!copy) {
      const made: Record<string, unknown> = { ...d.data };
      for (const member of d.methods) made[member] = (...args: unknown[]) => this.#invoke(d, caller, member, args);
      copy = made;
      copies.set(caller, copy);
    }
    return copy;
  }

  // Ответ слушателя отдаётся Endpoint: тот дождётся его и проглотит отказ, иначе отказ уронил бы процесс хоста.
  deliver(id: string, args: unknown[]): unknown {
    const listener = this.#listeners.get(id);
    if (!listener) return undefined;
    return this.#running.run(id.slice(0, id.lastIndexOf('#')), () => listener(...args));
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.#listeners.delete(id);
  }

  // Функция пересекает границу только аргументом верхнего уровня: вложенная упадёт на structuredClone, как и раньше.
  async #invoke(d: ContractDescriptor, caller: string, member: string, given: unknown[]): Promise<unknown> {
    const ids: string[] = [];
    // Сигнал отмены - последний аргумент: на провод уходит меткой, сама отмена едет сообщением cancel.
    const { args, signal } = splitSignal(given);
    const wire = args.map((arg) => {
      if (typeof arg !== 'function') return arg;
      const id = `${caller}#${++this.#seq}`;
      this.#listeners.set(id, arg as (...xs: unknown[]) => unknown);
      ids.push(id);
      return { [CALLBACK]: id };
    });
    let result: unknown;
    // Ответ, обогнавший отмену, мог открыть подписку: её снимает ядро по этому release.
    const discard = (late: unknown) => {
      const opened = marker(late, SUBSCRIPTION);
      if (typeof opened === 'number') this.#endpoint.notify('release', { caller, subscription: opened });
    };
    try {
      result = await this.#endpoint.request('invoke', { caller, pluginId: d.pluginId, contract: d.contract, version: d.version, member, args: wire }, signal, discard);
    } catch (error) {
      this.forget(ids);
      throw error;
    }
    const subscription = marker(result, SUBSCRIPTION);
    if (ids.length === 0 || typeof subscription !== 'number') {
      this.forget(ids);
      return result;
    }
    const handle = toDisposable(() => {
      this.forget(ids);
      this.#endpoint.notify('release', { caller, subscription });
    });
    this.#storeOf(caller)?.add(handle);
    return handle;
  }
}

function context(
  endpoint: Endpoint,
  proxies: Proxies,
  running: Running,
  manifest: PluginManifest,
  mirror: ContractRegistry,
  loaded: Loaded,
  paths: OsPaths,
  config: PluginSection | undefined,
  state: PluginSection | undefined,
  ptys: HostPtys,
  system: HostSystem,
  watches: HostWatches,
  serves: HostServes,
): PluginContext {
  const pluginId = manifest.id;
  const track = (d: Disposable) => {
    loaded.store.add(d);
    return d;
  };
  return {
    pluginId,
    subscriptions: loaded.store,
    log: (message, level = 'info') => {
      if (!LOG_LEVELS.includes(level)) throw new CoreError('Invalid', `${pluginId}: ctx.log ждёт уровень ${LOG_LEVELS.join(', ')}, получено ${JSON.stringify(level)}`);
      endpoint.notify('log', { pluginId, message, level });
    },
    os: osOf(endpoint, pluginId, manifest.permissions, paths, ptys, watches, serves),
    secrets: { resolve: (ref) => endpoint.request<SecretValue>('os', { pluginId, method: 'secrets.resolve', args: [ref] }) },
    window: Object.freeze({
      onFocusChange: (listener: (focused: boolean) => void) => track(system.on(pluginId, 'focus', (focused) => listener(focused === true))),
      setTitle: (segment: string | undefined) => endpoint.request<undefined>('os', { pluginId, method: 'window.title', args: segment === undefined ? [] : [segment] }),
    }),
    documents: Object.freeze({
      list: () => endpoint.request<DocumentInfo[]>('documents', { pluginId, method: 'list', args: [] }),
      open: (type: string, init: DocumentInit) => endpoint.request<string>('documents', { pluginId, method: 'open', args: [type, init] }),
      save: (id: string, change: DocumentChange) => endpoint.request<undefined>('documents', { pluginId, method: 'save', args: [id, change] }),
      close: (id: string) => endpoint.request<undefined>('documents', { pluginId, method: 'close', args: [id] }),
      onClose: (listener: (id: string) => void) => track(system.on(pluginId, 'document-closed', (id) => listener(String(id)))),
    }),
    views: Object.freeze({
      channel(view: string): ViewChannel {
        if (typeof view !== 'string') throw new CoreError('Invalid', `${pluginId}: канал вида - строка с именем из ui.views`);
        let closed = false;
        track(toDisposable(() => (closed = true)));
        return Object.freeze({
          post: async (message: unknown) => {
            if (closed) throw new CoreError('Unavailable', `${pluginId}: канал вида ${view} закрыт выгрузкой плагина`);
            await endpoint.request<undefined>('views', { pluginId, method: 'post', args: [view, message] });
          },
          onMessage: (listener: (message: unknown) => void) => track(system.onView(pluginId, view, listener)),
        });
      },
      modal: (view: string, init?: ModalInit) => endpoint.request('views', { pluginId, method: 'modal', args: [view, init] }),
    }),
    dialogs: Object.freeze({
      show: (spec: AskDialog) => endpoint.request<string | undefined>('dialogs', { pluginId, method: 'show', args: [spec] }),
    }),
    system: Object.freeze({
      onSuspend: (listener: () => void) => track(system.on(pluginId, 'suspend', listener)),
      onResume: (listener: () => void) => track(system.on(pluginId, 'resume', listener)),
      onScreenLock: (listener: () => void) => track(system.on(pluginId, 'screen-lock', listener)),
      onIdle: (seconds: number, listener: () => void) => track(system.onIdle(pluginId, seconds, listener)),
      onBeforeQuit: (listener: () => void | Promise<void>) => track(system.on(pluginId, 'quit', listener)),
    }),
    contracts: {
      provide(contract: string, version: string, impl: unknown) {
        if (typeof impl !== 'object' || impl === null) throw new CoreError('Invalid', `${pluginId}: реализация ${contract}@${version} не объект`);
        const key = handleKey(pluginId, contract, version);
        if (!own(manifest.provides, contract)?.includes(version)) {
          throw new CoreError('NotDeclared', `${pluginId}: контракт ${contract}@${version} не объявлен в provides`);
        }
        if (loaded.provided.has(key)) throw new CoreError('AlreadyProvided', `${pluginId}: ${contract}@${version} уже отдан`);
        const data: Record<string, unknown> = {};
        const methods: string[] = [];
        for (const [name, value] of Object.entries(impl)) {
          if (typeof value === 'function') methods.push(name);
          else data[name] = value;
        }
        const descriptor: ContractDescriptor = { pluginId, contract, version, data, methods };
        endpoint.notify('provide', descriptor);
        loaded.provided.set(key, impl as ContractImpl);
        return track(
          toDisposable(() => {
            loaded.provided.delete(key);
            endpoint.notify('unprovide', { pluginId, contract, version });
          }),
        );
      },
      get<K extends ContractName, M extends Major<K>>(contract: K, major: M) {
        const impl = mirror.get(pluginId, contract, major);
        // Тип обещан картой Contracts: ядро сверило имя, мажорную версию и имена методов, но не их сигнатуры.
        return (impl && proxies.forCaller(impl, pluginId)) as Remote<ContractType<K, M>> | undefined;
      },
      all<K extends ContractName, M extends Major<K>>(contract: K, major: M) {
        return mirror.all(pluginId, contract, major).map((p) => ({ ...p, impl: proxies.forCaller(p.impl, pluginId) as Remote<ContractType<K, M>> }));
      },
      onChange: (contract, listener) => track(mirror.onChange(pluginId, contract, running.as(pluginId, listener))),
    },
    commands: {
      register(name, handler) {
        if (!Object.hasOwn(manifest.commands, name)) throw new CoreError('NotDeclared', `${pluginId}: команда ${name} не объявлена в commands`);
        if (loaded.commands.has(name)) throw new CoreError('CommandConflict', `команда ${name} уже зарегистрирована`);
        loaded.commands.set(name, handler);
        endpoint.notify('register', { pluginId, name });
        return track(
          toDisposable(() => {
            loaded.commands.delete(name);
            endpoint.notify('unregister', { pluginId, name });
          }),
        );
      },
      run(name, ...given) {
        const { args, signal } = splitSignal(given);
        return endpoint.request('run', { caller: pluginId, name, args }, signal);
      },
    },
    keys: {
      async register(binding) {
        const reply = await endpoint.request<{ id: number; active: boolean; winner?: string }>('keys.register', {
          pluginId,
          key: binding.key,
          command: binding.command,
          args: binding.args ?? [],
          when: binding.when ?? {},
        });
        const registration = track(toDisposable(() => endpoint.notify('keys.unregister', { pluginId, id: reply.id })));
        return { dispose: () => registration.dispose(), active: reply.active, ...(reply.winner !== undefined && { winner: reply.winner }) };
      },
    },
    ...(config && { config: trackedSection(config, track) }),
    ...(state && { state: trackedSection(state, track) }),
  };
}

function trackedSection(section: PluginSection, track: (d: Disposable) => Disposable): PluginSection {
  return { ...section, onChange: (listener) => track(section.onChange(listener)) };
}

/** Миграция и проверка - код плагина, поэтому идут здесь; ядро только хранит слои. */
async function section(
  endpoint: Endpoint,
  pluginId: string,
  kind: 'config' | 'state',
  module: PluginModule,
  input: SectionInput | undefined,
): Promise<{ handle: PluginSection; reload: (layers: SectionInput['layers']) => Promise<SectionResult> } | { failed: SectionResult } | undefined> {
  if (!input) return undefined;
  const own = module[kind];
  const compiled = input.schema === undefined ? undefined : compileSchema(input.schema);
  if (compiled && !compiled.ok) return { failed: { status: 'invalid', errors: compiled.errors } };
  const check = compiled?.check;
  const spec = { ...own, version: input.version, ...(check && { validate: (v: Readonly<Record<string, unknown>>) => [...check(v), ...(own?.validate?.(v) ?? [])] }) };
  let raw = new Map(input.layers.map(([layer, value]) => [layer, value]));
  const order = input.layers.map(([layer]) => layer);
  const resolve = () => resolveSection(spec, order.map((l) => [l, raw.get(l)] as const));

  const first = resolve();
  if (first.result.status !== 'ok') return { failed: first.result };
  const write = (layer: string, data: Record<string, unknown>) =>
    endpoint.request('section.write', { pluginId, kind, layer, version: spec.version, data });
  for (const [layer, data] of first.layers) {
    if (!first.result.migrated.includes(layer)) continue;
    await write(layer, data);
    raw.set(layer, { ...data, [VERSION_KEY]: spec.version });
  }

  let value = first.result.value;
  const listeners = new Set<(value: Record<string, unknown>) => void>();
  return {
    // Правка файла извне: не прошла проверку - значение прежнее, ядро пишет отказ в журнал.
    reload: async (layers) => {
      const next = new Map(layers.map(([layer, v]) => [layer, v]));
      const resolved = resolveSection(spec, order.map((l) => [l, next.get(l)] as const));
      if (resolved.result.status !== 'ok') return resolved.result;
      for (const [layer, data] of resolved.layers) {
        if (!resolved.result.migrated.includes(layer)) continue;
        await write(layer, data);
        next.set(layer, { ...data, [VERSION_KEY]: spec.version });
      }
      raw = next;
      if (JSON.stringify(resolved.result.value) !== JSON.stringify(value)) {
        value = resolved.result.value;
        for (const listener of [...listeners]) listener(structuredClone(value));
      }
      return resolved.result;
    },
    handle: {
      result: first.result,
      get: () => structuredClone(value),
      async set(layer, data) {
        if (!order.includes(layer)) throw new Error(`слоя ${layer} нет`);
        const next = new Map(raw).set(layer, { ...data, [VERSION_KEY]: spec.version });
        const checked = resolveSection(spec, order.map((l) => [l, next.get(l)] as const)).result;
        if (checked.status !== 'ok') throw new Error(`раздел ${kind} ${pluginId}: ${JSON.stringify(checked)}`);
        await write(layer, data);
        // Пока шла запись, другой set мог сменить соседний слой: свой слой ложится поверх текущих, а не снимка до await.
        raw = new Map(raw).set(layer, { ...data, [VERSION_KEY]: spec.version });
        const merged = resolve().result;
        value = merged.status === 'ok' ? merged.value : checked.value;
        for (const listener of [...listeners]) listener(structuredClone(value));
        return structuredClone(value);
      },
      onChange(listener) {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    },
  };
}
