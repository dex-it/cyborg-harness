import fs from 'node:fs/promises';
import path from 'node:path';
import { checkPublicKey, keyIdOf, publicKeyOf, signBytes, verifyBytes } from './integrity.ts';
import { compareVersions, parseVersion } from './semver.ts';

// TR-11 (ADR-CH-0017): хранилище доверия `<userData>/trust.json` - слой пользователя, не воркспейса (ADR-CH-0015, п. 6): файл воркспейса приходит из репозитория команды.
// В нём ключи сторонних издателей, наибольшая виденная версия каждого плагина (защита от отката) и отозванные ключи и хеши. Ключ издателя поставки сюда не пишется:
// он зашит в приложение и приходит параметром (`releaseKeys`).

export const TRUST_FILE = 'trust.json';
export const TRUST_FORMAT = 1;

export interface Publisher {
  readonly publicKey: string;
  readonly name?: string | undefined;
  /** Подпись этого ключа принимается под списком отозванных (`applyRevocations`). Ключи поставки такое право имеют всегда. */
  readonly canRevoke?: boolean | undefined;
  readonly addedAt: string;
}

export interface Revoked {
  readonly keys: Readonly<Record<string, string>>;
  readonly hashes: Readonly<Record<string, string>>;
}

/** Какой подписанный список отзыва применён последним: по нему видно, не устарел ли он, и не принять ли старый. */
export interface RevocationState {
  readonly serial: number;
  readonly notAfter: string;
  readonly keyId: string;
}

interface Data {
  publishers: Record<string, Publisher>;
  versions: Record<string, string>;
  revoked: { keys: Record<string, string>; hashes: Record<string, string> };
  revocations?: RevocationState;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const empty = (): Data => ({ publishers: {}, versions: {}, revoked: { keys: {}, hashes: {} } });
const HASH = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{32}$/;

/** Содержимое `trust.json`: текст ошибки или данные. Строго к известным полям, чужое поле в известном месте - ошибка: файл с мусором не должен молча терять записи. */
function parse(text: string): Data | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `${TRUST_FILE} не разобран: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(raw)) return `${TRUST_FILE}: ожидался объект`;
  if (raw.format !== TRUST_FORMAT) return `${TRUST_FILE}: формат ${JSON.stringify(raw.format)} не поддерживается (ожидался ${String(TRUST_FORMAT)})`;
  const data = empty();
  const section = (name: string): Record<string, unknown> | string => {
    const value = raw[name] ?? {};
    return isRecord(value) ? value : `${TRUST_FILE}: ${name} - ожидался объект`;
  };
  const publishers = section('publishers');
  if (typeof publishers === 'string') return publishers;
  for (const [keyId, entry] of Object.entries(publishers)) {
    if (!isRecord(entry) || typeof entry.publicKey !== 'string') return `${TRUST_FILE}: publishers.${keyId}: нет publicKey`;
    const why = checkPublicKey(entry.publicKey);
    if (why !== undefined) return `${TRUST_FILE}: publishers.${keyId}: ${why}`;
    if (keyIdOf(entry.publicKey) !== keyId) return `${TRUST_FILE}: publishers.${keyId}: ключ не соответствует идентификатору`;
    data.publishers[keyId] = {
      publicKey: entry.publicKey,
      ...(typeof entry.name === 'string' && { name: entry.name }),
      ...(entry.canRevoke === true && { canRevoke: true }),
      addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
    };
  }
  const versions = section('versions');
  if (typeof versions === 'string') return versions;
  for (const [id, version] of Object.entries(versions)) {
    if (typeof version !== 'string' || parseVersion(version) === null) return `${TRUST_FILE}: versions.${id}: ожидается x.y.z`;
    data.versions[id] = version;
  }
  const revoked = section('revoked');
  if (typeof revoked === 'string') return revoked;
  for (const [kind, pattern] of [['keys', KEY_ID], ['hashes', HASH]] as const) {
    const list = revoked[kind] ?? {};
    if (!isRecord(list)) return `${TRUST_FILE}: revoked.${kind} - ожидался объект`;
    for (const [id, reason] of Object.entries(list)) {
      if (!pattern.test(id)) return `${TRUST_FILE}: revoked.${kind}.${id}: недопустимый идентификатор`;
      data.revoked[kind][id] = typeof reason === 'string' ? reason : '';
    }
  }
  const state = raw.revocations;
  if (state !== undefined) {
    if (!isRecord(state) || typeof state.serial !== 'number' || typeof state.notAfter !== 'string' || typeof state.keyId !== 'string') return `${TRUST_FILE}: revocations - ожидались serial, notAfter, keyId`;
    data.revocations = { serial: state.serial, notAfter: state.notAfter, keyId: state.keyId };
  }
  return data;
}

const codeOf = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

export class TrustStore {
  readonly file: string;
  #data: Data = empty();
  #error: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(file: string) {
    this.file = file;
  }

  /**
   * Открывает хранилище. Нет файла - пустое. Файл не читается или не разобран - хранилище закрыто на запись, `error` называет причину, а проверки пакетов
   * отказывают с ней: молча начать с пустого значило бы стереть откат и отзыв при первой записи.
   */
  static async open(file: string): Promise<TrustStore> {
    const store = new TrustStore(file);
    await store.#reload();
    return store;
  }

  async #reload(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (codeOf(error) === 'ENOENT') {
        this.#data = empty();
        this.#error = undefined;
      } else {
        this.#error = `${TRUST_FILE} не прочитан: ${error instanceof Error ? error.message : String(error)}`;
      }
      return;
    }
    const parsed = parse(text);
    if (typeof parsed === 'string') {
      this.#error = parsed;
      return;
    }
    this.#data = parsed;
    this.#error = undefined;
  }

  /** Причина, по которой хранилищу верить нельзя; `undefined` - всё прочитано. */
  get error(): string | undefined {
    return this.#error;
  }

  publishers(): ReadonlyMap<string, Publisher> {
    return new Map(Object.entries(this.#data.publishers));
  }

  /** Доверенные ключи издателей: идентификатор -> открытый ключ. */
  publisherKeys(): Map<string, string> {
    return new Map(Object.entries(this.#data.publishers).map(([keyId, p]) => [keyId, p.publicKey]));
  }

  highestSeen(pluginId: string): string | undefined {
    return Object.hasOwn(this.#data.versions, pluginId) ? this.#data.versions[pluginId] : undefined;
  }

  revoked(): Revoked {
    return { keys: { ...this.#data.revoked.keys }, hashes: { ...this.#data.revoked.hashes } };
  }

  revokedKeys(): Set<string> {
    return new Set(Object.keys(this.#data.revoked.keys));
  }

  revokedHashes(): Set<string> {
    return new Set(Object.keys(this.#data.revoked.hashes));
  }

  revocationState(): RevocationState | undefined {
    return this.#data.revocations;
  }

  /** Применённый список отзыва старше своего срока: отзыв продолжает действовать, но свежим список не считается и новый пора получить. */
  revocationsStale(now: number): boolean {
    const state = this.#data.revocations;
    return state !== undefined && Date.parse(state.notAfter) < now;
  }

  /** Читает файл заново, применяет правку и пишет атомарно (временный файл рядом, права 0600, каталог 0700): два окна одного `userData` не затирают правки друг друга целиком. */
  #mutate(change: (data: Data) => void): Promise<void> {
    const run = this.#chain.then(async () => {
      await this.#reload();
      if (this.#error !== undefined) throw new Error(this.#error);
      const next: Data = structuredClone(this.#data);
      change(next);
      const body = { format: TRUST_FORMAT, publishers: next.publishers, versions: sortKeys(next.versions), revoked: next.revoked, ...(next.revocations !== undefined && { revocations: next.revocations }) };
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
      try {
        await fs.writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp, { force: true });
      }
      this.#data = next;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Добавляет ключ издателя; возвращает его идентификатор. Повтор того же ключа обновляет имя и право отзыва. */
  async addPublisher(publicKey: string, options: { name?: string; canRevoke?: boolean; now?: number } = {}): Promise<string> {
    const why = checkPublicKey(publicKey);
    if (why !== undefined) throw new Error(why);
    const keyId = keyIdOf(publicKey);
    await this.#mutate((data) => {
      data.publishers[keyId] = {
        publicKey,
        ...(options.name !== undefined && { name: options.name }),
        ...(options.canRevoke === true && { canRevoke: true }),
        addedAt: data.publishers[keyId]?.addedAt ?? new Date(options.now ?? Date.now()).toISOString(),
      };
    });
    return keyId;
  }

  async removePublisher(keyId: string): Promise<boolean> {
    let had = false;
    await this.#mutate((data) => {
      had = Object.hasOwn(data.publishers, keyId);
      data.publishers = without(data.publishers, keyId);
    });
    return had;
  }

  /** Запоминает версию, если она выше виденной: версия только растёт. Ниже - ничего не пишет. */
  async recordVersion(pluginId: string, version: string): Promise<void> {
    const have = parseVersion(version);
    if (have === null) throw new Error(`версия ${version}: ожидается x.y.z`);
    const seen = this.highestSeen(pluginId);
    const known = seen === undefined ? null : parseVersion(seen);
    if (known !== null && compareVersions(have, known) <= 0) return;
    await this.#mutate((data) => {
      const current = Object.hasOwn(data.versions, pluginId) ? parseVersion(data.versions[pluginId] ?? '') : null;
      if (current === null || compareVersions(have, current) > 0) data.versions[pluginId] = version;
    });
  }

  /** Решение человека: забыть виденную версию, чтобы принять более старую (откат намеренный). */
  async forgetVersion(pluginId: string): Promise<boolean> {
    let had = false;
    await this.#mutate((data) => {
      had = Object.hasOwn(data.versions, pluginId);
      data.versions = without(data.versions, pluginId);
    });
    return had;
  }

  /** Решение человека: отозвать ключ. Отзыв необратим через этот класс - снять его можно только правкой файла. */
  async revokeKey(keyId: string, reason = ''): Promise<void> {
    if (!KEY_ID.test(keyId)) throw new Error('идентификатор ключа: ожидается 32 символа hex');
    await this.#mutate((data) => void (data.revoked.keys[keyId] = reason));
  }

  async revokeHash(sha256: string, reason = ''): Promise<void> {
    if (!HASH.test(sha256)) throw new Error('хеш: ожидается sha256 в hex');
    await this.#mutate((data) => void (data.revoked.hashes[sha256] = reason));
  }

  /**
   * Применяет подписанный список отзыва (`signRevocations`). Подпись должна принадлежать ключу поставки (`releaseKeys`) или издателю с правом `canRevoke`;
   * срок списка не вышел; `serial` выше применённого (старый список не вернёт то, что новый снял, хотя сам список только дополняет). Записи добавляются, не заменяются.
   */
  async applyRevocations(text: string, releaseKeys: readonly string[], now: number): Promise<{ ok: true; added: number; serial: number } | { ok: false; reason: string }> {
    const signers = new Map<string, string>(releaseKeys.map((key) => [keyIdOf(key), key]));
    for (const [keyId, p] of Object.entries(this.#data.publishers)) if (p.canRevoke === true) signers.set(keyId, p.publicKey);
    const list = verifyRevocations(text, signers, now);
    if (typeof list === 'string') return { ok: false, reason: list };
    const state = this.#data.revocations;
    if (state !== undefined && list.serial <= state.serial) return { ok: false, reason: `список отзыва №${String(list.serial)} не новее применённого №${String(state.serial)}` };
    let added = 0;
    await this.#mutate((data) => {
      for (const [keyId, reason] of Object.entries(list.keys)) {
        if (Object.hasOwn(data.revoked.keys, keyId)) continue;
        data.revoked.keys[keyId] = reason;
        added++;
      }
      for (const [hash, reason] of Object.entries(list.hashes)) {
        if (Object.hasOwn(data.revoked.hashes, hash)) continue;
        data.revoked.hashes[hash] = reason;
        added++;
      }
      data.revocations = { serial: list.serial, notAfter: list.notAfter, keyId: list.keyId };
    });
    return { ok: true, added, serial: list.serial };
  }
}

const without = <T>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const sortKeys = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// ---------- подписанный список отзыва ----------

const REVOCATIONS_DOMAIN = 'cyborg-revocations/v1\n';

export interface RevocationList {
  readonly format: 1;
  /** Растёт с каждым выпуском списка. */
  readonly serial: number;
  readonly issuedAt: string;
  /** До какого срока список считается свежим: позже него он не принимается, и выпускающий обязан выпустить новый. */
  readonly notAfter: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly hashes: Readonly<Record<string, string>>;
  readonly keyId: string;
  readonly signature: string;
}

function revocationBytes(list: Omit<RevocationList, 'signature'>): Buffer {
  return Buffer.from(`${REVOCATIONS_DOMAIN}${JSON.stringify({ format: list.format, serial: list.serial, issuedAt: list.issuedAt, notAfter: list.notAfter, keys: sortKeys({ ...list.keys }), hashes: sortKeys({ ...list.hashes }), keyId: list.keyId })}`, 'utf8');
}

export interface RevocationInput {
  readonly serial: number;
  readonly keys?: Readonly<Record<string, string>>;
  readonly hashes?: Readonly<Record<string, string>>;
  readonly issuedAt: Date;
  readonly notAfter: Date;
}

/** Подписанный список отозванных ключей и хешей (вид TUF: подписанные метаданные со сроком годности). Text для файла. */
export function signRevocations(input: RevocationInput, secretKey: string): string {
  if (!Number.isInteger(input.serial) || input.serial < 1) throw new Error('serial: ожидается целое >= 1');
  const body = { format: 1, serial: input.serial, issuedAt: input.issuedAt.toISOString(), notAfter: input.notAfter.toISOString(), keys: input.keys ?? {}, hashes: input.hashes ?? {}, keyId: keyIdOf(publicKeyOf(secretKey)) } as const;
  for (const id of Object.keys(body.keys)) if (!KEY_ID.test(id)) throw new Error(`keys.${id}: ожидается 32 символа hex`);
  for (const id of Object.keys(body.hashes)) if (!HASH.test(id)) throw new Error(`hashes.${id}: ожидается sha256 в hex`);
  const signature = signBytes(secretKey, revocationBytes(body));
  return `${JSON.stringify({ ...body, signature }, null, 2)}\n`;
}

/** Проверка подписанного списка ключами `signers` (идентификатор -> открытый ключ): список или причина словами. */
export function verifyRevocations(text: string, signers: ReadonlyMap<string, string>, now: number): RevocationList | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `список отзыва не разобран: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(raw) || raw.format !== 1) return 'список отзыва: ожидался объект формата 1';
  const { serial, issuedAt, notAfter, keys, hashes, keyId, signature } = raw;
  if (typeof serial !== 'number' || !Number.isInteger(serial) || serial < 1) return 'список отзыва: serial - ожидается целое >= 1';
  if (typeof issuedAt !== 'string' || typeof notAfter !== 'string' || Number.isNaN(Date.parse(issuedAt)) || Number.isNaN(Date.parse(notAfter))) return 'список отзыва: даты не разобраны';
  if (typeof keyId !== 'string' || typeof signature !== 'string' || !isRecord(keys) || !isRecord(hashes)) return 'список отзыва: нет keyId, подписи или списков';
  const strings = (record: Record<string, unknown>, pattern: RegExp, what: string): Record<string, string> | string => {
    const out: Record<string, string> = {};
    for (const [id, reason] of Object.entries(record)) {
      if (!pattern.test(id) || typeof reason !== 'string') return `список отзыва: ${what}.${id}: недопустимая запись`;
      out[id] = reason;
    }
    return out;
  };
  const keyList = strings(keys, KEY_ID, 'keys');
  if (typeof keyList === 'string') return keyList;
  const hashList = strings(hashes, HASH, 'hashes');
  if (typeof hashList === 'string') return hashList;
  const publicKey = signers.get(keyId);
  if (publicKey === undefined) return `список отзыва подписан ключом ${keyId}, которому такое право не дано`;
  const list: RevocationList = { format: 1, serial, issuedAt, notAfter, keys: keyList, hashes: hashList, keyId, signature };
  const valid = checkPublicKey(publicKey) === undefined && keyIdOf(publicKey) === keyId && verifyBytes(publicKey, revocationBytes(list), signature);
  if (!valid) return 'список отзыва: подпись не сходится';
  if (Date.parse(notAfter) < now) return `список отзыва устарел: срок вышел ${notAfter}`;
  return list;
}
