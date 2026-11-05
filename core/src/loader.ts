import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SectionResult, SectionStore } from './config.ts';
import type { Disposable } from './disposable.ts';
import { CoreError, errorMessage, ignore } from './errors.ts';
import { providesMatching, resolveGraph, type ContractGraph, type Rejection } from './graph.ts';
import { CALLBACK, handleKey, marker, SUBSCRIPTION, type ActivateResult, type ContractDescriptor, type SectionInput, type SystemEvent } from './host-runtime.ts';
import { normalizeKey, resolveKey } from './keys.ts';
import { checkArgs, parseManifest, type PluginManifest } from './manifest.ts';
import { ContractRegistry } from './registry.ts';
import { Endpoint } from './rpc.ts';
import { satisfies } from './semver.ts';
import { OsGateway, type OsEnvironment } from './os-gateway.ts';
import { isRecord, parseWire, type Parsed, type WireSpec } from './wire.ts';
import type { HostHandle, SpawnHost } from './transports.ts';
import type { TerminalSink, TerminalView } from './pty.ts';

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
  /** `activation: "lazy"`: ждёт первой команды, сочетания, показа вида или потребителя своего контракта. */
  | { readonly pluginId: string; readonly kind: 'waiting' }
  /** Шлюз `ctx.os` отказал: вызов вне прав манифеста. */
  | { readonly pluginId: string; readonly kind: 'denied'; readonly method: string; readonly detail: string }
  /** Снят по disable: сам (`by` - он же) или вместе с поставщиком, которого требовал. */
  | { readonly pluginId: string; readonly kind: 'unloaded'; readonly by: string; readonly error?: string }
  /** Сочетание объявлено и другим плагином; нажатие получает `winner`. */
  | { readonly pluginId: string; readonly kind: 'key-conflict'; readonly key: string; readonly command: string; readonly winner: string }
  /** Привязка `plugins.keybindings` не применена: сочетание не разобралось или команды нет ни у одного плагина. */
  | { readonly pluginId?: undefined; readonly kind: 'key-ignored'; readonly key: string; readonly command: string | null; readonly reason: string }
  /** Сторонний плагин назван в группе plugins.hosts с другими - ядро всё равно дало ему свой хост. */
  | { readonly pluginId: string; readonly kind: 'host-isolated'; readonly group: string; readonly hostId: string }
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
  readonly entry?: ((manifest: PluginManifest) => string) | undefined;
  /** `plugins.hosts`: группа -> плагины; не названный идёт в `builtin` или в свой хост по `host: "own"`. */
  readonly hosts?: Readonly<Record<string, readonly string[]>> | undefined;
  /** `plugins.keybindings` пользователя: перекрывают манифесты; `command: null` освобождает сочетание для окна. */
  readonly keybindings?: readonly UserKeybinding[] | undefined;
  /** Плагины из поставки Cyborg; только они делят хост. Не названный здесь - сторонний и всегда один в своём хосте. */
  readonly bundled?: readonly string[] | undefined;
  readonly config?: SectionStore | undefined;
  readonly state?: SectionStore | undefined;
  /** Окно без плагинов: манифесты разобраны, хосты не запускаются. */
  readonly safeMode?: boolean | undefined;
  readonly watchdog?: WatchdogOptions | undefined;
  readonly activationTimeout?: number | undefined;
  /** Среда шлюза `ctx.os`; по умолчанию каталоги плагинов во временном каталоге ОС, без секретов, уведомлений и буфера обмена. */
  readonly os?: OsEnvironment | undefined;
  /** Граф решён, код плагинов ещё не запускался. */
  /** Под какую ОС раскрыть `CmdOrCtrl`; по умолчанию текущая. */
  readonly platform?: string | undefined;
  /** Секунды простоя пользователя по ОС; без него `onIdle` не срабатывает. */
  readonly idleSeconds?: (() => number) | undefined;
  /** Как часто спрашивать `idleSeconds`, пока есть подписчики, мс. */
  readonly idlePoll?: number | undefined;
  readonly onGraph?: ((graph: ContractGraph) => Promise<void> | undefined) | undefined;
  readonly onJournal?: ((entry: JournalEntry) => void) | undefined;
  readonly onLog?: ((pluginId: string, message: string) => void) | undefined;
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
  /** Все сочетания из манифестов принятых плагинов, `key` - под платформу, как его даёт `keyOfInput`. */
  readonly keybindings: readonly Keybinding[];
  /** Синхронно, чтобы главный процесс успел отменить нажатие; владелец не активен - undefined. */
  keybinding(key: string): Keybinding | undefined;
  /** Выгружает плагин и тех, кто требует его через requires; хост без плагинов гасится, сторож и enable без явной просьбы их не поднимают. */
  disable(pluginId: string): Promise<void>;
  /** «Включить снова»: сбрасывает счёт сбоев, активирует плагин, его пропущенных потребителей и снятых вместе с ним. */
  enable(pluginId: string): Promise<void>;
  run(command: string, ...args: unknown[]): Promise<unknown>;
  /** Раздел поменялся извне (файл воркспейса правили руками): активные владельцы получают `onChange`, не прошедший проверку - запись в журнал. */
  reloadSections(kind: 'config' | 'state', ids: readonly string[]): Promise<void>;
  /** Дожидается перезапусков хостов, начатых сторожем, и ленивых активаций. */
  idle(): Promise<void>;
  /** Плагин с `activation: "lazy"` нужен сейчас - например, показан его вид; активному или не ленивому ничего не делает. */
  wake(pluginId: string): Promise<void>;
  /** Вид плагина открывает pty по билету `share()` его главной части; вывод идёт в `sink` мимо хоста. */
  openTerminal(pluginId: string, ticket: string, sink: TerminalSink): TerminalView;
  /** Событие окна или ОС от приложения: ядро раздаёт его активным плагинам. */
  emit(event: SystemEvent): void;
  /** Слушатели `onBeforeQuit` всех хостов, не дольше `budget` мс; после него приложение зовёт `unload`. */
  beforeQuit(budget?: number): Promise<void>;
  /** Снимает плагины в обратном порядке активации и гасит хосты. */
  unload(): Promise<void>;
}

/** Подписка через границу: колбэки живут в хосте потребителя, снятие - у поставщика. */
interface Subscription {
  readonly consumer: string;
  readonly consumerHost: Host;
  readonly provider: string;
  readonly providerHost: Host;
  /** Номер аргумента -> номер колбэка в хосте потребителя. */
  readonly callbacks: readonly (string | undefined)[];
}

export interface UserKeybinding {
  readonly key: string;
  readonly command: string | null;
}

export interface Keybinding {
  readonly key: string;
  readonly command: string;
  readonly pluginId: string;
  /** Привязку задал пользователь в `plugins.keybindings`. */
  readonly user?: true;
  /** Проигравшие в конфликте: то же сочетание у других плагинов. */
  readonly shadowed: readonly { readonly pluginId: string; readonly command: string }[];
}

interface Host {
  readonly id: string;
  readonly handle: HostHandle;
  readonly endpoint: Endpoint;
  readonly inflight: Map<number, string>;
  seq: number;
  down: boolean;
  pingAt?: number | undefined;
  timer?: ReturnType<typeof setInterval>;
}

// Граница доверия ядра - процесс хоста: внутри хоста плагины неразличимы, поэтому сторонний не делит процесс ни с кем.
function assignHosts(
  manifests: readonly PluginManifest[],
  groups: Readonly<Record<string, readonly string[]>>,
  bundled: ReadonlySet<string>,
  record: (entry: JournalEntry) => void,
): Map<string, string> {
  const loaded = new Set(manifests.map((m) => m.id));
  const groupOf = (id: string) => Object.entries(groups).find(([, ids]) => ids.includes(id));
  const result = new Map<string, string>();
  for (const m of manifests) {
    const group = groupOf(m.id);
    result.set(m.id, group?.[0] ?? (m.host === 'own' || !bundled.has(m.id) ? m.id : 'builtin'));
  }
  const used = new Set(result.values());
  for (const m of manifests) {
    if (bundled.has(m.id)) continue;
    const hostId = result.get(m.id) ?? m.id;
    const neighbours = manifests.filter((other) => other.id !== m.id && result.get(other.id) === hostId);
    if (neighbours.length === 0) continue;
    let own = m.id;
    for (let n = 2; used.has(own); n++) own = `${m.id}~${n}`;
    used.add(own);
    result.set(m.id, own);
    const group = groupOf(m.id);
    if (group?.[1].some((id) => id !== m.id && loaded.has(id))) record({ pluginId: m.id, kind: 'host-isolated', group: group[0], hostId: own });
  }
  return result;
}

// Встроенный побеждает сторонний, между равными - первый по id: исход не зависит от порядка каталогов на диске.
function bindKeys(
  manifests: readonly PluginManifest[],
  bundled: ReadonlySet<string>,
  platform: string,
  record: (entry: JournalEntry) => void,
): Map<string, Keybinding> {
  const rank = (m: PluginManifest) => [bundled.has(m.id) ? 0 : 1, m.id] as const;
  const sorted = [...manifests].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1].localeCompare(rank(b)[1]));
  const table = new Map<string, Keybinding>();
  for (const m of sorted) {
    for (const k of m.keybindings) {
      const key = resolveKey(k.key, platform);
      const owner = table.get(key);
      if (!owner) {
        table.set(key, { key, command: k.command, pluginId: m.id, shadowed: [] });
        continue;
      }
      table.set(key, { ...owner, shadowed: [...owner.shadowed, { pluginId: m.id, command: k.command }] });
      record({ pluginId: m.id, kind: 'key-conflict', key, command: k.command, winner: owner.pluginId });
    }
  }
  return table;
}

/** Выбор пользователя сильнее манифестов: конфликт он уже разрешил, поэтому вытесненные - в shadowed без записи о конфликте. */
function applyUserKeys(table: Map<string, Keybinding>, user: readonly UserKeybinding[], manifests: readonly PluginManifest[], platform: string, record: (entry: JournalEntry) => void): void {
  const ownerOf = new Map(manifests.flatMap((m) => Object.keys(m.commands).map((c) => [c, m.id] as const)));
  for (const u of user) {
    const normalized = normalizeKey(u.key);
    if (normalized === undefined) {
      record({ kind: 'key-ignored', key: u.key, command: u.command, reason: 'сочетание не разобрано' });
      continue;
    }
    const key = resolveKey(normalized, platform);
    const was = table.get(key);
    const shadowed = was ? [...(was.user ? [] : [{ pluginId: was.pluginId, command: was.command }]), ...was.shadowed] : [];
    if (u.command === null) {
      table.delete(key);
      continue;
    }
    const pluginId = ownerOf.get(u.command);
    if (pluginId === undefined) {
      record({ kind: 'key-ignored', key: u.key, command: u.command, reason: 'команды нет ни у одного плагина' });
      continue;
    }
    table.set(key, { key, command: u.command, pluginId, user: true, shadowed: shadowed.filter((s) => s.command !== u.command) });
  }
}

/** Свой каталог на запуск: общий /tmp/cyborg-plugins другой пользователь мог бы подменить ссылкой. */
function defaultOs(): OsEnvironment {
  const root = mkdtempSync(path.join(tmpdir(), 'cyborg-plugins-'));
  return { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') };
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
  const gateway = new OsGateway(
    options.os ?? defaultOs(),
    (d) => record({ pluginId: d.pluginId, kind: 'denied', method: d.method, detail: d.detail }),
    (id) => Object.assign({}, ...(options.config?.raw(id) ?? []).map(([, data]) => (isRecord(data) ? data : {}))) as Record<string, unknown>,
    (id, method, params) => {
      const host = hosts.get(hostOf(id) ?? id);
      if (host && !host.down) host.endpoint.notify(method, params);
    },
  );

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
  // Выключенные пользователем: сторож их не перезапускает, enable соседа не поднимает.
  const userOff = new Set<string>();
  const subscriptions = new Map<number, Subscription>();
  let subscriptionSeq = 0;
  let chain: Promise<void> = Promise.resolve();
  let unloading = false;
  const waiting = new Set<string>();
  const waking = new Map<string, Promise<void>>();
  const idleWatchers = new Map<string, { host: Host; pluginId: string; seconds: number; fired: boolean }>();
  let idleTimer: ReturnType<typeof setInterval> | undefined;

  const manifestOf = (pluginId: string): PluginManifest => {
    const m = byId.get(pluginId);
    if (!m) throw new CoreError('Unavailable', `плагина ${pluginId} нет`);
    return m;
  };
  const hostIds = assignHosts(manifests, options.hosts ?? {}, new Set(options.bundled ?? []), record);
  const hostOf = (pluginId: string): string | undefined => hostIds.get(pluginId);
  const accepted = graph.order.map(manifestOf);
  const keys = bindKeys(accepted, new Set(options.bundled ?? []), options.platform ?? process.platform, record);
  applyUserKeys(keys, options.keybindings ?? [], accepted, options.platform ?? process.platform, record);

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

  /** Те же правила, что у ContractRegistry в хосте: requires и optional - только связанный графом поставщик, consumes - любой подходящей версии. */
  function mayUse(caller: string, provider: string, contract: string, version: string): boolean {
    const m = byId.get(caller);
    if (!m || caller === provider) return false;
    const one = m.requires[contract] ?? m.optional[contract];
    if (one !== undefined) return graph.bindings.get(caller)?.get(contract) === provider && satisfies(version, one);
    const many = m.consumes[contract];
    return many !== undefined && satisfies(version, many);
  }

  function liveHost(pluginId: string): Host {
    const host = hosts.get(hostOf(pluginId) ?? '');
    if (!host || !active.includes(pluginId)) throw new CoreError('Unavailable', `${pluginId} не активен`);
    return host;
  }

  function dropProvided(pluginId: string, contract: string, version: string): void {
    const key = handleKey(pluginId, contract, version);
    const disposable = provided.get(key);
    if (!disposable) return;
    provided.delete(key);
    disposable.dispose();
    descriptors.set(contract, (descriptors.get(contract) ?? []).filter((d) => d.pluginId !== pluginId || d.version !== version));
    broadcast(contract);
  }

  function release(subscription: number): void {
    const s = subscriptions.get(subscription);
    if (!s) return;
    subscriptions.delete(subscription);
    s.providerHost.endpoint.notify('release', { subscription });
    s.consumerHost.endpoint.notify('forget', { ids: s.callbacks.filter((id) => id !== undefined) });
  }

  function pollIdle(): void {
    const idle = options.idleSeconds?.();
    if (idle === undefined) return;
    for (const [id, w] of idleWatchers) {
      if (w.host.down) continue;
      if (!w.fired && idle >= w.seconds) {
        w.fired = true;
        w.host.endpoint.notify('system', { kind: 'idle', id });
      } else if (w.fired && idle < w.seconds) w.fired = false;
    }
  }

  // Опрос ОС идёт, только пока кто-то ждёт простоя.
  function syncIdleTimer(): void {
    if (idleWatchers.size > 0 && idleTimer === undefined && options.idleSeconds && !unloading) {
      idleTimer = setInterval(pollIdle, options.idlePoll ?? 1000);
      idleTimer.unref();
    } else if ((idleWatchers.size === 0 || unloading) && idleTimer !== undefined) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
  }

  function dropPlugin(pluginId: string, hostDown = false): void {
    for (const [id, w] of [...idleWatchers]) if (w.pluginId === pluginId) idleWatchers.delete(id);
    syncIdleTimer();
    for (const [n, s] of [...subscriptions]) if (s.consumer === pluginId || s.provider === pluginId) release(n);
    const given = [...descriptors.values()].flat().filter((d) => d.pluginId === pluginId);
    for (const d of given) dropProvided(d.pluginId, d.contract, d.version);
    for (const [name, owner] of [...commandOwners]) if (owner === pluginId) commandOwners.delete(name);
    gateway.forget(pluginId, hostDown);
    const i = active.indexOf(pluginId);
    if (i >= 0) active.splice(i, 1);
  }

  function affected(gone: readonly string[]): string[] {
    const uses = (consumer: PluginManifest, provider: PluginManifest) =>
      [...(graph.bindings.get(consumer.id)?.values() ?? [])].includes(provider.id) ||
      Object.entries(consumer.consumes).some(([contract, range]) => providesMatching(provider, contract, range));
    return active.filter((id) => !gone.includes(id) && gone.some((p) => uses(manifestOf(id), manifestOf(p))));
  }

  function startHost(hostId: string): Host {
    const handle = options.spawnHost(hostId);
    const host: Host = { id: hostId, handle, endpoint: new Endpoint(handle.port), inflight: new Map(), seq: 0, down: false };
    hosts.set(hostId, host);
    const { endpoint } = host;
    const mine = (pluginId: string): PluginManifest => {
      const m = byId.get(pluginId);
      if (!m || host.down || hostOf(pluginId) !== hostId) throw new CoreError('Unavailable', `${pluginId} не в этом хосте`);
      return m;
    };

    const onRequest = <const S extends WireSpec>(method: string, spec: S, handler: (p: Parsed<S>) => unknown) => {
      endpoint.handle(method, (raw: unknown) => handler(parseWire(method, raw, spec)));
    };
    // У уведомления нет отправителя, которому вернуть отказ: без записи в лог подделка прошла бы молча.
    const onNote = <const S extends WireSpec>(method: string, spec: S, handler: (p: Parsed<S>) => void) => {
      endpoint.handle(method, (raw: unknown) => {
        try {
          handler(parseWire(method, raw, spec));
        } catch (error) {
          options.onLog?.(`хост ${hostId}`, `ядро отказало: ${errorMessage(error)}`);
        }
      });
    };
    const KEY = { pluginId: 'string', contract: 'string', version: 'string' } as const;

    onNote('provide', { ...KEY, data: 'record', methods: 'strings' }, (d) => {
      if (!mine(d.pluginId).provides[d.contract]?.includes(d.version)) {
        throw new CoreError('NotDeclared', `${d.pluginId}: ${d.contract}@${d.version} не объявлен в provides`);
      }
      const descriptor: ContractDescriptor = { pluginId: d.pluginId, contract: d.contract, version: d.version, data: d.data, methods: d.methods };
      const impl: Record<string, unknown> = { ...descriptor.data };
      for (const member of descriptor.methods) {
        impl[member] = (...args: unknown[]) => callHost(host, d.pluginId, 'call', { pluginId: d.pluginId, contract: d.contract, version: d.version, member, args });
      }
      provided.set(handleKey(d.pluginId, d.contract, d.version), registry.provide(d.pluginId, d.contract, d.version, impl));
      descriptors.set(d.contract, [...(descriptors.get(d.contract) ?? []), descriptor]);
      broadcast(d.contract);
    });
    onNote('unprovide', KEY, (p) => {
      mine(p.pluginId);
      dropProvided(p.pluginId, p.contract, p.version);
    });
    onNote('register', { pluginId: 'string', name: 'string' }, (p) => {
      if (!Object.hasOwn(mine(p.pluginId).commands, p.name)) throw new CoreError('NotDeclared', `${p.pluginId}: команда ${p.name} не объявлена в commands`);
      const owner = commandOwners.get(p.name);
      if (owner !== undefined && owner !== p.pluginId) throw new CoreError('CommandConflict', `${p.pluginId}: команда ${p.name} уже у ${owner}`);
      commandOwners.set(p.name, p.pluginId);
    });
    onNote('unregister', { pluginId: 'string', name: 'string' }, (p) => {
      mine(p.pluginId);
      if (commandOwners.get(p.name) === p.pluginId) commandOwners.delete(p.name);
    });
    onRequest('invoke', { ...KEY, caller: 'string', member: 'string', args: 'array' }, (p) => {
      mine(p.caller);
      const d = descriptors.get(p.contract)?.find((x) => x.pluginId === p.pluginId && x.version === p.version);
      if (!d?.methods.includes(p.member)) throw new CoreError('Unavailable', `${p.contract}@${p.version}.${p.member} у ${p.pluginId} нет`);
      if (!mayUse(p.caller, p.pluginId, p.contract, p.version)) {
        throw new CoreError('NotDeclared', `${p.caller}: ${p.contract}@${p.version} от ${p.pluginId} не объявлен потребляемым`);
      }
      const { pluginId, contract, version, member } = p;
      const target = liveHost(pluginId);
      const callbacks = p.args.map((arg) => marker(arg, CALLBACK));
      if (!callbacks.some((id) => id !== undefined)) return callHost(target, pluginId, 'call', { pluginId, contract, version, member, args: p.args });
      if (callbacks.some((id) => id !== undefined && typeof id !== 'string')) throw new CoreError('Invalid', 'invoke: номер колбэка не строка');

      const subscription = ++subscriptionSeq;
      subscriptions.set(subscription, { consumer: p.caller, consumerHost: host, provider: pluginId, providerHost: target, callbacks: callbacks as (string | undefined)[] });
      const args = p.args.map((arg, i) => (callbacks[i] === undefined ? arg : { [CALLBACK]: i }));
      return callHost(target, pluginId, 'call', { pluginId, contract, version, member, args, subscription }).then(
        (result) => {
          // Потребителя могли снять, пока поставщик отвечал: тогда подписку закрывает ядро.
          if (marker(result, SUBSCRIPTION) === subscription && subscriptions.has(subscription)) return result;
          if (marker(result, SUBSCRIPTION) === subscription) target.endpoint.notify('release', { subscription });
          subscriptions.delete(subscription);
          return result;
        },
        (error: unknown) => {
          subscriptions.delete(subscription);
          throw error;
        },
      );
    });
    onNote('emit', { subscription: 'number', index: 'number', args: 'array' }, (p) => {
      const s = subscriptions.get(p.subscription);
      if (!s) return;
      if (s.providerHost !== host) throw new CoreError('Unavailable', `подписка ${p.subscription} не из этого хоста`);
      const id = s.callbacks[p.index];
      if (id !== undefined) s.consumerHost.endpoint.notify('callback', { id, args: p.args });
    });
    onNote('release', { caller: 'string', subscription: 'number' }, (p) => {
      mine(p.caller);
      const s = subscriptions.get(p.subscription);
      if (!s) return;
      if (s.consumerHost !== host || s.consumer !== p.caller) throw new CoreError('Unavailable', `подписка ${p.subscription} не у ${p.caller}`);
      release(p.subscription);
    });
    onRequest('run', { name: 'string', args: 'array' }, (p) => run(p.name, ...p.args));
    onNote('idle.watch', { pluginId: 'string', id: 'string', seconds: 'number' }, (p) => {
      mine(p.pluginId);
      if (!p.id.startsWith(`${p.pluginId}#`)) throw new CoreError('Invalid', `idle.watch: ${p.id} не у ${p.pluginId}`);
      if (!(p.seconds > 0)) throw new CoreError('Invalid', `idle.watch: ${String(p.seconds)} секунд`);
      idleWatchers.set(p.id, { host, pluginId: p.pluginId, seconds: p.seconds, fired: false });
      syncIdleTimer();
    });
    onNote('idle.unwatch', { pluginId: 'string', id: 'string' }, (p) => {
      mine(p.pluginId);
      if (idleWatchers.get(p.id)?.pluginId === p.pluginId) idleWatchers.delete(p.id);
      syncIdleTimer();
    });
    onRequest('section.write', { pluginId: 'string', kind: ['config', 'state'], layer: 'string', version: 'number', data: 'record' }, async (p) => {
      const declared = mine(p.pluginId)[p.kind];
      if (!declared) throw new CoreError('NotDeclared', `${p.pluginId}: раздел ${p.kind} не объявлен в манифесте`);
      if (p.version !== declared.version) {
        throw new CoreError('Invalid', `${p.pluginId}: раздел ${p.kind} версии ${p.version}, а в манифесте ${declared.version}`);
      }
      if (p.kind === 'config') guardNetFields(mine(p.pluginId), p.data);
      await options[p.kind]?.write(p.layer, p.pluginId, p.version, p.data);
    });
    onRequest('os', { pluginId: 'string', method: 'string', args: 'array' }, (p) => gateway.call(mine(p.pluginId), p.method, p.args));
    onNote('log', { pluginId: 'string', message: 'string' }, (p) => {
      mine(p.pluginId);
      options.onLog?.(p.pluginId, p.message);
    });

    handle.onExit(() => hostDown(host, 'crash'));
    endpoint.request('init', wire).catch(ignore);
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
        ignore,
      );
    }, watchdog.interval);
    host.timer.unref();
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
    for (const id of [...victims].reverse()) dropPlugin(id, true);

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
        for (const id of victims) gateway.forget(id);
        return;
      }
    }

    const again = graph.order.filter((id) => hostOf(id) === host.id && !switchedOff.has(id) && !userOff.has(id) && (victims.includes(id) || culprits.includes(id)));
    // pty с persist ждут только тех, кто вернётся; выключенному сторожем их некому забрать.
    for (const id of victims) if (!again.includes(id)) gateway.forget(id);
    if (again.length === 0) return;
    chain = chain.then(async () => {
      if (unloading) return;
      record({ kind: 'host-restart', hostId: host.id, plugins: again });
      for (const id of again) await activate(id);
    });
  }

  // Поле из net "config:<поле>" задаёт человек: запись плагина в него расширила бы его сеть после перезапуска.
  function guardNetFields(m: PluginManifest, data: Record<string, unknown>): void {
    const layers = (options.config?.raw(m.id) ?? []).map(([, d]) => (isRecord(d) ? d : {}));
    const fields = (m.permissions.net ?? []).filter((h) => h.startsWith('config:')).map((h) => h.slice('config:'.length));
    // Удалить поле или повторить значение, заданное человеком в любом слое, можно: новых хостов это не даёт.
    const touched = fields.filter((f) => data[f] !== undefined && !layers.some((d) => isDeepStrictEqual(d[f], data[f])));
    if (touched.length === 0) return;
    const detail = `поля ${touched.join(', ')} задают хосты net - их меняет только человек`;
    record({ pluginId: m.id, kind: 'denied', method: 'config.set', detail });
    throw new CoreError('PermissionDenied', `${m.id}: ${detail}`);
  }

  function sectionInput(kind: 'config' | 'state', m: PluginManifest): SectionInput | undefined {
    const declared = m[kind];
    const store = options[kind];
    return declared && store ? { version: declared.version, layers: store.raw(m.id) } : undefined;
  }

  /** Поставщики по графу (requires, optional) - их ждём; поставщики consumes будятся без ожидания: у many бывают встречные пары. */
  async function wakeProviders(m: PluginManifest): Promise<void> {
    for (const p of graph.bindings.get(m.id)?.values() ?? []) await wake(p);
    for (const id of waiting) if (Object.entries(m.consumes).some(([c, r]) => providesMatching(manifestOf(id), c, r))) void wake(id);
  }

  function wake(pluginId: string): Promise<void> {
    const pending = waking.get(pluginId);
    if (pending) return pending;
    if (!waiting.has(pluginId) || unloading) return Promise.resolve();
    waiting.delete(pluginId);
    const started = activate(pluginId).finally(() => waking.delete(pluginId));
    waking.set(pluginId, started);
    return started;
  }

  async function activate(pluginId: string): Promise<void> {
    const m = manifestOf(pluginId);
    await wakeProviders(m);
    const down = [...(graph.bindings.get(pluginId) ?? [])].find(([c, p]) => c in m.requires && !active.includes(p));
    if (down) {
      record({ pluginId, kind: 'skipped', reason: `поставщик ${down[0]} (${down[1]}) не активен` });
      return;
    }
    const hostId = hostOf(m.id) ?? m.id;
    const host = hosts.get(hostId) ?? startHost(hostId);
    const started = performance.now();
    try {
      gateway.approve(pluginId);
      const params = { pluginId, entry: options.entry?.(m) ?? pluginId, paths: gateway.pathsOf(pluginId), config: sectionInput('config', m), state: sectionInput('state', m) };
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
      if (error instanceof CoreError && error.code === 'Timeout') host.endpoint.request('deactivate', { pluginId }).catch(ignore);
      record({ pluginId, kind: 'failed', hostId, error: errorMessage(error) });
    }
  }

  async function run(command: string, ...args: unknown[]): Promise<unknown> {
    const sleeper = [...waiting, ...waking.keys()].find((id) => Object.hasOwn(manifestOf(id).commands, command));
    if (sleeper !== undefined && !commandOwners.has(command)) await wake(sleeper);
    const owner = commandOwners.get(command);
    if (!owner) throw new CoreError('CommandNotFound', `команды ${command} нет`);
    const spec = manifestOf(owner).commands[command];
    if (!spec) throw new CoreError('CommandNotFound', `команда ${command} не объявлена у ${owner}`);
    checkArgs(command, spec, args);
    return callHost(liveHost(owner), owner, 'command', { pluginId: owner, name: command, args });
  }

  function guard(pluginId: string): void {
    if (!graph.order.includes(pluginId)) throw new CoreError('Unavailable', `${pluginId} не загружается: причина в журнале`);
    if (unloading) throw new CoreError('Unavailable', 'ядро выгружается');
    if (options.safeMode) throw new CoreError('Unavailable', 'безопасный режим');
  }

  async function enable(pluginId: string): Promise<void> {
    guard(pluginId);
    userOff.delete(pluginId);
    waiting.delete(pluginId);
    if (active.includes(pluginId)) return;
    strikes.delete(pluginId);
    switchedOff.delete(pluginId);
    hostFailures.delete(hostOf(pluginId) ?? pluginId);
    const last = (id: string) => journal.findLast((e) => e.pluginId === id && e.kind !== 'key-conflict');
    const follows = (id: string) => {
      const e = last(id);
      return e?.kind === 'skipped' || (e?.kind === 'unloaded' && e.by === pluginId && id !== pluginId);
    };
    chain = chain.then(async () => {
      if (unloading || active.includes(pluginId)) return;
      record({ pluginId, kind: 'revived' });
      await activate(pluginId);
      for (const id of graph.order) if (!active.includes(id) && !switchedOff.has(id) && !userOff.has(id) && follows(id)) await activate(id);
    });
    await idle();
  }

  /** Активные, кто через requires прямо или по цепочке держится за `root`. */
  function dependents(root: string): Set<string> {
    const gone = new Set([root]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of active) {
        if (gone.has(id)) continue;
        const m = manifestOf(id);
        if (![...(graph.bindings.get(id) ?? [])].some(([c, p]) => c in m.requires && gone.has(p))) continue;
        gone.add(id);
        grew = true;
      }
    }
    return gone;
  }

  async function deactivate(pluginId: string, by: string): Promise<void> {
    const host = hosts.get(hostOf(pluginId) ?? '');
    let error: string | undefined;
    try {
      if (host) await callHost(host, pluginId, 'deactivate', { pluginId }, activationTimeout);
    } catch (e) {
      error = errorMessage(e);
    }
    dropPlugin(pluginId);
    record({ pluginId, kind: 'unloaded', by, ...(error !== undefined && { error }) });
    // Пустой хост гасится: следующая активация импортирует код плагина заново, в новом процессе.
    if (host && !host.down && !active.some((id) => hostOf(id) === host.id)) stopHost(host, new CoreError('HostGone', `хост ${host.id} без плагинов`));
  }

  async function disable(pluginId: string): Promise<void> {
    guard(pluginId);
    userOff.add(pluginId);
    waiting.delete(pluginId);
    await waking.get(pluginId);
    chain = chain.then(async () => {
      if (unloading) return;
      if (!active.includes(pluginId)) {
        record({ pluginId, kind: 'unloaded', by: pluginId });
        return;
      }
      const gone = dependents(pluginId);
      for (const id of [...active].reverse()) if (gone.has(id)) await deactivate(id, pluginId);
    });
    await idle();
  }

  async function idle(): Promise<void> {
    for (;;) {
      const current = chain;
      await current;
      await Promise.allSettled([...waking.values()]);
      if (current === chain && waking.size === 0) return;
    }
  }

  for (const pluginId of graph.order) {
    if (options.safeMode) {
      record({ pluginId, kind: 'safe-mode' });
      continue;
    }
    if (manifestOf(pluginId).activation === 'lazy') {
      waiting.add(pluginId);
      record({ pluginId, kind: 'waiting' });
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
    keybindings: [...keys.values()],
    keybinding(key) {
      const k = keys.get(key);
      return k && (active.includes(k.pluginId) || waiting.has(k.pluginId) || waking.has(k.pluginId)) ? k : undefined;
    },
    wake,
    openTerminal: (pluginId, ticket, sink) => gateway.openTerminal(pluginId, ticket, sink),
    emit(event) {
      if (!['focus', 'suspend', 'resume', 'screen-lock'].includes(event.kind)) throw new CoreError('Invalid', `событие ${event.kind as string} ядру не известно`);
      for (const host of hosts.values()) if (!host.down) host.endpoint.notify('system', event);
    },
    async beforeQuit(budget = 3000) {
      await idle();
      const late = new Promise<void>((resolve) => setTimeout(resolve, budget).unref());
      // Без callHost: зависший слушатель - не сбой плагина, хост всё равно уходит вместе с приложением.
      const asks = [...hosts.values()].filter((h) => !h.down).map((h) => h.endpoint.request('system.beforeQuit', null).catch(ignore));
      await Promise.race([Promise.all(asks), late]);
    },
    disable,
    enable,
    run,
    idle,
    async reloadSections(kind, ids) {
      for (const pluginId of [...active]) {
        const m = manifestOf(pluginId);
        const store = options[kind];
        if (!ids.includes(pluginId)) continue;
        if (kind === 'config') gateway.approve(pluginId);
        if (!m[kind] || !store) continue;
        try {
          const result = await callHost<SectionResult>(liveHost(pluginId), pluginId, 'section.reload', { pluginId, kind, layers: store.raw(pluginId) });
          if (result.status !== 'ok') record({ pluginId, kind, result });
        } catch (error) {
          record({ pluginId, kind, result: { status: 'invalid', errors: [errorMessage(error)] } });
        }
      }
    },
    async unload() {
      await idle();
      unloading = true;
      syncIdleTimer();
      for (const pluginId of [...active].reverse()) {
        try {
          await callHost(liveHost(pluginId), pluginId, 'deactivate', { pluginId }, activationTimeout);
          record({ pluginId, kind: 'deactivated' });
        } catch (error) {
          record({ pluginId, kind: 'deactivated', error: errorMessage(error) });
        }
        dropPlugin(pluginId);
      }
      for (const host of [...hosts.values()]) stopHost(host, new CoreError('HostGone', 'ядро выгружено'));
    },
  };
}
