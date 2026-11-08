import type { LayerStore, SecretStore } from '@cyborg-harness/core';

export type LayerDocuments = Record<string, Record<string, unknown>>;

export interface MemoryStore {
  readonly store: LayerStore;
  /** Документы слоёв (`user`, `workspace`) как их хранит `store`. */
  readonly docs: Map<string, Record<string, unknown>>;
  /** Слои в порядке записей: так тест видит, что ядро не пишет лишнего. */
  readonly saves: string[];
}

/** Слои `config` и `state` в памяти. Документы копируются при чтении и записи, как при записи в файл: мутация снаружи слой не меняет. */
export function memoryStore(initial: LayerDocuments = {}): MemoryStore {
  const docs = new Map(Object.entries(structuredClone(initial)));
  const saves: string[] = [];
  const store: LayerStore = {
    load: async (layer) => structuredClone(docs.get(layer)),
    save: async (layer, doc) => {
      saves.push(layer);
      docs.set(layer, structuredClone(doc));
    },
  };
  return { store, docs, saves };
}

export type MemorySecrets = SecretStore & { readonly map: Map<string, string> };

/** Хранилище секретов в памяти; `available: false` изображает систему без хранилища (ядро отвечает `Unavailable`). */
export function memorySecrets(available = true): MemorySecrets {
  const map = new Map<string, string>();
  return { map, available: () => available, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k) };
}
