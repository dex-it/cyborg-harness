import type { NotifyClick } from '@cyborg-harness/contracts';
import type { SectionResult } from './config.ts';
import type { DocumentTable } from './documents.ts';
import type { CoreError } from './errors.ts';
import type { ContractGraph } from './graph.ts';
import type { SectionInput, SystemEvent } from './host-runtime.ts';
import type { DeniedCollapse } from './journal.ts';
import type { DisableOptions, DisablePreview, EnabledChange, JournalEntry, Keybinding, KeyPress, LoadOptions } from './kernel-types.ts';
import type { ResourceLimits } from './limits.ts';
import type { PluginManifest } from './manifest.ts';
import type { Notices } from './notices.ts';
import type { OsEnvironment, OsGateway } from './os-gateway.ts';
import type { ContractRegistry } from './registry.ts';
import type { Endpoint } from './rpc.ts';
import type { HostHandle } from './transports.ts';
import type { Parsed, WireSpec } from './wire.ts';
import type { WindowLayer } from './window-layer.ts';

/*
 * Общее состояние ядра и узкие интерфейсы его частей.
 *
 * `load()` собирает `KernelContext` один раз; каждая часть (`host-pool`, `lifecycle`, `activation`, ...) получает его целиком,
 * держит своё изменяемое состояние у себя и открывает остальным только то, что названо в `Parts`.
 * Части зовут друг друга через `ctx.parts` в момент вызова, а не при создании: так нет ни круговых импортов, ни порядка создания.
 * Модули частей импортируют отсюда только типы.
 */

/** Как плагин отпускают: `detach` - хост упал и плагин вернётся, `park` - pty оставлены человеком, `release` - завершить. */
export type PtyDrop = 'release' | 'detach' | 'park';

/** Счётчик подряд идущих сбоев: сбой позже окна после прошлого начинает счёт заново. */
export interface Counter {
  n: number;
  at: number;
}

export interface Host {
  readonly id: string;
  readonly handle: HostHandle;
  readonly endpoint: Endpoint;
  readonly inflight: Map<number, string>;
  seq: number;
  /** Номер последнего вызова до пинга, на который хост ответил: эти вызовы хост уже принял, они его не держат. */
  answered: number;
  /** Плагин, чей код хост назвал после последнего отвеченного пинга: он и выполняется, если хост встал. */
  running?: string | undefined;
  /** Сколько уведомлений `running` пришло от хоста: ответ на пинг называет, сколько хост послал до ответа. */
  notes: number;
  /** Плагин, чей код завершил процесс хоста: хост называет его из обработчика exit. */
  exiting?: string | undefined;
  down: boolean;
  pingAt?: number | undefined;
  timer?: ReturnType<typeof setInterval>;
}

/** Подписка через границу: колбэки живут в хосте потребителя, снятие - у поставщика. */
export interface Subscription {
  readonly consumer: string;
  readonly consumerHost: Host;
  readonly provider: string;
  readonly providerHost: Host;
  /** Номер аргумента -> номер колбэка в хосте потребителя. */
  readonly callbacks: readonly (string | undefined)[];
}

/** Что часть получает при подключении к хосту: проверка, что плагин из этого хоста, и регистрация обработчиков его сообщений. */
export interface BridgeEnd {
  readonly host: Host;
  readonly mine: (pluginId: string) => PluginManifest;
  /** Запрос с ответом: недоверенный вход сверяется со схемой до обработчика. */
  readonly onRequest: <const S extends WireSpec>(method: string, spec: S, handler: (p: Parsed<S>) => unknown) => void;
  /** Уведомление: отказ идёт в лог, потому что вернуть его отправителю некому. */
  readonly onNote: <const S extends WireSpec>(method: string, spec: S, handler: (p: Parsed<S>) => void) => void;
}

/** Хосты: запуск, остановка, вызовы в них, сторож. */
export interface HostPool {
  readonly hosts: Map<string, Host>;
  start(hostId: string): Host;
  stop(host: Host, error: CoreError): void;
  call<T>(host: Host, pluginId: string, method: string, params: unknown, timeout?: number): Promise<T>;
  /** Хост активного плагина; плагин не активен - `Unavailable`. */
  live(pluginId: string): Host;
  /** Сброс счёта сбоев хоста без виновника: «Включить снова». */
  forgetFailures(hostId: string): void;
  emit(event: SystemEvent): void;
  beforeQuit(budget: number): Promise<void>;
  stopAll(): void;
}

/** Очередь операций, выключение и сбои плагинов, снятие и выгрузка. */
export interface Lifecycle {
  /** Выключены сторожем после череды сбоев. */
  readonly switchedOff: Set<string>;
  /** Выключены пользователем: сторож их не перезапускает, enable соседа не поднимает. */
  readonly userOff: Set<string>;
  enqueue(step: () => Promise<void>): Promise<void>;
  idle(): Promise<void>;
  /** Сбой плагина; череда подряд выключает его, а снять выключенного с хоста - дело вызывающего. */
  strike(id: string): boolean;
  affected(gone: readonly string[]): string[];
  dropPlugin(pluginId: string, pty?: PtyDrop): number;
  forgetOs(pluginId: string, pty?: PtyDrop): number;
  unloadPlugin(pluginId: string, keepPty?: boolean): Promise<{ error?: string; keptPty: number }>;
  enable(pluginId: string): Promise<void>;
  disable(pluginId: string, options?: DisableOptions): Promise<void>;
  setEnabled(next: readonly string[]): Promise<EnabledChange>;
  disablePreview(pluginId: string): DisablePreview;
  shutdown(): Promise<void>;
}

/** Ленивые плагины, пробуждение и сама активация. */
export interface Activation {
  /** Ждущие первого обращения; править их может только activation: снять с ожидания - `forget`. */
  readonly waiting: ReadonlySet<string>;
  readonly waking: ReadonlyMap<string, Promise<void>>;
  readonly activating: ReadonlyMap<string, Promise<void>>;
  /** Плагин больше не ждёт: его включили или выключили сами, будить его уже не нужно. */
  forget(pluginId: string): void;
  activate(pluginId: string): Promise<void>;
  wake(pluginId: string): Promise<void>;
  /** Замок окна, затем активация в порядке графа. */
  start(): Promise<void>;
}

/** Контракты между хостами: описатели поставщиков, подписки, вызов члена. */
export interface ContractCalls {
  attach(end: BridgeEnd): void;
  /** Новому хосту - всё, что уже предоставлено. */
  announce(host: Host): void;
  dropFor(pluginId: string): void;
  callAs(caller: string, contract: string, major: number, member: string, args: readonly unknown[]): Promise<unknown>;
}

/** Реестр команд и их запуск. */
export interface Commands {
  readonly owners: Map<string, string>;
  attach(end: BridgeEnd): void;
  dropFor(pluginId: string): void;
  run(command: string, ...args: unknown[]): Promise<unknown>;
}

/** Динамические сочетания рядом со статической таблицей `ctx.keys`; нажатие и список читают обе через эту часть. */
export interface KeyRegistry {
  attach(end: BridgeEnd): void;
  dropFor(pluginId: string): void;
  /** Владелец не работает или условия не прошли - undefined; без `press` условия не проверяются. */
  lookup(key: string, press?: KeyPress): Keybinding | undefined;
  rows(): Keybinding[];
  setVisible(pluginId: string, visible: boolean): void;
}

/** Слушатели простоя пользователя. */
export interface IdleWatch {
  attach(end: BridgeEnd): void;
  drop(pluginId: string): void;
  /** Опрос ОС идёт, только пока кто-то ждёт простоя. */
  sync(): void;
}

/** Разделы `config` и `state` плагинов. */
export interface Sections {
  attach(end: BridgeEnd): void;
  input(kind: 'config' | 'state', m: PluginManifest): SectionInput | SectionResult | undefined;
  reload(kind: 'config' | 'state', ids: readonly string[]): Promise<void>;
}

/** Запросы плагина к ядру: документы, `ctx.os`, уведомления, замок. */
export interface OsRequests {
  attach(end: BridgeEnd): void;
  clickNotice(pluginId: string, click: NotifyClick): void;
}

/** Память видов в state воркспейса. */
export interface ViewsState {
  viewKey(pluginId: string, view: string): string;
  viewState(pluginId: string, view: string): unknown;
  setViewState(pluginId: string, view: string, value: unknown): Promise<void>;
}

/** Обработчики сообщений хоста. */
export interface Bridge {
  attach(host: Host): void;
}

export interface Parts {
  readonly pool: HostPool;
  readonly lifecycle: Lifecycle;
  readonly activation: Activation;
  readonly contracts: ContractCalls;
  readonly commands: Commands;
  readonly keyRegistry: KeyRegistry;
  readonly idleWatch: IdleWatch;
  readonly sections: Sections;
  readonly osRequests: OsRequests;
  readonly views: ViewsState;
  readonly bridge: Bridge;
}

export interface KernelContext {
  readonly options: LoadOptions;
  readonly journal: JournalEntry[];
  readonly record: (entry: JournalEntry) => void;
  readonly denials: DeniedCollapse;
  /** Включённые в `plugins.enabled` при запуске. */
  readonly enabled: ReadonlySet<string>;
  readonly watchdog: { readonly interval: number; readonly timeout: number; readonly strikes: number; readonly window: number };
  readonly activationTimeout: number;
  readonly callTimeout: number;
  readonly limits: ResourceLimits;
  readonly osEnv: OsEnvironment;
  readonly layer: WindowLayer;
  readonly notices: Notices;
  readonly gateway: OsGateway;
  readonly documents: DocumentTable;
  /** Принятые к загрузке. */
  readonly manifests: PluginManifest[];
  /** Все разобранные, включённые и нет. */
  readonly known: PluginManifest[];
  readonly byId: ReadonlyMap<string, PluginManifest>;
  readonly graph: ContractGraph;
  readonly registry: ContractRegistry;
  /** Что хост получает в `init`: снимок на момент запуска ядра. */
  readonly wire: { readonly manifests: readonly PluginManifest[]; readonly bindings: readonly (readonly [string, readonly (readonly [string, string])[]])[] };
  readonly manifestOf: (pluginId: string) => PluginManifest;
  readonly hostOf: (pluginId: string) => string | undefined;
  readonly keys: ReadonlyMap<string, Keybinding>;
  /** Активные сейчас, в порядке активации. */
  readonly active: string[];
  /** Ядро выгружается: новые активации, перезапуски и страйки не начинаются. */
  unloading: boolean;
  readonly parts: Parts;
}
