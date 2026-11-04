import type { SectionResult, SectionStore } from './config.ts';
import type { Disposable } from './disposable.ts';
import { CoreError } from './errors.ts';
import { providesMatching, resolveGraph, type ContractGraph, type Rejection } from './graph.ts';
import { handleKey, type ActivateResult, type ContractDescriptor, type SectionInput } from './host-runtime.ts';
import { parseManifest, type PluginManifest } from './manifest.ts';
import { ContractRegistry } from './registry.ts';
import { Endpoint } from './rpc.ts';
import type { HostHandle, SpawnHost } from './transports.ts';

export type JournalEntry =
  | { readonly pluginId: string; readonly kind: 'invalid'; readonly errors: readonly string[] }
  | { readonly pluginId: string; readonly kind: 'disabled' }
  | { readonly pluginId: string; readonly kind: 'not-found' }
  | { readonly pluginId: string; readonly kind: 'rejected'; readonly reasons: readonly Rejection[] }
  | { readonly pluginId: string; readonly kind: 'safe-mode' }
  | { readonly pluginId: string; readonly kind: 'skipped'; readonly reason: string }
  | { readonly pluginId: string; readonly kind: 'config' | 'state'; readonly result: SectionResult }
  | { readonly pluginId: string; readonly kind: 'failed'; readonly hostId: string; readonly error: string }
  | { readonly pluginId: string; readonly kind: 'activated'; readonly hostId: string; readonly ms: number }
  | { readonly pluginId: string; readonly kind: 'deactivated'; readonly error?: string }
  | { readonly pluginId: string; readonly kind: 'revived' }
  | {
      readonly pluginId: string;
      readonly kind: 'switched-off';
      readonly strikes: number;
      /** Активные плагины, которые брали его контракты. */
      readonly affects: readonly string[];
    }
  | {
      readonly pluginId?: undefined;
      readonly kind: 'host-down';
      readonly hostId: string;
      readonly reason: 'hang' | 'crash';
      readonly culprits: readonly string[];
      readonly plugins: readonly string[];
      /** Активные плагины других хостов, которые брали контракты снятых. */
      readonly affects: readonly string[];
    }
  | { readonly pluginId?: undefined; readonly kind: 'host-restart'; readonly hostId: string; readonly plugins: readonly string[] }
  | {
      readonly pluginId?: undefined;
      readonly kind: 'host-abandoned';
      readonly hostId: string;
      readonly failures: number;
      /** Остались выключенными до «Включить снова». */
      readonly plugins: readonly string[];
    };

export interface WatchdogOptions {
  /** Как часто пинговать хост, мс. */
  readonly interval?: number;
  /** Сколько ждать ответа на пинг, мс; дольше - хост завис. */
  readonly timeout?: number;
  /** Сколько сбоев подряд, после которых плагин выключается. */
  readonly strikes?: number;
}

export interface LoadOptions {
  readonly apiVersion: string;
  /** `plugins.enabled`: порядок не важен, порядок даёт граф. */
  readonly enabled: readonly string[];
  readonly manifests: readonly unknown[];
  readonly spawnHost: SpawnHost;
  /** Что хост передаст импортёру; по умолчанию id плагина. */
  readonly entry?: (manifest: PluginManifest) => string;
  /** `plugins.hosts`: группа -> плагины; не названный идёт в `builtin` или в свой хост по `host: "own"`. */
  readonly hosts?: Readonly<Record<string, readonly string[]>>;
  readonly config?: SectionStore;
  readonly state?: SectionStore;
  /** Окно без плагинов: манифесты разобраны, хосты не запускаются. */
  readonly safeMode?: boolean;
  readonly watchdog?: WatchdogOptions;
  readonly activationTimeout?: number;
  /** Граф решён, код плагинов ещё не запускался. */
  readonly onGraph?: (graph: ContractGraph) => void | Promise<void>;
  readonly onJournal?: (entry: JournalEntry) => void;
  readonly onLog?: (pluginId: string, message: string) => void;
}

export interface Kernel {
  readonly journal: readonly JournalEntry[];
  /** Активные сейчас, в порядке активации. */
  readonly active: readonly string[];
  /** Вид реестра из главного процесса: методы контрактов идут в хост поставщика. */
  readonly contracts: ContractRegistry;
  /** Разобранные манифесты, включённые и нет. */
  readonly manifests: readonly PluginManifest[];
  hostOf(pluginId: string): string | undefined;
  /** «Включить снова»: сбрасывает счёт сбоев, активирует плагин и его пропущенных потребителей. */
  revive(pluginId: string): Promise<void>;
  run(command: string, ...args: unknown[]): Promise<unknown>;
  /** Дожидается перезапусков хостов, начатых сторожем. */
  idle(): Promise<void>;
  /** Снимает плагины в обратном порядке активации и гасит хосты. */
  unload(): Promise<void>;
}

interface Host {
  readonly id: string;
  readonly handle: HostHandle;
  readonly endpoint: Endpoint;
  readonly inflight: Map<number, string>;
  seq: number;
  down: boolean;
  pingAt?: number;
  timer?: ReturnType<typeof setInterval>;
}

export async function load(options: LoadOptions): Promise<Kernel> {
  const journal: JournalEntry[] = [];
  const record = (entry: JournalEntry) => {
    journal.push(entry);
    options.onJournal?.(entry);
  };
  const enabled = new Set(options.enabled);
  const watchdog = { interval: 1000, timeout: 5000, strikes: 3, ...options.watchdog };
  const activationTimeout = options.activationTimeout ?? 10_000;

  const manifests: PluginManifest[] = [];
  const known: PluginManifest[] = [];
  for (const raw of options.manifests) {
    const parsed = parseManifest(raw);
    const id = parsed.ok ? parsed.manifest.id : parsed.id;
    if (parsed.ok) known.push(parsed.manifest);
    if (id !== undefined && !enabled.has(id)) record({ pluginId: id, kind: 'disabled' });
    else if (!parsed.ok) record({ pluginId: id ?? '?', kind: 'invalid', errors: parsed.errors });
    else manifests.push(parsed.manifest);
  }
  for (const id of enabled) {
    if (!manifests.some((m) => m.id === id) && !journal.some((e) => e.pluginId === id)) record({ pluginId: id, kind: 'not-found' });
  }

  const graph = resolveGraph(manifests, options.apiVersion);
  for (const [pluginId, reasons] of graph.rejected) record({ pluginId, kind: 'rejected', reasons });
  await options.onGraph?.(graph);

  const byId = new Map(manifests.map((m) => [m.id, m]));
  const wire = { manifests, bindings: [...graph.bindings].map(([id, b]) => [id, [...b]]) };
  const registry = new ContractRegistry(manifests, graph.bindings);
  const descriptors = new Map<string, ContractDescriptor[]>();
  const provided = new Map<string, Disposable>();
  const commandOwners = new Map<string, string>();
  const active: string[] = [];
  const hosts = new Map<string, Host>();
  const hostFailures = new Map<string, number>();
  const strikes = new Map<string, number>();
  const switchedOff = new Set<string>();
  let chain: Promise<void> = Promise.resolve();
  let unloading = false;

  const hostOf = (pluginId: string): string | undefined => {
    const m = byId.get(pluginId);
    if (!m) return undefined;
    for (const [hostId, ids] of Object.entries(options.hosts ?? {})) if (ids.includes(pluginId)) return hostId;
    return m.host === 'own' ? pluginId : 'builtin';
  };

  const broadcast = (contract: string) => {
    for (const host of hosts.values()) host.endpoint.notify('contracts', { contract, providers: descriptors.get(contract) ?? [] });
  };

  async function callHost<T>(host: Host, pluginId: string, method: string, params: unknown, timeout?: number): Promise<T> {
    const token = ++host.seq;
    host.inflight.set(token, pluginId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = host.endpoint.request<T>(method, params);
      if (timeout === undefined) return await call;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CoreError('Timeout', `${method} ${pluginId} дольше ${timeout} мс`)), timeout);
      });
      return await Promise.race([call, expired]);
    } finally {
      clearTimeout(timer);
      host.inflight.delete(token);
    }
  }

  function liveHost(pluginId: string): Host {
    const host = hosts.get(hostOf(pluginId) ?? '');
    if (!host || !active.includes(pluginId)) throw new CoreError('Unavailable', `${pluginId} не активен`);
    return host;
  }

  function dropProvided(key: string): void {
    const disposable = provided.get(key);
    if (!disposable) return;
    provided.delete(key);
    disposable.dispose();
    const [pluginId, contract, version] = key.split('|');
    descriptors.set(contract, (descriptors.get(contract) ?? []).filter((d) => d.pluginId !== pluginId || d.version !== version));
    broadcast(contract);
  }

  function dropPlugin(pluginId: string): void {
    for (const key of [...provided.keys()]) if (key.startsWith(`${pluginId}|`)) dropProvided(key);
    for (const [name, owner] of [...commandOwners]) if (owner === pluginId) commandOwners.delete(name);
    const i = active.indexOf(pluginId);
    if (i >= 0) active.splice(i, 1);
  }

  function affected(gone: readonly string[]): string[] {
    const uses = (consumer: PluginManifest, provider: PluginManifest) =>
      [...(graph.bindings.get(consumer.id)?.values() ?? [])].includes(provider.id) ||
      Object.entries(consumer.consumes).some(([contract, range]) => providesMatching(provider, contract, range));
    return active.filter((id) => !gone.includes(id) && gone.some((p) => uses(byId.get(id)!, byId.get(p)!)));
  }

  function startHost(hostId: string): Host {
    const handle = options.spawnHost(hostId);
    const host: Host = { id: hostId, handle, endpoint: new Endpoint(handle.port), inflight: new Map(), seq: 0, down: false };
    hosts.set(hostId, host);
    const own = (pluginId: string) => !host.down && hostOf(pluginId) === hostId;
    const { endpoint } = host;

    endpoint.handle('provide', (d: ContractDescriptor) => {
      if (!own(d.pluginId)) return;
      const impl: Record<string, unknown> = { ...d.data };
      for (const member of d.methods) {
        impl[member] = (...args: unknown[]) =>
          callHost(host, d.pluginId, 'call', { pluginId: d.pluginId, contract: d.contract, version: d.version, member, args });
      }
      provided.set(handleKey(d.pluginId, d.contract, d.version), registry.provide(d.pluginId, d.contract, d.version, impl));
      descriptors.set(d.contract, [...(descriptors.get(d.contract) ?? []), d]);
      broadcast(d.contract);
    });
    endpoint.handle('unprovide', (p: { pluginId: string; contract: string; version: string }) => {
      if (own(p.pluginId)) dropProvided(handleKey(p.pluginId, p.contract, p.version));
    });
    endpoint.handle('register', (p: { pluginId: string; name: string }) => {
      if (own(p.pluginId)) commandOwners.set(p.name, p.pluginId);
    });
    endpoint.handle('unregister', (p: { pluginId: string; name: string }) => {
      if (own(p.pluginId) && commandOwners.get(p.name) === p.pluginId) commandOwners.delete(p.name);
    });
    endpoint.handle('invoke', (p: { pluginId: string; contract: string; version: string; member: string; args: unknown[] }) =>
      callHost(liveHost(p.pluginId), p.pluginId, 'call', p),
    );
    endpoint.handle('run', (p: { name: string; args: unknown[] }) => run(p.name, ...p.args));
    endpoint.handle('section.write', async (p: { pluginId: string; kind: 'config' | 'state'; layer: string; version: number; data: Record<string, unknown> }) => {
      if (!own(p.pluginId)) throw new CoreError('Unavailable', `${p.pluginId} не в этом хосте`);
      await options[p.kind]?.write(p.layer, p.pluginId, p.version, p.data);
    });
    endpoint.handle('log', (p: { pluginId: string; message: string }) => {
      if (own(p.pluginId)) options.onLog?.(p.pluginId, p.message);
    });

    handle.onExit(() => hostDown(host, 'crash'));
    endpoint.request('init', wire).catch(() => {});
    for (const contract of descriptors.keys()) endpoint.notify('contracts', { contract, providers: descriptors.get(contract) });

    host.timer = setInterval(() => {
      if (host.down) return;
      if (host.pingAt !== undefined) {
        if (performance.now() - host.pingAt > watchdog.timeout) hostDown(host, 'hang');
        return;
      }
      host.pingAt = performance.now();
      endpoint.request('ping', null).then(
        () => (host.pingAt = undefined),
        () => {},
      );
    }, watchdog.interval);
    host.timer.unref?.();
    return host;
  }

  function stopHost(host: Host, error: CoreError): void {
    host.down = true;
    clearInterval(host.timer);
    host.handle.kill();
    host.endpoint.close(error);
    if (hosts.get(host.id) === host) hosts.delete(host.id);
  }

  function hostDown(host: Host, reason: 'hang' | 'crash'): void {
    if (host.down) return;
    const culprits = [...new Set(host.inflight.values())];
    const victims = active.filter((id) => hostOf(id) === host.id);
    stopHost(host, new CoreError('HostGone', `хост ${host.id} ${reason === 'hang' ? 'завис' : 'упал'}`));
    if (unloading) return;
    record({ kind: 'host-down', hostId: host.id, reason, culprits, plugins: victims, affects: affected(victims) });
    for (const id of [...victims].reverse()) dropPlugin(id);

    for (const id of culprits) {
      const n = (strikes.get(id) ?? 0) + 1;
      strikes.set(id, n);
      if (n >= watchdog.strikes) {
        switchedOff.add(id);
        record({ pluginId: id, kind: 'switched-off', strikes: n, affects: affected([id]) });
      }
    }
    if (culprits.length === 0) {
      const failures = (hostFailures.get(host.id) ?? 0) + 1;
      hostFailures.set(host.id, failures);
      if (failures >= watchdog.strikes) {
        record({ kind: 'host-abandoned', hostId: host.id, failures, plugins: victims });
        return;
      }
    }

    const again = graph.order.filter((id) => hostOf(id) === host.id && !switchedOff.has(id) && (victims.includes(id) || culprits.includes(id)));
    if (again.length === 0) return;
    chain = chain.then(async () => {
      if (unloading) return;
      record({ kind: 'host-restart', hostId: host.id, plugins: again });
      for (const id of again) await activate(id);
    });
  }

  function sectionInput(kind: 'config' | 'state', m: PluginManifest): SectionInput | undefined {
    const declared = m[kind];
    const store = options[kind];
    return declared && store ? { version: declared.version, layers: store.raw(m.id) } : undefined;
  }

  async function activate(pluginId: string): Promise<void> {
    const m = byId.get(pluginId)!;
    const down = [...(graph.bindings.get(pluginId) ?? [])].find(([c, p]) => c in m.requires && !active.includes(p));
    if (down) {
      record({ pluginId, kind: 'skipped', reason: `поставщик ${down[0]} (${down[1]}) не активен` });
      return;
    }
    const hostId = hostOf(pluginId)!;
    const host = hosts.get(hostId) ?? startHost(hostId);
    const started = performance.now();
    try {
      const params = { pluginId, entry: options.entry?.(m) ?? pluginId, config: sectionInput('config', m), state: sectionInput('state', m) };
      const result = await callHost<ActivateResult>(host, pluginId, 'activate', params, activationTimeout);
      if (!result.ok) {
        record({ pluginId, kind: result.kind, result: result.result });
        return;
      }
      active.push(pluginId);
      record({ pluginId, kind: 'activated', hostId, ms: performance.now() - started });
    } catch (error) {
      if (host.down) return;
      dropPlugin(pluginId);
      if (error instanceof CoreError && error.code === 'Timeout') host.endpoint.request('deactivate', { pluginId }).catch(() => {});
      record({ pluginId, kind: 'failed', hostId, error: (error as Error).message });
    }
  }

  async function run(command: string, ...args: unknown[]): Promise<unknown> {
    const owner = commandOwners.get(command);
    if (!owner) throw new CoreError('CommandNotFound', `команды ${command} нет`);
    return callHost(liveHost(owner), owner, 'command', { pluginId: owner, name: command, args });
  }

  async function revive(pluginId: string): Promise<void> {
    if (!graph.order.includes(pluginId)) throw new CoreError('Unavailable', `${pluginId} не загружается: причина в журнале`);
    if (unloading) throw new CoreError('Unavailable', 'ядро выгружается');
    if (options.safeMode) throw new CoreError('Unavailable', 'безопасный режим');
    if (active.includes(pluginId)) return;
    strikes.delete(pluginId);
    switchedOff.delete(pluginId);
    hostFailures.delete(hostOf(pluginId)!);
    const lastKind = (id: string) => journal.findLast((e) => e.pluginId === id)?.kind;
    chain = chain.then(async () => {
      if (unloading || active.includes(pluginId)) return;
      record({ pluginId, kind: 'revived' });
      await activate(pluginId);
      for (const id of graph.order) if (!active.includes(id) && !switchedOff.has(id) && lastKind(id) === 'skipped') await activate(id);
    });
    await idle();
  }

  async function idle(): Promise<void> {
    for (;;) {
      const current = chain;
      await current;
      if (current === chain) return;
    }
  }

  for (const pluginId of graph.order) {
    if (options.safeMode) {
      record({ pluginId, kind: 'safe-mode' });
      continue;
    }
    await idle();
    await activate(pluginId);
  }
  await idle();

  return {
    journal,
    active,
    contracts: registry,
    manifests: known,
    hostOf,
    revive,
    run,
    idle,
    async unload() {
      await idle();
      unloading = true;
      for (const pluginId of [...active].reverse()) {
        try {
          await callHost(liveHost(pluginId), pluginId, 'deactivate', { pluginId }, activationTimeout);
          record({ pluginId, kind: 'deactivated' });
        } catch (error) {
          record({ pluginId, kind: 'deactivated', error: (error as Error).message });
        }
        dropPlugin(pluginId);
      }
      for (const host of [...hosts.values()]) stopHost(host, new CoreError('HostGone', 'ядро выгружено'));
    },
  };
}
