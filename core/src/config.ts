import { toDisposable, type Disposable } from './disposable.ts';
import { isRecord } from './manifest.ts';

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
      return fail({ status: 'migrate-error', layer, from, error: (error as Error).message });
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

  /** Пишет раздел в слой как есть; миграцию и проверку уже сделал хост плагина. */
  async write(layer: Layer, id: string, version: number, data: Record<string, unknown>): Promise<void> {
    if (!this.#layers.includes(layer)) throw new Error(`слоя ${layer} нет`);
    const doc = { ...this.#documents.get(layer), [id]: { [VERSION_KEY]: version, ...structuredClone(data) } };
    await this.#store.save(layer, doc);
    this.#documents.set(layer, doc);
  }
}
