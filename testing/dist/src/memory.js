/** Слои `config` и `state` в памяти. Документы копируются при чтении и записи, как при записи в файл: мутация снаружи слой не меняет. */
export function memoryStore(initial = {}) {
    const docs = new Map(Object.entries(structuredClone(initial)));
    const saves = [];
    const store = {
        load: async (layer) => structuredClone(docs.get(layer)),
        save: async (layer, doc) => {
            saves.push(layer);
            docs.set(layer, structuredClone(doc));
        },
    };
    return { store, docs, saves };
}
/** Хранилище секретов в памяти; `available: false` изображает систему без хранилища (ядро отвечает `Unavailable`). */
export function memorySecrets(available = true) {
    const map = new Map();
    const deletePrefix = async (prefix) => {
        const keys = [...map.keys()].filter((k) => k.startsWith(prefix));
        for (const k of keys)
            map.delete(k);
        return keys.length;
    };
    return { map, available: () => available, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k), deletePrefix };
}
