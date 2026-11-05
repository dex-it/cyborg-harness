import { resolveSection, VERSION_KEY, type SectionResult } from './config.ts';
import { DisposableStore, toDisposable, type Disposable } from './disposable.ts';
import type { ContractName, ContractType, Major, PluginOs, PluginPermissions, PtyExit, PtyHandle, Remote, SecretValue } from '@cyborg/contracts';
import { CoreError } from './errors.ts';
import type { PluginManifest } from './manifest.ts';
import type { CommandHandler, PluginContext, PluginModule, PluginSection } from './plugin.ts';
import { ContractRegistry, type ContractImpl } from './registry.ts';
import { Endpoint, type Port } from './rpc.ts';
import type { PtyWire } from './pty.ts';
import { isRecord } from './wire.ts';

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

/** `ctx.os` по правам манифеста: нет права - нет члена; проверяет всё равно шлюз ядра, здесь только форма. */
/** Слушатели pty в хосте; вывод, пришедший до первого onData, копится - иначе первые байты ушли бы мимо подписки. */
class HostPtys {
  readonly #items = new Map<string, { data: Set<(c: string) => void>; exit: Set<(e: PtyExit) => void>; early: string[]; exited?: PtyExit }>();

  #key = (pluginId: string, id: string) => `${pluginId}\0${id}`;

  open(endpoint: Endpoint, pluginId: string, wire: PtyWire): PtyHandle {
    const item = { data: new Set<(c: string) => void>(), exit: new Set<(e: PtyExit) => void>(), early: [] as string[], ...(wire.exit && { exited: wire.exit }) };
    if (!wire.exit) this.#items.set(this.#key(pluginId, wire.id), item);
    const call =
      (method: string) =>
      (...args: unknown[]): Promise<undefined> =>
        endpoint.request<undefined>('os', { pluginId, method, args: [wire.id, ...args] });
    return Object.freeze({
      ...wire,
      onData: (listener: (c: string) => void) => {
        item.data.add(listener);
        for (const chunk of item.early.splice(0)) listener(chunk);
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
  readonly #items = new Map<string, (names: readonly string[]) => void>();
  #seq = 0;

  async watch(endpoint: Endpoint, pluginId: string, target: unknown, listener: (names: readonly string[]) => void): Promise<Disposable> {
    if (typeof listener !== 'function') throw new CoreError('Invalid', `${pluginId}: fs.watch ждёт слушателя`);
    const id = `w${String(++this.#seq)}`;
    const key = `${pluginId}\0${id}`;
    this.#items.set(key, listener);
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

  change(endpoint: Endpoint, p: { pluginId: string; id: string; names: string[] }): void {
    const listener = this.#items.get(`${p.pluginId}\0${p.id}`);
    if (!listener) return;
    try {
      listener(p.names);
    } catch (error) {
      endpoint.notify('log', { pluginId: p.pluginId, message: `слушатель fs.watch упал: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  forget(pluginId: string): void {
    for (const key of [...this.#items.keys()]) if (key.startsWith(`${pluginId}\0`)) this.#items.delete(key);
  }
}

export type SystemEvent = { readonly kind: 'focus'; readonly focused: boolean } | { readonly kind: 'suspend' | 'resume' | 'screen-lock' };

type Listener = (focused?: boolean) => unknown;

/** Слушатели событий окна и ОС всех плагинов хоста; ядро шлёт событие хосту один раз. */
class HostSystem {
  readonly #listeners = new Set<{ pluginId: string; kind: string; fn: Listener }>();
  readonly #idle = new Map<string, () => void>();
  readonly endpoint: Endpoint;
  #seq = 0;

  constructor(endpoint: Endpoint) {
    this.endpoint = endpoint;
  }

  on(pluginId: string, kind: string, fn: Listener): Disposable {
    const item = { pluginId, kind, fn };
    this.#listeners.add(item);
    return toDisposable(() => this.#listeners.delete(item));
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
        await l.fn();
      } catch (error) {
        this.#log(l.pluginId, 'onBeforeQuit', error);
      }
    }));
  }

  forget(pluginId: string): void {
    for (const l of [...this.#listeners]) if (l.pluginId === pluginId) this.#listeners.delete(l);
    for (const id of [...this.#idle.keys()]) if (id.startsWith(`${pluginId}#`)) this.#idle.delete(id);
  }

  #safely(pluginId: string, what: string, fn: () => unknown): void {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((error: unknown) => this.#log(pluginId, what, error));
    } catch (error) {
      this.#log(pluginId, what, error);
    }
  }

  #log(pluginId: string, what: string, error: unknown): void {
    this.endpoint.notify('log', { pluginId, message: `слушатель ${what} упал: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function osOf(endpoint: Endpoint, pluginId: string, p: PluginPermissions, paths: OsPaths, ptys: HostPtys, watches: HostWatches): PluginOs {
  const call =
    <R>(method: string) =>
    (...args: unknown[]): Promise<R> =>
      endpoint.request<R>('os', { pluginId, method, args });
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
      readSlice: call('fs.readSlice'),
      watch: (target: string, listener: (names: readonly string[]) => void) => watches.watch(endpoint, pluginId, target, listener),
      writeText: call('fs.writeText'),
      mkdir: call('fs.mkdir'),
      remove: call('fs.remove'),
    }),
    secrets: Object.freeze({ get: call('secrets.get'), set: call('secrets.set'), delete: call('secrets.delete') }),
    ...(p.process && { process: Object.freeze({ run: call('process.run') }) }),
    ...(p.pty && {
      pty: Object.freeze({
        spawn: async (options: unknown) => ptys.open(endpoint, pluginId, await call<PtyWire>('pty.spawn')(options)),
        list: call('pty.list'),
        attach: async (id: string) => ptys.open(endpoint, pluginId, await call<PtyWire>('pty.attach')(id)),
      }),
    }),
    ...(p.net && { net: Object.freeze({ fetch: call('net.fetch') }) }),
    ...(p.env && { env: Object.freeze({ get: call('env.get') }) }),
    ...(p.notify && { notify: Object.freeze({ show: call('notify.show') }) }),
    ...(clipboard && { clipboard: Object.freeze(clipboard) }),
    ...(p['security.roots'] && { security: Object.freeze({ setRoots: call('security.setRoots') }) }),
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

/** Среда хоста: плагины видят только ctx, всё остальное - сообщения в ядро. */
export function runHost(port: Port, importer: Importer): Endpoint {
  const endpoint = new Endpoint(port);
  let manifests = new Map<string, PluginManifest>();
  let mirror: ContractRegistry | undefined;
  const plugins = new Map<string, Loaded>();
  const reloaders = new Map<string, (layers: SectionInput['layers']) => Promise<SectionResult>>();
  const proxies = new Proxies(endpoint, (caller) => plugins.get(caller)?.store);
  const ptys = new HostPtys();
  endpoint.handle('pty.data', (p: { pluginId: string; id: string; data: string }) => ptys.data(p));
  endpoint.handle('pty.exit', (p: { pluginId: string; id: string; exit: PtyExit }) => ptys.exit(p));
  const watches = new HostWatches();
  endpoint.handle('fs.change', (p: { pluginId: string; id: string; names: string[] }) => watches.change(endpoint, p));
  const system = new HostSystem(endpoint);
  endpoint.handle('system', (event: SystemEvent | { kind: 'idle'; id: string }) => system.dispatch(event));
  endpoint.handle('system.beforeQuit', () => system.beforeQuit());

  endpoint.handle('ping', () => true);

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

  endpoint.handle('activate', async (p: { pluginId: string; entry: string; paths: OsPaths; config?: SectionInput; state?: SectionInput }) => {
    const manifest = manifests.get(p.pluginId);
    if (!manifest || !mirror) throw new CoreError('Remote', `хост не знает плагин ${p.pluginId}`);
    const module = await importer(p.entry);
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
      const result = await module.activate(context(endpoint, proxies, manifest, mirror, loaded, p.paths, config?.handle, state?.handle, ptys, system, watches));
      if (result) loaded.store.add(result);
      return { ok: true } satisfies ActivateResult;
    } catch (error) {
      plugins.delete(p.pluginId);
      loaded.store.dispose();
      throw error;
    }
  });

  endpoint.handle('section.reload', (p: { pluginId: string; kind: 'config' | 'state'; layers: SectionInput['layers'] }) => {
    const reload = reloaders.get(`${p.pluginId}/${p.kind}`);
    if (!reload) throw new CoreError('Unavailable', `${p.pluginId}: раздела ${p.kind} нет`);
    return reload(p.layers);
  });

  endpoint.handle('deactivate', (p: { pluginId: string }) => {
    const loaded = plugins.get(p.pluginId);
    plugins.delete(p.pluginId);
    ptys.forget(p.pluginId);
    watches.forget(p.pluginId);
    loaded?.store.dispose();
    system.forget(p.pluginId);
  });

  endpoint.handle('call', async (p: { pluginId: string; contract: string; version: string; member: string; args: unknown[]; subscription?: number }) => {
    const loaded = plugins.get(p.pluginId);
    const impl = loaded?.provided.get(handleKey(p.pluginId, p.contract, p.version));
    const member = impl?.[p.member];
    if (!loaded || typeof member !== 'function') throw new CoreError('Unavailable', `${p.contract}@${p.version}.${p.member} у ${p.pluginId} нет`);
    const subscription = p.subscription;
    if (subscription === undefined) return member.apply(impl, p.args);

    let alive = true;
    const args = p.args.map((arg) => {
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
    loaded.served.set(
      subscription,
      toDisposable(() => {
        alive = false;
        loaded.served.delete(subscription);
        result.dispose();
      }),
    );
    return { [SUBSCRIPTION]: subscription };
  });

  endpoint.handle('release', (p: { subscription: number }) => {
    for (const loaded of plugins.values()) loaded.served.get(p.subscription)?.dispose();
  });

  endpoint.handle('callback', (p: { id: string; args: unknown[] }) => proxies.deliver(p.id, p.args));
  endpoint.handle('forget', (p: { ids: string[] }) => proxies.forget(p.ids));

  endpoint.handle('command', (p: { pluginId: string; name: string; args: unknown[] }) => {
    const handler = plugins.get(p.pluginId)?.commands.get(p.name);
    if (!handler) throw new CoreError('CommandNotFound', `команды ${p.name} нет`);
    return handler(...p.args);
  });

  return endpoint;
}

/** Чужой контракт в хосте: в зеркале лежит заготовка, потребитель получает свою копию, и ядро видит в invoke, кто зовёт. */
class Proxies {
  readonly #endpoint: Endpoint;
  readonly #storeOf: (caller: string) => DisposableStore | undefined;
  readonly #descriptors = new WeakMap<ContractImpl, ContractDescriptor>();
  // Своя копия на потребителя одна: плагин вправе сравнивать полученное из get по ссылке.
  readonly #bound = new WeakMap<ContractImpl, Map<string, ContractImpl>>();
  readonly #listeners = new Map<string, (...args: unknown[]) => unknown>();
  #seq = 0;

  constructor(endpoint: Endpoint, storeOf: (caller: string) => DisposableStore | undefined) {
    this.#endpoint = endpoint;
    this.#storeOf = storeOf;
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
    return this.#listeners.get(id)?.(...args);
  }

  forget(ids: readonly string[]): void {
    for (const id of ids) this.#listeners.delete(id);
  }

  // Функция пересекает границу только аргументом верхнего уровня: вложенная упадёт на structuredClone, как и раньше.
  async #invoke(d: ContractDescriptor, caller: string, member: string, args: unknown[]): Promise<unknown> {
    const ids: string[] = [];
    const wire = args.map((arg) => {
      if (typeof arg !== 'function') return arg;
      const id = `${caller}#${++this.#seq}`;
      this.#listeners.set(id, arg as (...xs: unknown[]) => unknown);
      ids.push(id);
      return { [CALLBACK]: id };
    });
    let result: unknown;
    try {
      result = await this.#endpoint.request('invoke', { caller, pluginId: d.pluginId, contract: d.contract, version: d.version, member, args: wire });
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
  manifest: PluginManifest,
  mirror: ContractRegistry,
  loaded: Loaded,
  paths: OsPaths,
  config: PluginSection | undefined,
  state: PluginSection | undefined,
  ptys: HostPtys,
  system: HostSystem,
  watches: HostWatches,
): PluginContext {
  const pluginId = manifest.id;
  const track = (d: Disposable) => {
    loaded.store.add(d);
    return d;
  };
  return {
    pluginId,
    subscriptions: loaded.store,
    log: (message) => endpoint.notify('log', { pluginId, message }),
    os: osOf(endpoint, pluginId, manifest.permissions, paths, ptys, watches),
    secrets: { resolve: (ref) => endpoint.request<SecretValue>('os', { pluginId, method: 'secrets.resolve', args: [ref] }) },
    window: Object.freeze({ onFocusChange: (listener: (focused: boolean) => void) => track(system.on(pluginId, 'focus', (focused) => listener(focused === true))) }),
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
        if (!manifest.provides[contract]?.includes(version)) {
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
      onChange: (contract, listener) => track(mirror.onChange(pluginId, contract, listener)),
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
      run: (name, ...args) => endpoint.request('run', { name, args }),
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
  const spec = { ...module[kind], version: input.version };
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
        raw = next;
        value = checked.value;
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
