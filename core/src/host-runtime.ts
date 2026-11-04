import { resolveSection, VERSION_KEY, type SectionResult } from './config.ts';
import { DisposableStore, toDisposable, type Disposable } from './disposable.ts';
import { CoreError } from './errors.ts';
import type { PluginManifest } from './manifest.ts';
import type { CommandHandler, PluginContext, PluginModule, PluginSection } from './plugin.ts';
import { ContractRegistry, type ContractImpl } from './registry.ts';
import { Endpoint, type Port } from './rpc.ts';

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
  readonly layers: ReadonlyArray<readonly [string, unknown]>;
}

export type ActivateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'config' | 'state'; readonly result: SectionResult };

export type Importer = (entry: string) => Promise<PluginModule>;

interface Loaded {
  readonly store: DisposableStore;
  readonly provided: Map<string, ContractImpl>;
  readonly commands: Map<string, CommandHandler>;
}

export const handleKey = (pluginId: string, contract: string, version: string) => `${pluginId}|${contract}|${version}`;

/** Среда хоста: плагины видят только ctx, всё остальное - сообщения в ядро. */
export function runHost(port: Port, importer: Importer): Endpoint {
  const endpoint = new Endpoint(port);
  let manifests = new Map<string, PluginManifest>();
  let mirror: ContractRegistry | undefined;
  const plugins = new Map<string, Loaded>();

  endpoint.handle('ping', () => true);

  endpoint.handle('init', (p: { manifests: PluginManifest[]; bindings: Array<[string, Array<[string, string]>]> }) => {
    manifests = new Map(p.manifests.map((m) => [m.id, m]));
    mirror = new ContractRegistry(p.manifests, new Map(p.bindings.map(([id, b]) => [id, new Map(b)])));
  });

  endpoint.handle('contracts', (p: { contract: string; providers: ContractDescriptor[] }) => {
    mirror?.replace(
      p.contract,
      p.providers.map((d) => ({ pluginId: d.pluginId, version: d.version, impl: proxy(endpoint, d) })),
    );
  });

  endpoint.handle('activate', async (p: { pluginId: string; entry: string; config?: SectionInput; state?: SectionInput }) => {
    const manifest = manifests.get(p.pluginId);
    if (!manifest || !mirror) throw new CoreError('Remote', `хост не знает плагин ${p.pluginId}`);
    const module = await importer(p.entry);
    const loaded: Loaded = { store: new DisposableStore(), provided: new Map(), commands: new Map() };
    const config = await section(endpoint, p.pluginId, 'config', module, p.config);
    if (config && 'failed' in config) return { ok: false, kind: 'config', result: config.failed } satisfies ActivateResult;
    const state = await section(endpoint, p.pluginId, 'state', module, p.state);
    if (state && 'failed' in state) return { ok: false, kind: 'state', result: state.failed } satisfies ActivateResult;

    plugins.set(p.pluginId, loaded);
    try {
      const result = await module.activate(context(endpoint, manifest, mirror, loaded, config?.handle, state?.handle));
      if (result) loaded.store.add(result);
      return { ok: true } satisfies ActivateResult;
    } catch (error) {
      plugins.delete(p.pluginId);
      loaded.store.dispose();
      throw error;
    }
  });

  endpoint.handle('deactivate', (p: { pluginId: string }) => {
    const loaded = plugins.get(p.pluginId);
    plugins.delete(p.pluginId);
    loaded?.store.dispose();
  });

  endpoint.handle('call', async (p: { pluginId: string; contract: string; version: string; member: string; args: unknown[] }) => {
    const impl = plugins.get(p.pluginId)?.provided.get(handleKey(p.pluginId, p.contract, p.version));
    const member = impl?.[p.member];
    if (typeof member !== 'function') throw new CoreError('Unavailable', `${p.contract}@${p.version}.${p.member} у ${p.pluginId} нет`);
    return member.apply(impl, p.args);
  });

  endpoint.handle('command', async (p: { pluginId: string; name: string; args: unknown[] }) => {
    const handler = plugins.get(p.pluginId)?.commands.get(p.name);
    if (!handler) throw new CoreError('CommandNotFound', `команды ${p.name} нет`);
    return handler(...p.args);
  });

  return endpoint;
}

function proxy(endpoint: Endpoint, d: ContractDescriptor): ContractImpl {
  const impl: Record<string, unknown> = { ...d.data };
  for (const member of d.methods) {
    impl[member] = (...args: unknown[]) =>
      endpoint.request('invoke', { pluginId: d.pluginId, contract: d.contract, version: d.version, member, args });
  }
  return impl;
}

function context(
  endpoint: Endpoint,
  manifest: PluginManifest,
  mirror: ContractRegistry,
  loaded: Loaded,
  config: PluginSection | undefined,
  state: PluginSection | undefined,
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
    contracts: {
      provide(contract, version, impl) {
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
        loaded.provided.set(key, impl);
        return track(
          toDisposable(() => {
            loaded.provided.delete(key);
            endpoint.notify('unprovide', { pluginId, contract, version });
          }),
        );
      },
      get: (contract) => mirror.get(pluginId, contract),
      all: (contract) => mirror.all(pluginId, contract),
      onChange: (contract, listener) => track(mirror.onChange(pluginId, contract, listener)),
    },
    commands: {
      register(name, handler) {
        if (!manifest.commands.includes(name)) throw new CoreError('NotDeclared', `${pluginId}: команда ${name} не объявлена в commands`);
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
): Promise<{ handle: PluginSection } | { failed: SectionResult } | undefined> {
  if (!input) return undefined;
  const spec = { ...module[kind], version: input.version };
  let raw = new Map(input.layers.map(([layer, value]) => [layer, value]));
  const order = input.layers.map(([layer]) => layer);
  const resolve = () => resolveSection(spec, order.map((l) => [l, raw.get(l)] as const));

  const first = resolve();
  if (first.result.status !== 'ok') return { failed: first.result };
  const write = (layer: string, data: Record<string, unknown>) =>
    endpoint.request('section.write', { pluginId, kind, layer, version: spec.version, data });
  for (const layer of first.result.migrated) {
    const data = first.layers.get(layer)!;
    await write(layer, data);
    raw.set(layer, { ...data, [VERSION_KEY]: spec.version });
  }

  let value = first.result.value;
  const listeners = new Set<(value: Record<string, unknown>) => void>();
  return {
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
