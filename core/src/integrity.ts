import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compareVersions, parseVersion } from './semver.ts';

// TR-10 (ADR-CH-0017): подписанный пакет плагина. `integrity.json` лежит в корне пакета рядом с файлами: id, версия, sha256 каждого файла, срок и
// идентификатор ключа, подпись Ed25519 над канонической записью. Формат свой, по образцу minisign; только `node:crypto`, без зависимостей.
// Доверие к ключу берётся не отсюда и не из `manifest.json` плагина (автор пишет там что угодно), а из списка ключей, который передаёт вызывающий (TR-11).
// Проверка работает над байтами, которые вызывающий уже прочитал (`PackageBytes`), и ничего не открывает по второму разу: то, что проверено, то и исполняется.

/** Имя файла подписанной записи в корне пакета. Сам он в список файлов не входит. */
export const INTEGRITY_FILE = 'integrity.json';

/** Версия формата `integrity.json`. */
export const INTEGRITY_FORMAT = 1;

/** Метка области подписи: подпись пакета не сойдётся с подписью поставки или чего-то ещё, подписанного тем же ключом. */
const DOMAIN = 'cyborg-plugin-integrity/v1\n';

const PUBLIC_PREFIX = 'ed25519:';
const SECRET_PREFIX = 'ed25519-secret:';
// DER-обёртки Ed25519 (RFC 8410): к 32 байтам ключа остаётся дописать их.
const SPKI_HEAD = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
const PKCS8_HEAD = Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const KEY_BYTES = 32;
const KEY_ID_CHARS = 32;
const SHA256 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{32}$/;
/** Пределы чтения пакета с диска: больше - не плагин, а помеха; отказ с причиной, а не нехватка памяти. */
const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;

/** Подписанная запись пакета. */
export interface IntegrityManifest {
  readonly format: typeof INTEGRITY_FORMAT;
  /** id плагина: совпадает с `manifest.json` пакета. */
  readonly id: string;
  /** Версия плагина: совпадает с `manifest.json` пакета. */
  readonly version: string;
  /** Идентификатор ключа подписи (`keyIdOf`). */
  readonly keyId: string;
  /** Срок действия подписи, UTC, ISO 8601 с миллисекундами (`Date.toISOString`); позже него пакет не принимается. */
  readonly notAfter: string;
  /** Путь от корня пакета через `/` -> sha256 в hex. Без `integrity.json`. */
  readonly files: Readonly<Record<string, string>>;
  /** Подпись Ed25519 в base64 над канонической записью без этого поля. */
  readonly signature: string;
}

/** Почему пакет не принят: код для машины, слова для человека (поле `reason` записи журнала `integrity-failed`). */
export type IntegrityCode =
  | 'no-integrity'
  | 'malformed'
  | 'unknown-key'
  | 'revoked-key'
  | 'bad-signature'
  | 'expired'
  | 'mismatch'
  | 'modified'
  | 'missing'
  | 'extra'
  | 'symlink'
  | 'rollback'
  | 'revoked-hash'
  | 'unavailable';

export type IntegrityVerdict =
  | { readonly ok: true; readonly manifest: IntegrityManifest; /** sha256 канонической записи: по нему пакет отзывается целиком. */ readonly digest: string }
  | { readonly ok: false; readonly code: IntegrityCode; readonly reason: string; readonly keyId?: string };

/** Байты пакета, как их прочитал вызывающий. */
export interface PackageBytes {
  /** Путь от корня через `/` -> содержимое; без `integrity.json`. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Символические ссылки: путь -> цель. В подписанный пакет они не входят. */
  readonly links?: ReadonlyMap<string, string>;
  /** Содержимое `integrity.json`; нет - пакет не подписан. */
  readonly integrity?: Uint8Array | string | undefined;
}

export interface VerifyPolicy {
  /** Доверенные ключи: идентификатор -> открытый ключ (`ed25519:<base64>`). Идентификатор проверяется: ключ под чужим именем не принимается. */
  readonly keys: ReadonlyMap<string, string>;
  readonly revokedKeys?: ReadonlySet<string> | undefined;
  /** sha256 отозванных файлов и записей пакета (`digest`): совпадение любого с файлом или записью - отказ. */
  readonly revokedHashes?: ReadonlySet<string> | undefined;
  /** Момент проверки, мс с эпохи. */
  readonly now: number;
  /** Что ждёт вызывающий: id и версия из `manifest.json` пакета. */
  readonly expect?: { readonly id?: string | undefined; readonly version?: string | undefined } | undefined;
  /** Наибольшая версия этого плагина, которую ядро уже принимало; ниже неё - откат. */
  readonly highestSeen?: string | undefined;
}

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------- ключи ----------

export interface SigningKey {
  /** `ed25519:<base64>` открытого ключа (32 байта). */
  readonly publicKey: string;
  /** `ed25519-secret:<base64>` зерна закрытого ключа (32 байта). Хранить как секрет: в репозиторий не класть. */
  readonly secretKey: string;
  readonly keyId: string;
}

function rawKey(text: string, prefix: string, what: string): Buffer {
  if (!text.startsWith(prefix)) throw new Error(`${what}: ожидалась запись вида ${prefix}<base64>`);
  const raw = Buffer.from(text.slice(prefix.length), 'base64');
  if (raw.length !== KEY_BYTES || raw.toString('base64') !== text.slice(prefix.length)) throw new Error(`${what}: ожидалось ${String(KEY_BYTES)} байт в base64`);
  return raw;
}

/** Идентификатор ключа: первые 128 бит sha256 от 32 байт открытого ключа, в hex. */
export function keyIdOf(publicKey: string): string {
  return sha256Hex(rawKey(publicKey, PUBLIC_PREFIX, 'открытый ключ')).slice(0, KEY_ID_CHARS);
}

const publicObject = (publicKey: string): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_HEAD, rawKey(publicKey, PUBLIC_PREFIX, 'открытый ключ')]), format: 'der', type: 'spki' });
const secretObject = (secretKey: string): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8_HEAD, rawKey(secretKey, SECRET_PREFIX, 'закрытый ключ')]), format: 'der', type: 'pkcs8' });

/** Новая пара ключей Ed25519. */
export function generateSigningKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_HEAD.length);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_HEAD.length);
  const pub = `${PUBLIC_PREFIX}${raw.toString('base64')}`;
  return { publicKey: pub, secretKey: `${SECRET_PREFIX}${seed.toString('base64')}`, keyId: keyIdOf(pub) };
}

/** Открытый ключ по закрытому: подписывающему не нужно хранить оба. */
export function publicKeyOf(secretKey: string): string {
  const raw = createPublicKey(secretObject(secretKey)).export({ format: 'der', type: 'spki' }).subarray(SPKI_HEAD.length);
  return `${PUBLIC_PREFIX}${raw.toString('base64')}`;
}

/** Запись открытого ключа корректна (форма и длина), иначе причина словами. */
export function checkPublicKey(publicKey: string): string | undefined {
  try {
    rawKey(publicKey, PUBLIC_PREFIX, 'открытый ключ');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------- каноническая запись ----------

const sortedFiles = (files: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Байты, над которыми стоит подпись: метка области и JSON с полями в фиксированном порядке и файлами по алфавиту, без пробелов. */
export function canonicalBytes(m: Omit<IntegrityManifest, 'signature'>): Buffer {
  return Buffer.from(`${DOMAIN}${JSON.stringify({ format: m.format, id: m.id, version: m.version, keyId: m.keyId, notAfter: m.notAfter, files: sortedFiles(m.files) })}`, 'utf8');
}

export interface SignInput {
  readonly id: string;
  readonly version: string;
  /** Путь -> sha256 в hex. */
  readonly files: Readonly<Record<string, string>>;
  readonly notAfter: Date;
}

/** Подписывает запись пакета закрытым ключом. */
export function signIntegrity(input: SignInput, secretKey: string): IntegrityManifest {
  if (Number.isNaN(input.notAfter.getTime())) throw new Error('срок подписи: ожидалась дата');
  for (const [file, hash] of Object.entries(input.files)) {
    const bad = badPath(file);
    if (bad !== undefined) throw new Error(`${file}: ${bad}`);
    if (!SHA256.test(hash)) throw new Error(`${file}: ожидался sha256 в hex`);
  }
  const body = { format: INTEGRITY_FORMAT, id: input.id, version: input.version, keyId: keyIdOf(publicKeyOf(secretKey)), notAfter: input.notAfter.toISOString(), files: sortedFiles(input.files) } as const;
  return { ...body, signature: sign(null, canonicalBytes(body), secretObject(secretKey)).toString('base64') };
}

/** Хеши файлов пакета по их байтам. */
export function hashFiles(files: ReadonlyMap<string, Uint8Array>): Record<string, string> {
  return sortedFiles(Object.fromEntries([...files].map(([file, data]) => [file, sha256Hex(data)])));
}

/** Текст `integrity.json`, как его пишет `sign`: читается человеком, порядок полей тот же, что в подписи. */
export function renderIntegrity(m: IntegrityManifest): string {
  return `${JSON.stringify({ format: m.format, id: m.id, version: m.version, keyId: m.keyId, notAfter: m.notAfter, files: sortedFiles(m.files), signature: m.signature }, null, 2)}\n`;
}

/** Путь файла пакета: от корня, через `/`, без `.`, `..`, пустых частей и обратной косой; иначе причина. */
function badPath(file: string): string | undefined {
  if (file === '' || file.startsWith('/') || file.includes('\\') || file.includes('\0')) return 'недопустимый путь';
  if (file.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'недопустимый путь';
  if (file === INTEGRITY_FILE) return `${INTEGRITY_FILE} в список файлов не входит`;
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const FIELDS = ['format', 'id', 'version', 'keyId', 'notAfter', 'files', 'signature'];

/** Разбор `integrity.json`: строгий, лишнее поле - ошибка, потому что подпись покрывает только известные. Текст ошибки или запись. */
export function parseIntegrity(text: string): IntegrityManifest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return `${INTEGRITY_FILE} не разобран: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(raw)) return `${INTEGRITY_FILE}: ожидался объект`;
  const extra = Object.keys(raw).filter((key) => !FIELDS.includes(key));
  if (extra.length > 0) return `${INTEGRITY_FILE}: лишние поля ${extra.join(', ')}`;
  if (raw.format !== INTEGRITY_FORMAT) return `${INTEGRITY_FILE}: формат ${JSON.stringify(raw.format)} не поддерживается (ожидался ${String(INTEGRITY_FORMAT)})`;
  const { id, version, keyId, notAfter, files, signature } = raw;
  if (typeof id !== 'string' || id === '') return `${INTEGRITY_FILE}: нет id`;
  if (typeof version !== 'string' || parseVersion(version) === null) return `${INTEGRITY_FILE}: version - ожидается x.y.z`;
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) return `${INTEGRITY_FILE}: keyId - ожидается ${String(KEY_ID_CHARS)} символов hex`;
  if (typeof notAfter !== 'string' || Number.isNaN(Date.parse(notAfter)) || new Date(notAfter).toISOString() !== notAfter) return `${INTEGRITY_FILE}: notAfter - ожидается дата в виде Date.toISOString()`;
  if (typeof signature !== 'string' || signature === '') return `${INTEGRITY_FILE}: нет подписи`;
  if (!isRecord(files)) return `${INTEGRITY_FILE}: нет объекта files`;
  const hashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(files)) {
    const bad = badPath(file);
    if (bad !== undefined) return `${INTEGRITY_FILE}: ${file}: ${bad}`;
    if (typeof hash !== 'string' || !SHA256.test(hash)) return `${INTEGRITY_FILE}: ${file}: ожидался sha256 в hex`;
    hashes[file] = hash;
  }
  return { format: INTEGRITY_FORMAT, id, version, keyId, notAfter, files: hashes, signature };
}

const fail = (code: IntegrityCode, reason: string, keyId?: string): IntegrityVerdict => ({ ok: false, code, reason, ...(keyId !== undefined && { keyId }) });

const some = (names: readonly string[]): string => {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} и ещё ${String(names.length - 5)}` : shown;
};

/**
 * Проверка пакета над прочитанными байтами. Порядок: разбор записи, ключ (известен ли, не отозван ли), подпись, срок, совпадение с `manifest.json`, версия не ниже виденной,
 * затем файлы (ссылки, изменённые, пропавшие, лишние) и отозванные хеши. Первый отказ возвращается со словами для человека.
 */
export function verifyIntegrity(bytes: PackageBytes, policy: VerifyPolicy): IntegrityVerdict {
  if (bytes.integrity === undefined) return fail('no-integrity', `в пакете нет ${INTEGRITY_FILE}: он не подписан`);
  const parsed = parseIntegrity(typeof bytes.integrity === 'string' ? bytes.integrity : Buffer.from(bytes.integrity).toString('utf8'));
  if (typeof parsed === 'string') return fail('malformed', parsed);
  const m = parsed;
  if (policy.revokedKeys?.has(m.keyId) === true) return fail('revoked-key', `ключ издателя ${m.keyId} отозван`, m.keyId);
  const publicKey = policy.keys.get(m.keyId);
  if (publicKey === undefined) return fail('unknown-key', `ключ издателя ${m.keyId} не в списке доверенных`, m.keyId);
  let valid: boolean;
  try {
    if (keyIdOf(publicKey) !== m.keyId) return fail('unknown-key', `ключ ${m.keyId} в списке доверенных не совпадает со своим идентификатором`, m.keyId);
    valid = verify(null, canonicalBytes(m), publicObject(publicKey), Buffer.from(m.signature, 'base64'));
  } catch (error) {
    return fail('bad-signature', `подпись не проверена: ${error instanceof Error ? error.message : String(error)}`, m.keyId);
  }
  if (!valid) return fail('bad-signature', 'подпись не сходится: запись правили или подписал другой ключ', m.keyId);
  if (Date.parse(m.notAfter) < policy.now) return fail('expired', `срок подписи истёк ${m.notAfter}`, m.keyId);
  if (policy.expect?.id !== undefined && policy.expect.id !== m.id) return fail('mismatch', `подписан плагин ${m.id}, а в manifest.json - ${policy.expect.id}`, m.keyId);
  if (policy.expect?.version !== undefined && policy.expect.version !== m.version) return fail('mismatch', `подписана версия ${m.version}, а в manifest.json - ${policy.expect.version}`, m.keyId);
  if (policy.highestSeen !== undefined) {
    const have = parseVersion(m.version);
    const seen = parseVersion(policy.highestSeen);
    if (have !== null && seen !== null && compareVersions(have, seen) < 0) return fail('rollback', `версия ${m.version} ниже уже принимавшейся ${policy.highestSeen}: откат отвергнут`, m.keyId);
  }
  const links = [...(bytes.links?.keys() ?? [])];
  if (links.length > 0) return fail('symlink', `символические ссылки в пакете: ${some(links)}`, m.keyId);
  const modified: string[] = [];
  const missing: string[] = [];
  for (const [file, hash] of Object.entries(m.files)) {
    const data = bytes.files.get(file);
    if (data === undefined) missing.push(file);
    else if (!sameHex(sha256Hex(data), hash)) modified.push(file);
  }
  if (modified.length > 0) return fail('modified', `файл изменён после подписи: ${some(modified)}`, m.keyId);
  if (missing.length > 0) return fail('missing', `файла нет в пакете: ${some(missing)}`, m.keyId);
  const extra = [...bytes.files.keys()].filter((file) => !Object.hasOwn(m.files, file));
  if (extra.length > 0) return fail('extra', `лишний файл, которого нет в подписи: ${some(extra)}`, m.keyId);
  const digest = sha256Hex(canonicalBytes(m));
  if (policy.revokedHashes !== undefined) {
    if (policy.revokedHashes.has(digest)) return fail('revoked-hash', 'этот выпуск пакета отозван', m.keyId);
    const bad = Object.entries(m.files).filter(([, hash]) => policy.revokedHashes?.has(hash) === true).map(([file]) => file);
    if (bad.length > 0) return fail('revoked-hash', `файл отозван: ${some(bad)}`, m.keyId);
  }
  return { ok: true, manifest: m, digest };
}

// ---------- чтение пакета с диска ----------

export interface PackageTree extends PackageBytes {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly links: ReadonlyMap<string, string>;
  readonly integrity?: Buffer | undefined;
}

/**
 * Читает каталог пакета целиком, один раз: каждый файл - в память. Дальше проверяют и исполняют эти байты, а не путь. `integrity.json` в корне отдаётся отдельно;
 * скрытые файлы читаются тоже (лишний файл под скрытым именем должен попасть в проверку), ссылки не раскрываются.
 */
export async function readPackageTree(dir: string): Promise<PackageTree> {
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  let integrity: Buffer | undefined;
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) links.set(rel, await fs.readlink(full));
      else if (entry.isFile()) {
        if (files.size + links.size >= MAX_FILES) throw new Error(`в пакете больше ${String(MAX_FILES)} файлов`);
        const data = await fs.readFile(full);
        total += data.length;
        if (total > MAX_BYTES) throw new Error(`пакет больше ${String(MAX_BYTES / 1024 / 1024)} МиБ`);
        if (rel === INTEGRITY_FILE) integrity = data;
        else files.set(rel, data);
      }
    }
  };
  await walk(dir);
  return { files, links, integrity };
}
