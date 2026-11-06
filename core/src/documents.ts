// Открытые документы окна (SAD §3.8, «Вкладки после перезапуска»): порядок и данные держит ядро, поднимает документ его владелец.

import { randomUUID } from 'node:crypto';
import type { DocumentChange, DocumentInfo } from '@cyborg-harness/contracts';
import { CoreError } from './errors.ts';

export interface StoredDocument extends DocumentInfo {
  readonly pluginId: string;
}

/** Строка для окна: данных в ней нет, они - дело владельца. */
export interface DocumentRow {
  readonly id: string;
  readonly pluginId: string;
  readonly type: string;
  readonly title: string;
  /** Владелец активен и поднимет документ; иначе окно показывает вкладку недоступной, а не теряет её. */
  readonly available: boolean;
}

export interface DocumentPersistence {
  read(): unknown;
  write(list: readonly StoredDocument[]): Promise<void>;
}

/** `true`/`false` - тип объявлен с `restorable` и без; null - владелец есть, типа у него нет; undefined - владельца нет среди манифестов. */
export type TypeLookup = (pluginId: string, type: string) => boolean | null | undefined;

// Без владельца строка остаётся: вкладка недоступна, но не пропадает; владелец её вернёт, когда появится.
const kept = (restorable: boolean | null | undefined): boolean => restorable === true || restorable === undefined;

export const DOCUMENT_LIMITS = { title: 200, data: 64 * 1024, perPlugin: 200 } as const;

export class DocumentTable {
  readonly #persistence: DocumentPersistence | undefined;
  readonly #restorable: TypeLookup;
  readonly #changed: () => void;
  #docs: StoredDocument[];
  #writes: Promise<unknown> = Promise.resolve();

  constructor(persistence: DocumentPersistence | undefined, restorable: TypeLookup, changed: () => void = () => undefined) {
    this.#persistence = persistence;
    this.#restorable = restorable;
    this.#changed = changed;
    // Тип, у которого обновлённый владелец снял restorable или который убрал, поднимать некому.
    this.#docs = parseStored(persistence?.read()).filter((d) => kept(this.#restorable(d.pluginId, d.type)));
  }

  list(pluginId: string): DocumentInfo[] {
    return this.#docs.filter((d) => d.pluginId === pluginId).map((d) => structuredClone({ id: d.id, type: d.type, title: d.title, ...(d.data !== undefined && { data: d.data }) }));
  }

  rows(available: (pluginId: string) => boolean): DocumentRow[] {
    return this.#docs.map((d) => ({ id: d.id, pluginId: d.pluginId, type: d.type, title: d.title, available: available(d.pluginId) }));
  }

  async open(pluginId: string, type: unknown, init: unknown): Promise<string> {
    if (typeof type !== 'string' || typeof this.#restorable(pluginId, type) !== 'boolean') throw new CoreError('NotDeclared', `${pluginId}: тип документа ${JSON.stringify(type)} не объявлен в manifest.documents`);
    if (this.#docs.filter((d) => d.pluginId === pluginId).length >= DOCUMENT_LIMITS.perPlugin) throw new CoreError('Invalid', `${pluginId}: открыто ${String(DOCUMENT_LIMITS.perPlugin)} документов`);
    const fields = readChange(pluginId, init);
    if (fields.title === undefined) throw new CoreError('Invalid', `${pluginId}: у документа нет title`);
    const doc: StoredDocument = { id: randomUUID(), pluginId, type, title: fields.title, ...('data' in fields && { data: fields.data }) };
    this.#docs.push(doc);
    await this.#commit();
    return doc.id;
  }

  async save(pluginId: string, id: unknown, change: unknown): Promise<void> {
    const [at, prev] = this.#own(pluginId, id);
    const fields = readChange(pluginId, change);
    const data = 'data' in fields ? fields.data : prev.data;
    this.#docs[at] = { id: prev.id, pluginId, type: prev.type, title: fields.title ?? prev.title, ...(data !== undefined && { data }) };
    await this.#commit();
  }

  async close(pluginId: string, id: unknown): Promise<void> {
    this.#docs.splice(this.#own(pluginId, id)[0], 1);
    await this.#commit();
  }

  /** Закрытие человеком из окна: владелец, если он активен, узнаёт об этом от приложения. */
  async closeAny(id: string): Promise<StoredDocument> {
    const at = this.#docs.findIndex((d) => d.id === id);
    const doc = this.#docs[at];
    if (doc === undefined) throw new CoreError('NotFound', `документа ${id} нет`);
    this.#docs.splice(at, 1);
    await this.#commit();
    return doc;
  }

  /** Чужой документ для плагина не существует. */
  #own(pluginId: string, id: unknown): [number, StoredDocument] {
    const at = this.#docs.findIndex((d) => d.id === id && d.pluginId === pluginId);
    const doc = this.#docs[at];
    if (doc === undefined) throw new CoreError('NotFound', `${pluginId}: документа ${String(id)} нет`);
    return [at, doc];
  }

  #commit(): Promise<void> {
    this.#changed();
    const persistence = this.#persistence;
    if (!persistence) return Promise.resolve();
    // Снимок берётся в момент записи, а записи идут по очереди: поздняя не обгонит раннюю.
    const write = this.#writes.then(() => persistence.write(this.#docs.filter((d) => kept(this.#restorable(d.pluginId, d.type)))));
    this.#writes = write.catch(() => undefined);
    return write;
  }
}

function readChange(pluginId: string, raw: unknown): DocumentChange {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CoreError('Invalid', `${pluginId}: ожидается { title?, data? }`);
  const { title, data, ...extra } = raw as Record<string, unknown>;
  const unknownKey = Object.keys(extra)[0];
  if (unknownKey !== undefined) throw new CoreError('Invalid', `${pluginId}: у документа нет поля ${unknownKey}`);
  if (title !== undefined && (typeof title !== 'string' || title.trim() === '' || title.length > DOCUMENT_LIMITS.title)) {
    throw new CoreError('Invalid', `${pluginId}: title - непустая строка до ${String(DOCUMENT_LIMITS.title)} символов`);
  }
  if (!('data' in raw)) return title === undefined ? {} : { title };
  const text = JSON.stringify(data) as string | undefined;
  if (text !== undefined && Buffer.byteLength(text) > DOCUMENT_LIMITS.data) throw new CoreError('Invalid', `${pluginId}: данные документа больше ${String(DOCUMENT_LIMITS.data)} байт`);
  // Через JSON: в state воркспейса уходит то же, что вернёт list() после перезапуска.
  return { ...(title !== undefined && { title }), data: text === undefined ? undefined : (JSON.parse(text) as unknown) };
}

function parseStored(raw: unknown): StoredDocument[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: StoredDocument[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { id, pluginId, type, title, data } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof pluginId !== 'string' || typeof type !== 'string' || typeof title !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, pluginId, type, title, ...(data !== undefined && { data }) });
  }
  return out;
}
