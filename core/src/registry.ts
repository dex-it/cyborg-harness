import { toDisposable, type Disposable } from './disposable.ts';
import { CoreError } from './errors.ts';
import type { ContractGraph } from './graph.ts';
import type { PluginManifest } from './manifest.ts';
import { parseVersion, satisfies } from './semver.ts';

export type ContractImpl = Readonly<Record<string, unknown>>;

export interface Provider<T = ContractImpl> {
  readonly pluginId: string;
  readonly version: string;
  readonly impl: T;
}

/** Реестр контрактов: потребитель видит только то, что объявил в манифесте. */
export class ContractRegistry {
  readonly #manifests: ReadonlyMap<string, PluginManifest>;
  readonly #bindings: ContractGraph['bindings'];
  readonly #entries = new Map<string, Provider[]>();
  readonly #listeners = new Map<string, Set<() => void>>();

  constructor(manifests: readonly PluginManifest[], bindings: ContractGraph['bindings']) {
    this.#manifests = new Map(manifests.map((m) => [m.id, m]));
    this.#bindings = bindings;
  }

  /** Проверка provide без записи: хост отвечает плагину синхронно, не дожидаясь ядра. */
  assertCanProvide(pluginId: string, contract: string, version: string): void {
    const declared = this.#manifest(pluginId).provides[contract];
    if (!declared?.includes(version)) {
      throw new CoreError('NotDeclared', `${pluginId}: контракт ${contract}@${version} не объявлен в provides`);
    }
    if ((this.#entries.get(contract) ?? []).some((e) => e.pluginId === pluginId && e.version === version)) {
      throw new CoreError('AlreadyProvided', `${pluginId}: ${contract}@${version} уже отдан`);
    }
  }

  provide(pluginId: string, contract: string, version: string, impl: ContractImpl): Disposable {
    this.assertCanProvide(pluginId, contract, version);
    const entry: Provider = { pluginId, version, impl };
    this.#entries.set(contract, [...(this.#entries.get(contract) ?? []), entry]);
    this.#emit(contract);
    return toDisposable(() => {
      this.#entries.set(contract, (this.#entries.get(contract) ?? []).filter((e) => e !== entry));
      this.#emit(contract);
    });
  }

  /** Зеркало в хосте: список поставщиков приходит от ядра целиком, уже проверенным. */
  replace(contract: string, providers: readonly Provider[]): void {
    this.#entries.set(contract, [...providers]);
    this.#emit(contract);
  }

  /** requires и optional: связанный графом поставщик; для optional без поставщика - undefined. */
  get<T = ContractImpl>(consumerId: string, contract: string): T | undefined {
    const m = this.#manifest(consumerId);
    const range = m.requires[contract] ?? m.optional[contract];
    if (range === undefined) throw new CoreError('NotDeclared', `${consumerId}: ${contract} нет в requires и optional`);
    const providerId = this.#bindings.get(consumerId)?.get(contract);
    const entry = providerId === undefined ? undefined : this.#best(contract, range, providerId);
    if (entry) return entry.impl as T;
    if (contract in m.requires) throw new CoreError('Unavailable', `${consumerId}: поставщик ${contract} не отдал контракт`);
    return undefined;
  }

  /** consumes: все отданные сейчас поставщики подходящей версии. */
  all<T = ContractImpl>(consumerId: string, contract: string): Provider<T>[] {
    const range = this.#manifest(consumerId).consumes[contract];
    if (range === undefined) throw new CoreError('NotDeclared', `${consumerId}: ${contract} нет в consumes`);
    const byPlugin = new Map<string, Provider>();
    for (const e of this.#entries.get(contract) ?? []) {
      if (e.pluginId === consumerId || byPlugin.has(e.pluginId)) continue;
      const best = this.#best(contract, range, e.pluginId);
      if (best) byPlugin.set(e.pluginId, best);
    }
    return [...byPlugin.values()] as Provider<T>[];
  }

  onChange(consumerId: string, contract: string, listener: () => void): Disposable {
    const m = this.#manifest(consumerId);
    if (!(contract in m.requires || contract in m.optional || contract in m.consumes)) {
      throw new CoreError('NotDeclared', `${consumerId}: ${contract} не объявлен потребляемым`);
    }
    const set = this.#listeners.get(contract) ?? new Set();
    set.add(listener);
    this.#listeners.set(contract, set);
    return toDisposable(() => set.delete(listener));
  }

  /** Старшая подходящая версия: поставщик может отдавать две мажорные сразу. */
  #best(contract: string, range: string, pluginId: string): Provider | undefined {
    let best: Provider | undefined;
    for (const e of this.#entries.get(contract) ?? []) {
      if (e.pluginId !== pluginId || !satisfies(e.version, range)) continue;
      if (!best || parseVersion(e.version)![0] > parseVersion(best.version)![0]) best = e;
    }
    return best;
  }

  #emit(contract: string): void {
    for (const listener of [...(this.#listeners.get(contract) ?? [])]) {
      try {
        listener();
      } catch {
        // Слушатель одного плагина не должен сорвать уведомление остальных.
      }
    }
  }

  #manifest(pluginId: string): PluginManifest {
    const m = this.#manifests.get(pluginId);
    if (!m) throw new CoreError('NotDeclared', `плагин ${pluginId} не загружен`);
    return m;
  }
}
