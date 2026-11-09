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
export declare function memoryStore(initial?: LayerDocuments): MemoryStore;
export type MemorySecrets = SecretStore & {
    readonly map: Map<string, string>;
};
/** Хранилище секретов в памяти; `available: false` изображает систему без хранилища (ядро отвечает `Unavailable`). */
export declare function memorySecrets(available?: boolean): MemorySecrets;
