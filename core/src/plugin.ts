import type { SectionResult, SectionSpec } from './config.ts';
import type { Disposable, DisposableStore } from './disposable.ts';
import type { ContractImpl, Provider } from './registry.ts';

export type CommandHandler = (...args: any[]) => unknown;

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
    provide(contract: string, version: string, impl: ContractImpl): Disposable;
    get<T = ContractImpl>(contract: string): T | undefined;
    all<T = ContractImpl>(contract: string): Provider<T>[];
    onChange(contract: string, listener: () => void): Disposable;
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
  activate(ctx: PluginContext): void | Disposable | Promise<void | Disposable>;
}
