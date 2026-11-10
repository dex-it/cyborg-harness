import { toDisposable, type Disposable } from './disposable.ts';
import { CoreError } from './errors.ts';
import type { ContractGraph } from './graph.ts';
import type { PluginManifest } from './manifest.ts';
import { allowsMajor, compareVersions, parseVersion, satisfies } from './semver.ts';
import { own } from './wire.ts';

export type ContractImpl = Readonly<Record<string, unknown>>;

const major = (version: string): number => parseVersion(version)?.[0] ?? -1;
const newer = (a: string, b: string): boolean => compareVersions(parseVersion(a) ?? [0, 0, 0], parseVersion(b) ?? [0, 0, 0]) > 0;

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
    const declared = own(this.#manifest(pluginId).provides, contract);
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

  /** requires и optional: связанный графом поставщик нужной мажорной версии; для optional без поставщика - undefined. */
  get(consumerId: string, contract: string, wanted: number): ContractImpl | undefined {
    const m = this.#manifest(consumerId);
    const range = own(m.requires, contract) ?? own(m.optional, contract);
    if (range === undefined) throw new CoreError('NotDeclared', `${consumerId}: ${contract} нет в requires и optional`);
    assertMajor(consumerId, contract, range, wanted);
    const providerId = this.#bindings.get(consumerId)?.get(contract);
    const entry = providerId === undefined ? undefined : this.#best(contract, range, providerId, wanted);
    if (entry) return entry.impl;
    if (Object.hasOwn(m.requires, contract)) throw new CoreError('Unavailable', `${consumerId}: поставщик ${contract} не отдал контракт`);
    return undefined;
  }

  /** Собственный контракт плагина: так ядро читает состояние пункта меню у плагина, который сам владеет состоянием. Не отдан сейчас - undefined. */
  provided(pluginId: string, contract: string, wanted: number): ContractImpl | undefined {
    const mine = (this.#entries.get(contract) ?? []).filter((e) => e.pluginId === pluginId && major(e.version) === wanted);
    return mine.reduce<Provider | undefined>((best, e) => (!best || newer(e.version, best.version) ? e : best), undefined)?.impl;
  }

  /** consumes: все отданные сейчас поставщики подходящей версии этой мажорной. */
  all(consumerId: string, contract: string, wanted: number): Provider[] {
    const range = own(this.#manifest(consumerId).consumes, contract);
    if (range === undefined) throw new CoreError('NotDeclared', `${consumerId}: ${contract} нет в consumes`);
    assertMajor(consumerId, contract, range, wanted);
    const byPlugin = new Map<string, Provider>();
    for (const e of this.#entries.get(contract) ?? []) {
      if (e.pluginId === consumerId || byPlugin.has(e.pluginId)) continue;
      const best = this.#best(contract, range, e.pluginId, wanted);
      if (best) byPlugin.set(e.pluginId, best);
    }
    return [...byPlugin.values()];
  }

  onChange(consumerId: string, contract: string, listener: () => void): Disposable {
    const m = this.#manifest(consumerId);
    if (![m.requires, m.optional, m.consumes].some((declared) => Object.hasOwn(declared, contract))) {
      throw new CoreError('NotDeclared', `${consumerId}: ${contract} не объявлен потребляемым`);
    }
    const set = this.#listeners.get(contract) ?? new Set();
    set.add(listener);
    this.#listeners.set(contract, set);
    return toDisposable(() => set.delete(listener));
  }

  /** Поставщик может отдавать две мажорные сразу, а тип у потребителя - ровно одной. */
  #best(contract: string, range: string, pluginId: string, wanted: number): Provider | undefined {
    const fit = (this.#entries.get(contract) ?? []).filter((e) => e.pluginId === pluginId && major(e.version) === wanted && satisfies(e.version, range));
    return fit.reduce<Provider | undefined>((best, e) => (!best || newer(e.version, best.version) ? e : best), undefined);
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

/** Мажорная версия в get и all связывает тип у потребителя с тем, что придёт в рантайме. */
function assertMajor(consumerId: string, contract: string, range: string, wanted: unknown): asserts wanted is number {
  if (typeof wanted !== 'number' || !allowsMajor(range, wanted)) {
    throw new CoreError('NotDeclared', `${consumerId}: ${contract} объявлен как ${range}, мажорной версии ${String(wanted)} в нём нет`);
  }
}
