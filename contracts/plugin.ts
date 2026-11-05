import type { ContractName, ContractType, Major, MajorOf, Remote, VersionOf } from './index.ts';
import type { PluginOs, PluginSecrets } from './os.ts';

export interface Disposable {
  dispose(): void;
}

/** Снимает добавленное в обратном порядке при выгрузке плагина. */
export interface DisposableStore extends Disposable {
  readonly disposed: boolean;
  add(...items: Disposable[]): void;
}

/** Аргументы уже сверены ядром со схемой из манифеста, но обработчик сужает их сам: тип с провода не выводится. */
export type CommandHandler = (...args: unknown[]) => unknown;

/** Слои от нижнего к верхнему: верхний перекрывает нижний. Для config - user и workspace. */
export type Layer = string;

export interface SectionSpec {
  readonly version: number;
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Приводит данные слоя из `fromVersion` к `version`; бросок - отказ миграции. */
  readonly migrate?: (fromVersion: number, data: Record<string, unknown>) => Record<string, unknown>;
  /** Ошибки итогового значения; пустой список - значение годно. */
  readonly validate?: (value: Readonly<Record<string, unknown>>) => readonly string[];
}

export type SectionResult =
  | { readonly status: 'ok'; readonly value: Record<string, unknown>; readonly migrated: readonly Layer[] }
  | { readonly status: 'newer'; readonly layer: Layer; readonly found: number; readonly expected: number }
  | { readonly status: 'migrate-error'; readonly layer: Layer; readonly from: number; readonly error: string }
  | { readonly status: 'invalid'; readonly errors: readonly string[] };

export interface PluginSection {
  readonly result: SectionResult;
  get(): Record<string, unknown>;
  set(layer: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  onChange(listener: (value: Record<string, unknown>) => void): Disposable;
}

export interface Provider<T> {
  readonly pluginId: string;
  readonly version: string;
  readonly impl: T;
}

/** Код отказа ядра; отказ приходит плагину как `Error` с полем `code`. */
export type CoreErrorCode =
  | 'NotDeclared'
  | 'AlreadyProvided'
  | 'Unavailable'
  | 'NotCloneable'
  | 'Invalid'
  | 'CommandNotFound'
  | 'CommandConflict'
  | 'HostGone'
  | 'Timeout'
  | 'Remote'
  | 'PermissionDenied'
  | 'NotFound';

/** Всё, что плагин видит от ядра; методы чужих контрактов всегда асинхронны - вызов идёт через границу хоста. */
export interface PluginContext {
  readonly pluginId: string;
  readonly subscriptions: DisposableStore;
  readonly contracts: {
    /** Мажорная часть версии выбирает тип impl из карты Contracts. */
    provide<K extends ContractName, V extends VersionOf<K>>(contract: K, version: V, impl: ContractType<K, MajorOf<V> & Major<K>>): Disposable;
    /** Мажорная версия обязательна: ядро сверяет её с диапазоном из манифеста, и тип ответа ей соответствует. */
    get<K extends ContractName, M extends Major<K>>(contract: K, major: M): Remote<ContractType<K, M>> | undefined;
    all<K extends ContractName, M extends Major<K>>(contract: K, major: M): Provider<Remote<ContractType<K, M>>>[];
    onChange(contract: ContractName, listener: () => void): Disposable;
  };
  readonly commands: {
    register(name: string, handler: CommandHandler): Disposable;
    run(name: string, ...args: unknown[]): Promise<unknown>;
  };
  readonly config?: PluginSection;
  readonly state?: PluginSection;
  /** Доступ к ОС через шлюз ядра по правам из манифеста. */
  readonly os: PluginOs;
  readonly secrets: PluginSecrets;
  readonly window: PluginWindow;
  readonly system: PluginSystem;
  log(message: string): void;
}

export interface PluginWindow {
  onFocusChange(listener: (focused: boolean) => void): Disposable;
}

/** События ОС; слушатель, бросивший исключение, пишет в журнал плагина и не мешает соседям. */
export interface PluginSystem {
  onSuspend(listener: () => void): Disposable;
  onResume(listener: () => void): Disposable;
  onScreenLock(listener: () => void): Disposable;
  /** Один раз на каждый простой пользователя от `seconds` секунд; после активности срабатывает снова. */
  onIdle(seconds: number, listener: () => void): Disposable;
  /** Ядро ждёт слушателей не дольше бюджета приложения, потом хост завершается. */
  onBeforeQuit(listener: () => void | Promise<void>): Disposable;
}

/** Модуль главной части плагина: его `default` грузит хост. */
export interface PluginModule {
  readonly config?: Omit<SectionSpec, 'version'>;
  readonly state?: Omit<SectionSpec, 'version'>;
  activate(ctx: PluginContext): Disposable | undefined | Promise<Disposable | undefined>;
}
