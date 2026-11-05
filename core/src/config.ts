import type { Layer, SectionResult, SectionSpec } from '@cyborg/contracts';
import { toDisposable, type Disposable } from './disposable.ts';
import { errorMessage } from './errors.ts';
import { isRecord } from './manifest.ts';

export type { Layer, SectionResult, SectionSpec };

export const VERSION_KEY = '$version';

interface Resolved { readonly result: SectionResult; readonly layers: ReadonlyMap<Layer, Record<string, unknown>> }

/** Слой новее манифеста - откат плагина: раздел не читается, чтобы старый код не затёр новые данные. */
export function resolveSection(spec: SectionSpec, layers: readonly (readonly [Layer, unknown])[]): Resolved {
  const current = new Map<Layer, Record<string, unknown>>();
  const migrated: Layer[] = [];
  for (const [layer, raw] of layers) {
    if (raw === undefined) continue;
    if (!isRecord(raw)) return fail({ status: 'invalid', errors: [`${layer}: раздел не объект`] });
    const { [VERSION_KEY]: stored, ...data } = raw;
    const from = stored ?? 1;
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
      return fail({ status: 'invalid', errors: [`${layer}: ${VERSION_KEY} не целое >= 1`] });
    }
    if (from > spec.version) return fail({ status: 'newer', layer, found: from, expected: spec.version });
    if (from === spec.version) {
      current.set(layer, data);
      continue;
    }
    if (!spec.migrate) return fail({ status: 'migrate-error', layer, from, error: 'у плагина нет migrate' });
    try {
      const next = spec.migrate(from, structuredClone(data));
      if (!isRecord(next)) throw new Error('migrate вернул не объект');
      current.set(layer, next);
      migrated.push(layer);
    } catch (error) {
      return fail({ status: 'migrate-error', layer, from, error: errorMessage(error) });
    }
  }

  let value: Record<string, unknown> = structuredClone({ ...spec.defaults });
  for (const [layer] of layers) {
    const data = current.get(layer);
    if (data) value = deepMerge(value, data);
  }
  const errors = spec.validate?.(value) ?? [];
  if (errors.length > 0) return fail({ status: 'invalid', errors });
  return { result: { status: 'ok', value, migrated }, layers: current };
}

function fail(result: SectionResult): Resolved {
  return { result, layers: new Map() };
}

/** Объекты сливаются по ключам, массивы и скаляры заменяются целиком. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] = isRecord(prev) && isRecord(value) ? deepMerge(prev, value) : structuredClone(value);
  }
  return out;
}

/** Хранилище документа слоя: документ - разделы по id плагина. */
export interface LayerStore {
  load(layer: Layer): Promise<Record<string, unknown> | undefined>;
  save(layer: Layer, document: Record<string, unknown>): Promise<void>;
}

export interface SectionHandle {
  readonly result: SectionResult;
  get(): Record<string, unknown>;
  /** Пишет данные раздела в слой целиком; итог - заново слитое значение. */
  set(layer: Layer, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  onChange(listener: (value: Record<string, unknown>) => void): Disposable;
}

/** Один механизм для config (слои user и workspace) и state (один слой воркспейса). */
export class SectionStore {
  readonly #store: LayerStore;
  readonly #layers: readonly Layer[];
  readonly #documents = new Map<Layer, Record<string, unknown>>();
  // Запись слоя - снимок всего документа: параллельные записи разных разделов затёрли бы друг друга.
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(store: LayerStore, layers: readonly Layer[]) {
    this.#store = store;
    this.#layers = layers;
  }

  static async open(store: LayerStore, layers: readonly Layer[]): Promise<SectionStore> {
    const s = new SectionStore(store, layers);
    for (const layer of layers) {
      const doc = await store.load(layer);
      s.#documents.set(layer, isRecord(doc) ? doc : {});
    }
    return s;
  }

  /** Раздел без миграций - для собственных разделов ядра вроде `plugins.enabled`. */
  raw(id: string): readonly (readonly [Layer, unknown])[] {
    return this.#layers.map((layer) => [layer, this.#documents.get(layer)?.[id]] as const);
  }

  async section(id: string, spec: SectionSpec): Promise<SectionHandle> {
    const { result, layers } = resolveSection(spec, this.raw(id));
    if (result.status === 'ok') {
      for (const [layer, data] of layers) if (result.migrated.includes(layer)) await this.write(layer, id, spec.version, data);
    }
    const listeners = new Set<(value: Record<string, unknown>) => void>();
    let value = result.status === 'ok' ? result.value : structuredClone({ ...spec.defaults });

    return {
      result,
      get: () => structuredClone(value),
      set: async (layer, data) => {
        if (result.status !== 'ok') throw new Error(`раздел ${id} не загружен: ${result.status}`);
        if (!this.#layers.includes(layer)) throw new Error(`слоя ${layer} нет`);
        const candidate = this.raw(id).map(([l, raw]) => [l, l === layer ? { ...data, [VERSION_KEY]: spec.version } : raw] as const);
        const next = resolveSection(spec, candidate).result;
        if (next.status !== 'ok') throw new Error(`раздел ${id}: ${JSON.stringify(next)}`);
        await this.write(layer, id, spec.version, data);
        value = next.value;
        for (const listener of [...listeners]) listener(structuredClone(value));
        return structuredClone(value);
      },
      onChange: (listener) => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    };
  }

  /** Перечитывает слои после правки извне; возвращает id разделов, которые поменялись. Ошибка чтения - документы прежние. */
  reload(): Promise<string[]> {
    return this.#serial(() => this.#reload());
  }

  async #reload(): Promise<string[]> {
    const next = new Map<Layer, Record<string, unknown>>();
    for (const layer of this.#layers) {
      const doc = await this.#store.load(layer);
      next.set(layer, isRecord(doc) ? doc : {});
    }
    const changed = new Set<string>();
    for (const [layer, doc] of next) {
      const prev = this.#documents.get(layer) ?? {};
      for (const id of new Set([...Object.keys(prev), ...Object.keys(doc)])) if (JSON.stringify(prev[id]) !== JSON.stringify(doc[id])) changed.add(id);
    }
    for (const [layer, doc] of next) this.#documents.set(layer, doc);
    return [...changed];
  }

  /** Пишет раздел в слой как есть; миграцию и проверку уже сделал хост плагина. */
  async write(layer: Layer, id: string, version: number, data: Record<string, unknown>): Promise<void> {
    if (!this.#layers.includes(layer)) throw new Error(`слоя ${layer} нет`);
    const section = { [VERSION_KEY]: version, ...structuredClone(data) };
    await this.#serial(async () => {
      // Основа - файл, а не память: правка извне, которую слежение ещё не подхватило, не стирается чужим разделом.
      const fresh = await this.#store.load(layer);
      await this.#store.save(layer, { ...(isRecord(fresh) ? fresh : this.#documents.get(layer)), [id]: section });
      // В памяти - только свой раздел: правку извне разделам сообщит reload по слежению.
      this.#documents.set(layer, { ...this.#documents.get(layer), [id]: section });
    });
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
