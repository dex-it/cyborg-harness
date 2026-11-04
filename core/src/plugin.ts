import type { SectionResult, SectionSpec } from './config.ts';
import type { Disposable, DisposableStore } from './disposable.ts';
import type { ContractName, ContractType, Major, MajorOf, Remote, VersionOf } from '@cyborg/contracts';
import type { Provider } from './registry.ts';

/** Аргументы уже сверены ядром со схемой из манифеста, но обработчик сужает их сам: тип с провода не выводится. */
export type CommandHandler = (...args: unknown[]) => unknown;

export interface PluginSection {
  readonly result: SectionResult;
  get(): Record<string, unknown>;
  set(layer: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  onChange(listener: (value: Record<string, unknown>) => void): Disposable;
}

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
  log(message: string): void;
}

export interface PluginModule {
  readonly config?: Omit<SectionSpec, 'version'>;
  readonly state?: Omit<SectionSpec, 'version'>;
  activate(ctx: PluginContext): Disposable | undefined | Promise<Disposable | undefined>;
}
