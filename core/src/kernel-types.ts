import type { PtyInfo } from '@cyborg-harness/contracts';
import type { SectionResult, SectionStore } from './config.ts';
import type { DocumentRow } from './documents.ts';
import type { ContractGraph, Rejection } from './graph.ts';
import type { SystemEvent } from './host-runtime.ts';
import type { ResourceLimits } from './limits.ts';
import type { PluginManifest } from './manifest.ts';
import type { OsEnvironment } from './os-gateway.ts';
import type { KeptPty, TerminalSink, TerminalView } from './pty.ts';
import type { ContractRegistry } from './registry.ts';
import type { SpawnHost } from './transports.ts';
import type { WindowSnapshot, WindowTitle } from './window-layer.ts';


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
  /** Шлюз `ctx.os` отказал: вызов вне прав манифеста; `reason: 'window'` - окно не пустило вид на чужой адрес; `reason: 'command-callers'` - команда не открыта главным частям других плагинов. */
  | {
      readonly pluginId: string;
      readonly kind: 'denied';
      readonly method: string;
      readonly detail: string;
      readonly reason?: 'via-contract' | 'window' | 'command-callers';
      /** Столько таких же отказов склеено за окно после первого. */
      readonly repeats?: number;
    }
  /**
   * Плагин `pluginId` вызвал член контракта `contract` поставщика `provider`, помеченный `@deprecated` в его манифесте (`provides.<контракт>.deprecated`).
   * Пишется после проверок вызова; повторы склеиваются за окно, `repeats` - сколько их было после первой записи.
   */
  | {
      readonly pluginId: string;
      readonly kind: 'deprecated-call';
      readonly provider: string;
      readonly contract: string;
      readonly member: string;
      readonly repeats?: number;
    }
  /** Снят по disable: сам (`by` - он же) или вместе с поставщиком, которого требовал. */
  | { readonly pluginId: string; readonly kind: 'unloaded'; readonly by: string; readonly error?: string; readonly keptPty?: number }
  /** pty без владельца не взят через `attach` за льготное время после падения хоста или активации плагина и завершён. */
  | { readonly pluginId: string; readonly kind: 'pty-expired'; readonly id: string; readonly program: string; readonly graceMs: number }
  /** Сочетание объявлено и другим плагином; нажатие получает `winner`. */
  | { readonly pluginId: string; readonly kind: 'key-conflict'; readonly key: string; readonly command: string; readonly winner: string }
  /** Привязка `plugins.keybindings` не применена: сочетание не разобралось или команды нет ни у одного плагина. */
  | { readonly pluginId?: undefined; readonly kind: 'key-ignored'; readonly key: string; readonly command: string | null; readonly reason: string }
  /** Сторонний плагин назван в группе plugins.hosts с другими - ядро всё равно дало ему свой хост. */
  | { readonly pluginId: string; readonly kind: 'host-isolated'; readonly group: string; readonly hostId: string }
  /** Промис плагина отклонён без обработчика; хост держится, плагину страйк. */
  | { readonly pluginId: string; readonly kind: 'unhandled-rejection'; readonly error: string }
  /** Плагин поставки просит свой хост (`"host": "own"`), а группа plugins.hosts сажает его к соседям: действует группа. */
  | { readonly pluginId: string; readonly kind: 'host-own-grouped'; readonly group: string; readonly neighbours: readonly string[] }
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
  /** Префиксы пространств поставки (`app.`): сторонний плагин с таким `id` или `provides` отвергается до графа. Без `bundled` проверка выключена - поставку не от чего отличить. */
  readonly reservedPrefixes?: readonly string[] | undefined;
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
  /** Пределы ресурсов плагина поверх `LIMITS` и `os.limits`. */
  readonly limits?: Partial<ResourceLimits> | undefined;
  /** Под какую ОС раскрыть `CmdOrCtrl`; по умолчанию текущая. */
  readonly platform?: string | undefined;
  /** Секунды простоя пользователя по ОС; без него `onIdle` не срабатывает. */
  readonly idleSeconds?: (() => number) | undefined;
  /** Как часто спрашивать `idleSeconds`, пока есть подписчики, мс. */
  readonly idlePoll?: number | undefined;
  /** Граф решён, код плагинов ещё не запускался. */
  readonly onGraph?: ((graph: ContractGraph) => Promise<void> | undefined) | undefined;
  readonly onJournal?: ((entry: JournalEntry) => void) | undefined;
  readonly onLog?: ((pluginId: string, message: string) => void) | undefined;
  /** Из чего ядро собирает заголовок окна вокруг фрагментов плагинов. */
  readonly windowTitle?: WindowTitle | undefined;
  /** Диалог на экране, очередь и замки поменялись: приложение перерисовывает слой окна. */
  readonly onWindow?: ((snapshot: WindowSnapshot) => void) | undefined;
  /** Документ открыт, переименован или закрыт: приложение перерисовывает вкладки по `kernel.documents`. */
  readonly onDocuments?: (() => void) | undefined;
  /** Оставленные процессы выключенных плагинов поменялись: приложение перечитывает `kernel.keptPty()`. */
  readonly onKeptPty?: (() => void) | undefined;
}

export interface DisableOptions {
  readonly keepPty?: boolean;
}

export interface DisablePreview {
  /** Сам плагин и активные, кто требует его через requires. */
  readonly plugins: readonly string[];
  readonly ptys: readonly (PtyInfo & { readonly pluginId: string })[];
}

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
  /** Команда по просьбе вида плагина `pluginId`: исполняет её только он, чужую (в том числе объявленную и им) ядро не запускает - `PermissionDenied`. `callers` не проверяется: вид зовёт как пользователь. */
  runOwn(pluginId: string, command: string, ...args: unknown[]): Promise<unknown>;
  /** Раздел поменялся извне (файл воркспейса правили руками): активные владельцы получают `onChange`, не прошедший проверку - запись в журнал. */
  reloadSections(kind: 'config' | 'state', ids: readonly string[]): Promise<void>;
  /** Дожидается перезапусков хостов, начатых сторожем, и ленивых активаций. */
  idle(): Promise<void>;
  /** Плагин с `activation: "lazy"` нужен сейчас - например, показан его вид; активному или не ленивому ничего не делает. */
  wake(pluginId: string): Promise<void>;
  /** Вид плагина открывает pty по билету `share()` его главной части; вывод идёт в `sink` мимо хоста. */
  openTerminal(pluginId: string, ticket: string, sink: TerminalSink): TerminalView;
  /** Процессы, оставленные человеком при выключении плагинов, пока плагин не вернулся: без показа приложением их не видно до выхода. */
  keptPty(): KeptPty[];
  /** Человек завершил оставленный процесс или убрал завершившийся; чужой или не оставленный id - `NotFound`. */
  endKeptPty(id: string): void;
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
  /** Окно не пустило вид плагина на чужой адрес: запись `denied` в журнал плагина, повторы склеиваются. */
  viewDenied(pluginId: string, url: string): void;
  /** Свои команды плагина с сочетаниями, как их ловит `keybinding`. */
  keysOf(pluginId: string): Readonly<Record<string, string>>;
  /** Событие окна или ОС от приложения: ядро раздаёт его активным плагинам. */
  emit(event: SystemEvent): void;
  /** Слушатели `onBeforeQuit` всех хостов, не дольше `budget` мс; после него приложение зовёт `unload`. */
  beforeQuit(budget?: number): Promise<void>;
  /** Снимает плагины в обратном порядке активации и гасит хосты. */
  unload(): Promise<void>;
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
