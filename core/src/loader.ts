import { mkdtempSync } from 'node:fs';
import type { PtyInfo } from '@cyborg-harness/contracts';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { VERSION_KEY, type SectionResult, type SectionStore } from './config.ts';
import type { Disposable } from './disposable.ts';
import { appendBounded, DeniedCollapse } from './journal.ts';
import { CoreError, errorMessage, ignore } from './errors.ts';
import { compileSchema } from './json-schema.ts';
import { providesMatching, resolveGraph, type ContractGraph, type Rejection } from './graph.ts';
import { CALLBACK, handleKey, marker, SUBSCRIPTION, type ActivateResult, type ContractDescriptor, type SectionInput, type SystemEvent } from './host-runtime.ts';
import { normalizeKey, resolveKey } from './keys.ts';
import { checkArgs, parseManifest, viewEntry, type PluginManifest } from './manifest.ts';
import { ContractRegistry } from './registry.ts';
import { Endpoint } from './rpc.ts';
import { satisfies } from './semver.ts';
import { OsGateway, type OsEnvironment } from './os-gateway.ts';
import { DocumentTable, type DocumentRow } from './documents.ts';
import { guardedValue, guardsOf } from './via-contract.ts';
import { isRecord, own, parseWire, type Parsed, type WireSpec } from './wire.ts';
import type { HostHandle, SpawnHost } from './transports.ts';
import type { TerminalSink, TerminalView } from './pty.ts';
import { WINDOW_COMMANDS, WINDOW_OWNER, WindowLayer, type WindowSnapshot } from './window-layer.ts';

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
  | {
      readonly pluginId: string;
      readonly kind: 'denied';
      readonly method: string;
      readonly detail: string;
      readonly reason?: 'via-contract';
      /** Столько таких же отказов склеено за окно после первого. */
      readonly repeats?: number;
    }
  /** Снят по disable: сам (`by` - он же) или вместе с поставщиком, которого требовал. */
  | { readonly pluginId: string; readonly kind: 'unloaded'; readonly by: string; readonly error?: string; readonly keptPty?: number }
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
  /** Сбой позже стольких мс после прошлого - уже не «подряд»: счёт начинается заново. */
  readonly window?: number;
}

export interface EnabledChange {
  /** Не было в графе при запуске: граф без перезапуска не перестраивается. */
  readonly restart: readonly string[];
  /** Не выключились: например, под замком окна. */
  readonly failed: readonly string[];
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
  /** Разобранный JSON файла схемы раздела (`config.schema`, `state.schema`) из каталога плагина; бросок - отказ разделу. */
  readonly schema?: ((manifest: PluginManifest, file: string) => unknown) | undefined;
  /** Окно без плагинов: манифесты разобраны, хосты не запускаются. */
  readonly safeMode?: boolean | undefined;
  readonly watchdog?: WatchdogOptions | undefined;
  readonly activationTimeout?: number | undefined;
  /** Сколько ждать ответа поставщика на метод контракта, мс; по умолчанию 10 минут, дольше - `Timeout` вызывающему. */
  readonly callTimeout?: number | undefined;
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
  /** Диалог на экране, очередь и замки поменялись: приложение перерисовывает слой окна. */
  readonly onWindow?: ((snapshot: WindowSnapshot) => void) | undefined;
  /** Документ открыт, переименован или закрыт: приложение перерисовывает вкладки по `kernel.documents`. */
  readonly onDocuments?: (() => void) | undefined;
}

export interface DisableOptions {
  readonly keepPty?: boolean;
}

export interface DisablePreview {
  /** Сам плагин и активные, кто требует его через requires. */
  readonly plugins: readonly string[];
  readonly ptys: readonly (PtyInfo & { readonly pluginId: string })[];
}

// Id раздела ядра: плагин не может так называться, `$` манифест не пропустит.
const VIEW_STATE = '$views';
const VIEW_STATE_MAX = 64 * 1024;
const DOCUMENTS_STATE = '$documents';
const GRANTED_STATE = '$granted';

export interface Kernel {
  readonly journal: readonly JournalEntry[];
  /** Активные сейчас, в порядке активации. */
  readonly active: readonly string[];
  /** Вид реестра из главного процесса: методы контрактов идут в хост поставщика. Звать метод от имени плагина - через `callAs`, иначе ядро не проверит права вызывающего. */
  readonly contracts: ContractRegistry;
  /** Метод контракта от имени плагина (его вида): те же проверки, что у вызова из главной части, включая `via-contract`. */
  callAs(caller: string, contract: string, major: number, member: string, args: readonly unknown[]): Promise<unknown>;
  /** Разобранные манифесты, включённые и нет. */
  readonly manifests: readonly PluginManifest[];
  hostOf(pluginId: string): string | undefined;
  /** Все сочетания из манифестов принятых плагинов, `key` - под платформу, как его даёт `keyOfInput`. */
  readonly keybindings: readonly Keybinding[];
  /** Синхронно, чтобы главный процесс успел отменить нажатие; владелец не активен - undefined. */
  keybinding(key: string): Keybinding | undefined;
  /** Выгружает плагин и тех, кто требует его через requires; хост без плагинов гасится, сторож и enable без явной просьбы их не поднимают. `keepPty` - живые pty не завершаются и ждут `attach` вернувшегося плагина. */
  disable(pluginId: string, options?: DisableOptions): Promise<void>;
  /** Что выключение заберёт с собой: плагины по requires и их живые pty - о них приложение спрашивает человека до `disable`. */
  disablePreview(pluginId: string): DisablePreview;
  /** «Включить снова»: сбрасывает счёт сбоев, активирует плагин, его пропущенных потребителей и снятых вместе с ним. */
  enable(pluginId: string): Promise<void>;
  /** `plugins.enabled` поменяли в файле: убранные выключаются, вернувшиеся включаются; ответ - кого нет в графе запуска и кто ждёт перезапуска. */
  setEnabled(next: readonly string[]): Promise<EnabledChange>;
  run(command: string, ...args: unknown[]): Promise<unknown>;
  /** Раздел поменялся извне (файл воркспейса правили руками): активные владельцы получают `onChange`, не прошедший проверку - запись в журнал. */
  reloadSections(kind: 'config' | 'state', ids: readonly string[]): Promise<void>;
  /** Дожидается перезапусков хостов, начатых сторожем, и ленивых активаций. */
  idle(): Promise<void>;
  /** Плагин с `activation: "lazy"` нужен сейчас - например, показан его вид; активному или не ленивому ничего не делает. */
  wake(pluginId: string): Promise<void>;
  /** Вид плагина открывает pty по билету `share()` его главной части; вывод идёт в `sink` мимо хоста. */
  openTerminal(pluginId: string, ticket: string, sink: TerminalSink): TerminalView;
  /** Память вида из state воркспейса: раздел ядра `$views`, ключ `<плагин>/<вид>`; вида нет в манифесте - `Invalid`. */
  viewState(pluginId: string, view: string): unknown;
  /** JSON до 64 КБ, undefined - забыть; записи идут по очереди, чтобы параллельные не затёрли друг друга. */
  setViewState(pluginId: string, view: string, value: unknown): Promise<void>;
  /** Слой окна сейчас: диалог на экране и замки. */
  readonly window: WindowSnapshot;
  /** Открытые документы в порядке окна; `available: false` - владелец не работает, вкладка ждёт его. */
  readonly documents: readonly DocumentRow[];
  /** Человек закрыл вкладку: строка уходит, активный владелец получает `onClose`. */
  closeDocument(id: string): Promise<void>;
  /** Диалог вида; ответ - id пункта или undefined. Описание проверяется здесь, окно получает разобранную копию. */
  showDialog(pluginId: string, view: string, spec: unknown): Promise<string | undefined>;
  /** Ответ человека на диалог `window.dialog`. */
  answerDialog(id: number, choice: string | undefined): void;
  /** Свои команды плагина с сочетаниями, как их ловит `keybinding`. */
  keysOf(pluginId: string): Readonly<Record<string, string>>;
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
  for (const [command, key] of Object.entries(WINDOW_COMMANDS)) table.set(key, { key, command, pluginId: WINDOW_OWNER, shadowed: [] });
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
  const ownerOf = new Map([...Object.keys(WINDOW_COMMANDS).map((c) => [c, WINDOW_OWNER] as const), ...manifests.flatMap((m) => Object.keys(m.commands).map((c) => [c, m.id] as const))]);
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
  const write = (entry: JournalEntry) => {
    appendBounded(journal, entry, (e) => e);
    options.onJournal?.(entry);
  };
  // Плагин в цикле отказов иначе раздул бы журнал ядра и снимок окна без предела.
  const denials = new DeniedCollapse(write);
  const record = (entry: JournalEntry) => {
    if (entry.kind === 'denied') denials.record(entry);
    else write(entry);
  };
  const enabled = new Set(options.enabled);
  // Последний список из файла: setEnabled применяет разницу с ним, а не с выключенными в окне.
  let listed = new Set(options.enabled);
  const watchdog = { interval: 1000, timeout: 5000, strikes: 3, window: 10 * 60_000, ...options.watchdog };
  const activationTimeout = options.activationTimeout ?? 10_000;
  const callTimeout = options.callTimeout ?? 10 * 60_000;
  const layer = new WindowLayer((snapshot) => options.onWindow?.(snapshot));
  const osEnv = options.os ?? defaultOs();
  const notify = osEnv.notify;
  const gateway = new OsGateway(
    // Под замком с hideNotifications текст уведомления виден на заблокированном экране ОС - уходит без него.
    notify ? { ...osEnv, notify: (title, body) => (layer.hideNotifications ? notify('Cyborg', 'новое событие') : notify(title, body)) } : osEnv,
    (d) => record({ pluginId: d.pluginId, kind: 'denied', method: d.method, detail: d.detail, ...(d.reason && { reason: d.reason }) }),
    (id) => Object.assign({}, ...(options.config?.raw(id) ?? []).map(([, data]) => (isRecord(data) ? data : {}))) as Record<string, unknown>,
    (id, method, params) => {
      const host = hosts.get(hostOf(id) ?? id);
      if (host && !host.down) host.endpoint.notify(method, params);
    },
    (id) => known.find((k) => k.id === id),
    options.state && {
      read: () => {
        const raw = options.state?.raw(GRANTED_STATE).find(([layer]) => layer === 'workspace')?.[1];
        return isRecord(raw) ? raw.byPlugin : undefined;
      },
      write: async (byPlugin) => options.state?.write('workspace', GRANTED_STATE, 1, { byPlugin }),
    },
    async (id, params) => {
      const host = hosts.get(hostOf(id) ?? id);
      if (!host || host.down) throw new CoreError('Unavailable', `${id}: хост не работает`);
      return host.endpoint.request('serve.request', params);
    },
  );

  const manifests: PluginManifest[] = [];
  const known: PluginManifest[] = [];
  let viewWrites: Promise<unknown> = Promise.resolve();
  const viewKey = (pluginId: string, view: string): string => {
    const m = known.find((k) => k.id === pluginId);
    if (!m || viewEntry(m, view) === undefined) throw new CoreError('Invalid', `${pluginId}: вида ${JSON.stringify(view)} нет в манифесте`);
    return `${pluginId}/${view}`;
  };
  const viewMemory = (): Record<string, unknown> => {
    const raw = options.state?.raw(VIEW_STATE).find(([layer]) => layer === 'workspace')?.[1];
    if (!isRecord(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== VERSION_KEY));
  };
  for (const raw of options.manifests) {
    const parsed = parseManifest(raw, options.apiVersion);
    const id = parsed.ok ? parsed.manifest.id : parsed.id;
    if (parsed.ok) known.push(parsed.manifest);
    if (id !== undefined && !enabled.has(id)) record({ pluginId: id, kind: 'disabled' });
    else if (!parsed.ok) record({ pluginId: id ?? '?', kind: 'invalid', errors: parsed.errors });
    else manifests.push(parsed.manifest);
  }
  for (const id of enabled) {
    if (!manifests.some((m) => m.id === id) && !journal.some((e) => e.pluginId === id)) record({ pluginId: id, kind: 'not-found' });
  }
  // После разбора манифестов: строка, тип которой владелец убрал, отсеивается при чтении.
  const documents = new DocumentTable(
    options.state && {
      read: () => {
        const raw = options.state?.raw(DOCUMENTS_STATE).find(([layer]) => layer === 'workspace')?.[1];
        return isRecord(raw) ? raw.list : undefined;
      },
      write: async (list) => options.state?.write('workspace', DOCUMENTS_STATE, 1, { list }),
    },
    (pluginId, type) => {
      const m = known.find((k) => k.id === pluginId);
      if (!m) return undefined;
      return m.documents && Object.hasOwn(m.documents, type) ? (m.documents[type]?.restorable ?? null) : null;
    },
    () => options.onDocuments?.(),
  );

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
  const hostFailures = new Map<string, { n: number; at: number }>();
  const strikes = new Map<string, { n: number; at: number }>();
  const bump = (counts: Map<string, { n: number; at: number }>, key: string): number => {
    const at = performance.now();
    const prev = counts.get(key);
    const n = prev && at - prev.at < watchdog.window ? prev.n + 1 : 1;
    counts.set(key, { n, at });
    return n;
  };
  const switchedOff = new Set<string>();
  // Выключенные пользователем: сторож их не перезапускает, enable соседа не поднимает.
  const userOff = new Set<string>();
  const subscriptions = new Map<number, Subscription>();
  let subscriptionSeq = 0;
  let chain: Promise<void> = Promise.resolve();
  // Отказ одного шага не отравляет очередь: иначе idle, enable, disable и unload отвечали бы им вечно.
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    const run = chain.then(step);
    chain = run.catch(ignore);
    return run;
  };
  let unloading = false;
  const waiting = new Set<string>();
  const waking = new Map<string, Promise<void>>();
  const activating = new Map<string, Promise<void>>();
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
    const one = own(m.requires, contract) ?? own(m.optional, contract);
    if (one !== undefined) return graph.bindings.get(caller)?.get(contract) === provider && satisfies(version, one);
    const many = own(m.consumes, contract);
    return many !== undefined && satisfies(version, many);
  }

  /** `via-contract`: право вызывающего на аргументы члена, как их объявил поставщик; выполнит вызов поставщик по своим правам. */
  async function checkCall(caller: string, provider: string, contract: string, member: string, args: readonly unknown[]): Promise<void> {
    const method = `${contract}.${member}`;
    for (const g of guardsOf(manifestOf(provider).guards, contract, member)) await gateway.checkFor(manifestOf(caller), method, g.right, guardedValue(args, g, method));
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

  function dropPlugin(pluginId: string, pty: 'release' | 'detach' | 'park' = 'release'): number {
    for (const [id, w] of [...idleWatchers]) if (w.pluginId === pluginId) idleWatchers.delete(id);
    syncIdleTimer();
    for (const [n, s] of [...subscriptions]) if (s.consumer === pluginId || s.provider === pluginId) release(n);
    const given = [...descriptors.values()].flat().filter((d) => d.pluginId === pluginId);
    for (const d of given) dropProvided(d.pluginId, d.contract, d.version);
    for (const [name, owner] of [...commandOwners]) if (owner === pluginId) commandOwners.delete(name);
    const kept = gateway.forget(pluginId, pty);
    layer.forget(pluginId);
    const i = active.indexOf(pluginId);
    if (i >= 0) active.splice(i, 1);
    return kept;
  }

  function affected(gone: readonly string[]): string[] {
    const uses = (consumer: PluginManifest, provider: PluginManifest) =>
      [...(graph.bindings.get(consumer.id)?.values() ?? [])].includes(provider.id) ||
      Object.entries(consumer.consumes).some(([contract, range]) => providesMatching(provider, contract, range));
    return active.filter((id) => !gone.includes(id) && gone.some((p) => uses(manifestOf(id), manifestOf(p))));
  }

  function startHost(hostId: string): Host {
    const handle = options.spawnHost(hostId);
    const host: Host = { id: hostId, handle, endpoint: new Endpoint(handle.port), inflight: new Map(), seq: 0, answered: 0, notes: 0, down: false };
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
        impl[member] = (...args: unknown[]) => callHost(host, d.pluginId, 'call', { pluginId: d.pluginId, contract: d.contract, version: d.version, member, args }, callTimeout);
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
    onRequest('invoke', { ...KEY, caller: 'string', member: 'string', args: 'array' }, async (p) => {
      mine(p.caller);
      const d = descriptors.get(p.contract)?.find((x) => x.pluginId === p.pluginId && x.version === p.version);
      if (!d?.methods.includes(p.member)) throw new CoreError('Unavailable', `${p.contract}@${p.version}.${p.member} у ${p.pluginId} нет`);
      if (!mayUse(p.caller, p.pluginId, p.contract, p.version)) {
        throw new CoreError('NotDeclared', `${p.caller}: ${p.contract}@${p.version} от ${p.pluginId} не объявлен потребляемым`);
      }
      const { pluginId, contract, version, member } = p;
      await checkCall(p.caller, pluginId, contract, member, p.args);
      const target = liveHost(pluginId);
      const callbacks = p.args.map((arg) => marker(arg, CALLBACK));
      if (!callbacks.some((id) => id !== undefined)) return callHost(target, pluginId, 'call', { pluginId, contract, version, member, args: p.args }, callTimeout);
      if (callbacks.some((id) => id !== undefined && typeof id !== 'string')) throw new CoreError('Invalid', 'invoke: номер колбэка не строка');

      const subscription = ++subscriptionSeq;
      subscriptions.set(subscription, { consumer: p.caller, consumerHost: host, provider: pluginId, providerHost: target, callbacks: callbacks as (string | undefined)[] });
      const args = p.args.map((arg, i) => (callbacks[i] === undefined ? arg : { [CALLBACK]: i }));
      return callHost(target, pluginId, 'call', { pluginId, contract, version, member, args, subscription }, callTimeout).then(
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
    onRequest('documents', { pluginId: 'string', method: ['list', 'open', 'save', 'close'], args: 'array' }, (p) => {
      const id = mine(p.pluginId).id;
      if (p.method === 'list') return documents.list(id);
      if (p.method === 'open') return documents.open(id, p.args[0], p.args[1]);
      if (p.method === 'save') return documents.save(id, p.args[0], p.args[1]);
      return documents.close(id, p.args[0]);
    });
    onRequest('os', { pluginId: 'string', method: 'string', args: 'array' }, (p) => {
      const m = mine(p.pluginId);
      if (p.method === 'ui.lock' || p.method === 'ui.unlock') {
        lockCall(m, p.method, p.args);
        return undefined;
      }
      // Системный диалог встал бы поверх экрана замка.
      if (p.method === 'dialog.open' && !layer.allows(m.id)) throw new CoreError('Unavailable', `${m.id}: окно закрыто замком`);
      return gateway.call(m, p.method, p.args);
    });
    onNote('running', { pluginId: 'string' }, (p) => {
      host.running = mine(p.pluginId).id;
      host.notes++;
    });
    onNote('exiting', { pluginId: 'string' }, (p) => {
      host.exiting = mine(p.pluginId).id;
    });
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
      const mark = host.seq;
      endpoint.request('ping', null).then((sent) => {
        host.pingAt = undefined;
        host.answered = mark;
        // Ответ пришёл позже уведомления о коде после пинга (оба в одной порции сообщений): это уведомление не стирается.
        if (typeof sent !== 'number' || host.notes <= sent) host.running = undefined;
      }, ignore);
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
    const inflight = [...host.inflight].sort(([a], [b]) => a - b);
    // Хост не назвал виновника - вызовы до последнего отвеченного пинга он уже принял, их владельцы ждут честно; держит первый принятый после.
    const blocker = (reason === 'hang' ? host.running : host.exiting) ?? inflight.find(([token]) => token > host.answered)?.[1];
    const culprits = blocker === undefined ? [] : [blocker];
    const victims = active.filter((id) => hostOf(id) === host.id);
    // Активация, оборванная падением, успела отдать контракты и команды: без снятия они остались бы заготовками мёртвого хоста.
    const halfway = [...new Set(inflight.map(([, id]) => id))].filter((id) => !active.includes(id) && hostOf(id) === host.id);
    stopHost(host, new CoreError('HostGone', `хост ${host.id} ${reason === 'hang' ? 'завис' : 'упал'}`));
    if (unloading) return;
    record({ kind: 'host-down', hostId: host.id, reason, culprits, plugins: victims, affects: affected(victims) });
    for (const id of [...victims, ...halfway].reverse()) dropPlugin(id, 'detach');

    for (const id of culprits) {
      const n = bump(strikes, id);
      if (n >= watchdog.strikes) {
        switchedOff.add(id);
        record({ pluginId: id, kind: 'switched-off', strikes: n, affects: affected([id]) });
      }
    }
    if (culprits.length === 0) {
      const failures = bump(hostFailures, host.id);
      if (failures >= watchdog.strikes) {
        record({ kind: 'host-abandoned', hostId: host.id, failures, plugins: victims });
        for (const id of victims) gateway.forget(id);
        return;
      }
    }

    const again = graph.order.filter((id) => hostOf(id) === host.id && !switchedOff.has(id) && !userOff.has(id) && (victims.includes(id) || culprits.includes(id) || halfway.includes(id)));
    // pty с persist ждут только тех, кто вернётся; выключенному сторожем их некому забрать.
    for (const id of victims) if (!again.includes(id)) gateway.forget(id);
    if (again.length === 0) return;
    enqueue(async () => {
      if (unloading) return;
      record({ kind: 'host-restart', hostId: host.id, plugins: again });
      for (const id of again) {
        // Человек мог выключить плагин, пока перезапуск ждал очереди: сторож его не поднимает.
        if (userOff.has(id) || switchedOff.has(id)) {
          gateway.forget(id);
          continue;
        }
        await activate(id);
      }
    }).catch((error: unknown) => options.onLog?.(`хост ${host.id}`, `перезапуск не удался: ${errorMessage(error)}`));
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

  function sectionInput(kind: 'config' | 'state', m: PluginManifest): SectionInput | SectionResult | undefined {
    const declared = m[kind];
    const store = options[kind];
    if (!declared || !store) return undefined;
    const input = { version: declared.version, layers: store.raw(m.id) };
    const file = declared.schema;
    if (file === undefined) return input;
    let schema: unknown;
    try {
      if (!options.schema) throw new Error('приложение не читает файлы схем');
      schema = options.schema(m, file);
    } catch (error) {
      return { status: 'invalid', errors: [`${file}: ${errorMessage(error)}`] };
    }
    const compiled = compileSchema(schema);
    return compiled.ok ? { ...input, schema } : { status: 'invalid', errors: compiled.errors.map((e) => `${file}: ${e}`) };
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

  // Вид поднимается вместе с enable и зовёт команды главной части раньше, чем та их зарегистрирует: run ждёт любую идущую активацию.
  function activate(pluginId: string): Promise<void> {
    const started = activateNow(pluginId).finally(() => activating.delete(pluginId));
    activating.set(pluginId, started);
    return started;
  }

  async function activateNow(pluginId: string): Promise<void> {
    const m = manifestOf(pluginId);
    await wakeProviders(m);
    const down = [...(graph.bindings.get(pluginId) ?? [])].find(([c, p]) => c in m.requires && !active.includes(p));
    if (down) {
      record({ pluginId, kind: 'skipped', reason: `поставщик ${down[0]} (${down[1]}) не активен` });
      return;
    }
    const hostId = hostOf(m.id) ?? m.id;
    let host: Host;
    try {
      host = hosts.get(hostId) ?? startHost(hostId);
    } catch (error) {
      gateway.forget(pluginId);
      record({ pluginId, kind: 'failed', hostId, error: `хост не запустился: ${errorMessage(error)}` });
      return;
    }
    const started = performance.now();
    try {
      const config = sectionInput('config', m);
      const state = sectionInput('state', m);
      for (const [kind, s] of [['config', config], ['state', state]] as const) {
        if (s && 'status' in s) {
          record({ pluginId, kind, result: s });
          return;
        }
      }
      gateway.approve(pluginId);
      const params = { pluginId, entry: options.entry?.(m) ?? pluginId, paths: gateway.pathsOf(pluginId), config, state };
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
    const declares = (id: string) => Object.hasOwn(manifestOf(id).commands, command);
    if (!commandOwners.has(command)) {
      const sleeper = [...waiting].find(declares);
      if (sleeper !== undefined) await wake(sleeper);
      else await [...activating].find(([id]) => declares(id))?.[1];
    }
    const owner = commandOwners.get(command);
    if (!owner) throw new CoreError('CommandNotFound', `команды ${command} нет`);
    const spec = manifestOf(owner).commands[command];
    if (!spec) throw new CoreError('CommandNotFound', `команда ${command} не объявлена у ${owner}`);
    checkArgs(command, spec, args);
    return callHost(liveHost(owner), owner, 'command', { pluginId: owner, name: command, args });
  }

  function lockCall(m: PluginManifest, method: string, args: readonly unknown[]): undefined {
    if (m.permissions['ui.lock'] !== true) {
      record({ pluginId: m.id, kind: 'denied', method, detail: 'нет права ui.lock' });
      throw new CoreError('PermissionDenied', `${m.id}: ${method} - нет права ui.lock`);
    }
    if (method === 'ui.unlock') layer.release(m.id);
    else layer.lock(m.id, isRecord(args[0]) && args[0].hideNotifications === true);
    return undefined;
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
    // Идущая активация (wake ленивого) - та же самая: вторая дала бы двойной activate и дубль в active.
    await waking.get(pluginId);
    if (active.includes(pluginId)) return;
    strikes.delete(pluginId);
    switchedOff.delete(pluginId);
    hostFailures.delete(hostOf(pluginId) ?? pluginId);
    const last = (id: string) => journal.findLast((e) => e.pluginId === id && e.kind !== 'key-conflict');
    const follows = (id: string) => {
      const e = last(id);
      return e?.kind === 'skipped' || (e?.kind === 'unloaded' && e.by === pluginId && id !== pluginId);
    };
    const run = enqueue(async () => {
      await activating.get(pluginId);
      if (unloading || active.includes(pluginId)) return;
      record({ pluginId, kind: 'revived' });
      await activate(pluginId);
      for (const id of graph.order) if (!active.includes(id) && !switchedOff.has(id) && !userOff.has(id) && follows(id)) await activate(id);
    });
    await run;
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

  async function deactivate(pluginId: string, by: string, keepPty = false): Promise<void> {
    const host = hosts.get(hostOf(pluginId) ?? '');
    let error: string | undefined;
    try {
      if (host) await callHost(host, pluginId, 'deactivate', { pluginId }, activationTimeout);
    } catch (e) {
      error = errorMessage(e);
    }
    const keptPty = dropPlugin(pluginId, keepPty ? 'park' : 'release');
    record({ pluginId, kind: 'unloaded', by, ...(error !== undefined && { error }), ...(keptPty > 0 && { keptPty }) });
    // Пустой хост гасится: следующая активация импортирует код плагина заново, в новом процессе.
    if (host && !host.down && !active.some((id) => hostOf(id) === host.id)) stopHost(host, new CoreError('HostGone', `хост ${host.id} без плагинов`));
  }

  async function disable(pluginId: string, options: DisableOptions = {}): Promise<void> {
    guard(pluginId);
    const owner = [...(active.includes(pluginId) ? dependents(pluginId) : [pluginId])].find((id) => layer.isOwner(id));
    if (owner !== undefined) throw new CoreError('Invalid', `окно закрыто замком ${owner}: выключить его из-под замка нельзя`);
    userOff.add(pluginId);
    waiting.delete(pluginId);
    await waking.get(pluginId);
    const run = enqueue(async () => {
      if (unloading) return;
      if (!active.includes(pluginId)) {
        record({ pluginId, kind: 'unloaded', by: pluginId });
        return;
      }
      const gone = dependents(pluginId);
      for (const id of [...active].reverse()) if (gone.has(id)) await deactivate(id, pluginId, options.keepPty === true);
    });
    await run;
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

  // Окно закрыто до первого кадра: иначе виды успели бы показаться до активации плагина замка.
  if (!options.safeMode) for (const pluginId of graph.order) if (manifestOf(pluginId).lock) layer.lock(pluginId, false);
  for (const pluginId of graph.order) {
    if (options.safeMode) {
      record({ pluginId, kind: 'safe-mode' });
      continue;
    }
    if (manifestOf(pluginId).activation === 'lazy' && !manifestOf(pluginId).lock) {
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
    async callAs(caller, contract, major, member, args) {
      const impl = registry.get(caller, contract, major);
      if (impl === undefined) throw new CoreError('Unavailable', `${contract}: поставщика сейчас нет`);
      const fn = Object.hasOwn(impl, member) ? impl[member] : undefined;
      if (typeof fn !== 'function') throw new CoreError('Invalid', `${contract}.${member}: не метод контракта`);
      const provider = graph.bindings.get(caller)?.get(contract);
      if (provider === undefined) throw new CoreError('Unavailable', `${contract}: поставщика сейчас нет`);
      await checkCall(caller, provider, contract, member, args);
      return (fn as (...xs: unknown[]) => unknown).apply(impl, [...args]);
    },
    manifests: known,
    hostOf,
    keybindings: [...keys.values()],
    keybinding(key) {
      const k = keys.get(key);
      if (!k || !layer.allows(k.pluginId)) return undefined;
      return k.pluginId === WINDOW_OWNER || active.includes(k.pluginId) || waiting.has(k.pluginId) || waking.has(k.pluginId) ? k : undefined;
    },
    get window() {
      return layer.snapshot;
    },
    get documents() {
      return documents.rows((id) => active.includes(id) || waiting.has(id));
    },
    async closeDocument(id) {
      const doc = await documents.closeAny(id);
      const host = active.includes(doc.pluginId) ? hosts.get(hostOf(doc.pluginId) ?? doc.pluginId) : undefined;
      if (host && !host.down) host.endpoint.notify('document.closed', { pluginId: doc.pluginId, id });
    },
    showDialog(pluginId, view, spec) {
      viewKey(pluginId, view);
      if (unloading) throw new CoreError('Unavailable', 'ядро выгружается');
      return layer.show(pluginId, view, spec);
    },
    answerDialog: (id, choice) => layer.answer(id, choice),
    keysOf: (pluginId) => Object.fromEntries([...keys.values()].filter((k) => k.pluginId === pluginId).map((k) => [k.command, k.key])),
    wake,
    openTerminal: (pluginId, ticket, sink) => gateway.openTerminal(pluginId, ticket, sink),
    viewState: (pluginId, view) => {
      const value = viewMemory()[viewKey(pluginId, view)];
      return value === undefined ? undefined : structuredClone(value);
    },
    setViewState(pluginId, view, value) {
      const key = viewKey(pluginId, view);
      const text = JSON.stringify(value) as string | undefined;
      if (text !== undefined && Buffer.byteLength(text) > VIEW_STATE_MAX) throw new CoreError('Invalid', `${key}: память вида больше ${String(VIEW_STATE_MAX)} байт`);
      const data: unknown = text === undefined ? undefined : JSON.parse(text);
      const write = viewWrites.then(async () => {
        if (!options.state) throw new CoreError('Unavailable', 'state воркспейса нет');
        const doc = Object.fromEntries(Object.entries(viewMemory()).filter(([k]) => k !== key));
        if (data !== undefined) doc[key] = data;
        await options.state.write('workspace', VIEW_STATE, 1, doc);
      });
      viewWrites = write.catch(() => undefined);
      return write;
    },
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
    async setEnabled(next) {
      const want = new Set(next);
      const restart: string[] = [];
      const failed: string[] = [];
      const inGraph = (id: string) => graph.order.includes(id);
      const removed = [...listed].filter((id) => !want.has(id));
      const added = [...want].filter((id) => !listed.has(id));
      listed = want;
      for (const id of removed) {
        if (!inGraph(id)) continue;
        try {
          await disable(id);
        } catch (error) {
          failed.push(`${id}: ${errorMessage(error)}`);
        }
      }
      for (const id of added) {
        if (inGraph(id)) await enable(id);
        else if (!enabled.has(id)) restart.push(id);
      }
      return { restart, failed };
    },
    disablePreview(pluginId) {
      guard(pluginId);
      const plugins = active.includes(pluginId) ? [...dependents(pluginId)] : [];
      return { plugins, ptys: plugins.flatMap((id) => gateway.ptysOf(id).map((p) => ({ ...p, pluginId: id }))) };
    },
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
      gateway.releaseAllPty();
      layer.clear();
      for (const host of [...hosts.values()]) stopHost(host, new CoreError('HostGone', 'ядро выгружено'));
      denials.flush();
    },
  };
}
