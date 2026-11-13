import fs from 'node:fs/promises';
import path from 'node:path';
import {
  INTEGRITY_FILE,
  checkPublicKey,
  generateSigningKey,
  hashFiles,
  keyIdOf,
  readPackageTree,
  renderIntegrity,
  signIntegrity,
  signRevocations,
  verifyIntegrity,
  type IntegrityVerdict,
  type PackageBytes,
} from '@cyborg-harness/core/integrity';
import { isTestPath, type Problem } from '@cyborg-harness/core/plugin-check';
import { BUILD_MARKER, exists, listFiles } from './fsx.ts';
import { untarGz } from './tar.ts';

// TR-10 (ADR-CH-0017): `keygen`, `sign` и `verify`. Подпись ставится на собранный каталог (результат `build`), состав файлов тот же, что у `pack`:
// архив из подписанного каталога проходит `verify` без изменений. Закрытый ключ в репозиторий и в сборку не кладут: его держит тот, кто выпускает.

const DAY_MS = 86_400_000;
/** Срок подписи по умолчанию, если автор не назвал свой. */
export const DEFAULT_DAYS = 365;

const codeOf = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

export interface KeygenReport {
  readonly ok: boolean;
  readonly problems: readonly Problem[];
  readonly keyId?: string;
  readonly publicKey?: string;
  readonly secretFile?: string;
  readonly publicFile?: string;
}

/** Новая пара ключей: `<префикс>.key` (закрытый, права 0600) и `<префикс>.pub`. Существующий файл не затирается. */
export async function keygen(prefix: string): Promise<KeygenReport> {
  const secretFile = path.resolve(`${prefix}.key`);
  const publicFile = path.resolve(`${prefix}.pub`);
  const key = generateSigningKey();
  try {
    await fs.writeFile(secretFile, `${key.secretKey}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await fs.writeFile(publicFile, `${key.publicKey}\n`, { flag: 'wx' });
    } catch (error) {
      await fs.rm(secretFile, { force: true });
      throw error;
    }
  } catch (error) {
    const why = codeOf(error) === 'EEXIST' ? 'файл уже есть, старый ключ не затирается: выберите другой префикс' : error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [{ file: prefix, message: why }] };
  }
  return { ok: true, problems: [], keyId: key.keyId, publicKey: key.publicKey, secretFile, publicFile };
}

/** Содержимое файла ключа без пробелов по краям. */
async function readKey(file: string, what: string): Promise<{ text?: string; problem?: Problem }> {
  try {
    return { text: (await fs.readFile(file, 'utf8')).trim() };
  } catch (error) {
    return { problem: { file, message: `${what} не прочитан: ${error instanceof Error ? error.message : String(error)}` } };
  }
}

export interface SignOptions {
  /** Файл закрытого ключа (`keygen`). */
  readonly keyFile: string;
  /** Срок подписи в днях от `now`; по умолчанию 365. */
  readonly days?: number;
  /** Срок подписи датой; перекрывает `days`. */
  readonly expires?: Date;
  readonly now?: number;
}

export interface SignReport {
  readonly ok: boolean;
  readonly dir: string;
  readonly problems: readonly Problem[];
  readonly id?: string;
  readonly version?: string;
  readonly keyId?: string;
  readonly notAfter?: string;
  readonly files: number;
}

async function manifestOf(home: string): Promise<{ id?: string; version?: string }> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(home, 'manifest.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const id = 'id' in raw && typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined;
    const version = 'version' in raw && typeof raw.version === 'string' ? raw.version : undefined;
    return { ...(id !== undefined && { id }), ...(version !== undefined && { version }) };
  } catch {
    return {};
  }
}

/** Подписывает собранный каталог плагина: `integrity.json` с хешами файлов, срок, ключ. Прежний `integrity.json` заменяется. */
export async function signPlugin(dir: string, options: SignOptions): Promise<SignReport> {
  const home = path.resolve(dir);
  const bad = (problems: Problem[], extra: Partial<SignReport> = {}): SignReport => ({ ok: false, dir: home, problems, files: 0, ...extra });
  if (!(await exists(home))) return bad([{ file: dir, message: 'каталога нет' }]);
  const { id, version } = await manifestOf(home);
  if (id === undefined || version === undefined) return bad([{ file: 'manifest.json', message: 'не прочитан или в нём нет id и version: это не каталог плагина' }]);
  const secret = await readKey(options.keyFile, 'закрытый ключ');
  if (secret.problem !== undefined || secret.text === undefined) return bad(secret.problem === undefined ? [] : [secret.problem], { id, version });
  const now = options.now ?? Date.now();
  const notAfter = options.expires ?? new Date(now + (options.days ?? DEFAULT_DAYS) * DAY_MS);
  if (Number.isNaN(notAfter.getTime())) return bad([{ file: '--expires', message: 'ожидалась дата' }], { id, version });
  if (notAfter.getTime() <= now) return bad([{ file: '--expires', message: 'срок подписи уже прошёл' }], { id, version });

  const problems: Problem[] = [];
  const names = await listFiles(home, (rel) => isTestPath(rel), (rel) => problems.push({ file: rel, message: 'символическая ссылка не входит в пакет: положите в каталог сам файл' }));
  const files = new Map<string, Buffer>();
  for (const rel of names) if (rel !== INTEGRITY_FILE) files.set(rel, await fs.readFile(path.join(home, rel)));
  if (problems.length > 0) return bad(problems, { id, version });
  try {
    const manifest = signIntegrity({ id, version, files: hashFiles(files), notAfter }, secret.text);
    await fs.writeFile(path.join(home, INTEGRITY_FILE), renderIntegrity(manifest));
    return { ok: true, dir: home, problems: [], id, version, keyId: manifest.keyId, notAfter: manifest.notAfter, files: files.size };
  } catch (error) {
    return bad([{ file: options.keyFile, message: error instanceof Error ? error.message : String(error) }], { id, version });
  }
}

export interface VerifyOptions {
  /** Доверенные открытые ключи: файлы (`keygen`, `.pub`) или сама запись `ed25519:<base64>`. */
  readonly keys: readonly string[];
  readonly now?: number;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly target: string;
  readonly problems: readonly Problem[];
  /** Итог проверки подписи; нет, если до неё не дошли (нечего читать, ключи не прочитаны). */
  readonly verdict?: IntegrityVerdict;
  readonly id?: string;
  readonly version?: string;
  readonly files: number;
}

async function trustedKeys(keys: readonly string[]): Promise<{ map: Map<string, string>; problems: Problem[] }> {
  const map = new Map<string, string>();
  const problems: Problem[] = [];
  for (const entry of keys) {
    const read = entry.startsWith('ed25519:') ? { text: entry } : await readKey(entry, 'открытый ключ');
    if (read.problem !== undefined) {
      problems.push(read.problem);
      continue;
    }
    const why = checkPublicKey(read.text ?? '');
    if (why !== undefined || read.text === undefined) problems.push({ file: entry, message: why ?? 'пусто' });
    else map.set(keyIdOf(read.text), read.text);
  }
  if (keys.length === 0) problems.push({ file: '--key', message: 'нужен хотя бы один доверенный открытый ключ' });
  return { map, problems };
}

/** Содержимое архива как пакет: корень `<id>/` снят, он обязан быть один. */
function archiveBytes(archive: Uint8Array): { bytes: PackageBytes; root: string } | string {
  const { files, links } = untarGz(archive);
  const roots = new Set([...files.keys(), ...links.keys()].map((name) => name.split('/')[0] ?? ''));
  const [root] = [...roots];
  if (roots.size !== 1 || root === undefined) return roots.size === 0 ? 'архив пуст' : `в архиве несколько корней: ${[...roots].join(', ')}`;
  const strip = (name: string) => name.slice(root.length + 1);
  const inner = new Map<string, Buffer>();
  for (const [name, data] of files) if (name.includes('/')) inner.set(strip(name), data);
  const innerLinks = new Map<string, string>([...links].map(([name, target]) => [strip(name), target]));
  const integrity = inner.get(INTEGRITY_FILE);
  inner.delete(INTEGRITY_FILE);
  return { bytes: { files: inner, links: innerLinks, integrity }, root };
}

/**
 * Проверяет подпись так, как её проверит ядро: каталог или архив `.tgz` читаются один раз целиком, лишний файл тоже отказ. Из каталога метка сборки
 * (`.cyborg-plugin-build`) не в счёт: её нет ни в подписи, ни в архиве.
 */
export async function verifyPlugin(target: string, options: VerifyOptions): Promise<VerifyReport> {
  const abs = path.resolve(target);
  const bad = (problems: Problem[], extra: Partial<VerifyReport> = {}): VerifyReport => ({ ok: false, target: abs, problems, files: 0, ...extra });
  const trusted = await trustedKeys(options.keys);
  if (trusted.problems.length > 0) return bad(trusted.problems);
  let bytes: PackageBytes;
  let root: string | undefined;
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const tree = await readPackageTree(abs);
      const files = new Map(tree.files);
      files.delete(BUILD_MARKER);
      bytes = { files, links: tree.links, integrity: tree.integrity };
    } else {
      const unpacked = archiveBytes(await fs.readFile(abs));
      if (typeof unpacked === 'string') return bad([{ file: target, message: unpacked }]);
      ({ bytes, root } = unpacked);
    }
  } catch (error) {
    return bad([{ file: target, message: error instanceof Error ? error.message : String(error) }]);
  }
  const manifestFile = bytes.files.get('manifest.json');
  let id: string | undefined;
  let version: string | undefined;
  try {
    const raw: unknown = JSON.parse(Buffer.from(manifestFile ?? '').toString('utf8'));
    if (typeof raw === 'object' && raw !== null) {
      id = 'id' in raw && typeof raw.id === 'string' ? raw.id : undefined;
      version = 'version' in raw && typeof raw.version === 'string' ? raw.version : undefined;
    }
  } catch {
    // нет manifest.json или он не разобран: подпись всё равно проверяется, но сверить id и версию не с чем
  }
  const verdict = verifyIntegrity(bytes, { keys: trusted.map, now: options.now ?? Date.now(), expect: { id, version } });
  const problems: Problem[] = verdict.ok ? [] : [{ file: INTEGRITY_FILE, message: verdict.reason }];
  if (verdict.ok && (id === undefined || version === undefined)) problems.push({ file: 'manifest.json', message: 'нет id или version: пакет подписан, но это не пакет плагина' });
  if (verdict.ok && root !== undefined && root !== id) problems.push({ file: target, message: `корень архива ${root} не равен id плагина ${id ?? ''}` });
  return { ok: problems.length === 0, target: abs, problems, verdict, ...(id !== undefined && { id }), ...(version !== undefined && { version }), files: bytes.files.size };
}

export interface RevokeOptions {
  /** Файл закрытого ключа, которому ядро доверяет отзыв (ключ поставки). */
  readonly keyFile: string;
  /** Номер списка: каждый следующий выше прежнего. */
  readonly serial: number;
  readonly keys: readonly string[];
  readonly hashes: readonly string[];
  readonly reason?: string;
  /** Сколько дней список считается свежим; по умолчанию 30. */
  readonly days?: number;
  readonly out: string;
  readonly now?: number;
}

export interface RevokeReport {
  readonly ok: boolean;
  readonly problems: readonly Problem[];
  readonly out?: string;
  readonly notAfter?: string;
}

/** Подписанный список отозванных ключей и хешей (`revocations.json` в userData приложения, TR-11). Существующий файл не затирается. */
export async function writeRevocations(options: RevokeOptions): Promise<RevokeReport> {
  const secret = await readKey(options.keyFile, 'закрытый ключ');
  if (secret.problem !== undefined || secret.text === undefined) return { ok: false, problems: secret.problem === undefined ? [] : [secret.problem] };
  if (options.keys.length + options.hashes.length === 0) return { ok: false, problems: [{ file: '.', message: 'нечего отзывать: нужен --revoke-key или --revoke-hash' }] };
  const now = options.now ?? Date.now();
  const notAfter = new Date(now + (options.days ?? 30) * DAY_MS);
  const reason = options.reason ?? '';
  try {
    const text = signRevocations(
      {
        serial: options.serial,
        keys: Object.fromEntries(options.keys.map((id) => [id, reason])),
        hashes: Object.fromEntries(options.hashes.map((id) => [id, reason])),
        issuedAt: new Date(now),
        notAfter,
      },
      secret.text,
    );
    await fs.writeFile(options.out, text, { flag: 'wx' });
    return { ok: true, problems: [], out: path.resolve(options.out), notAfter: notAfter.toISOString() };
  } catch (error) {
    const why = codeOf(error) === 'EEXIST' ? 'файл уже есть, не затираю: выберите другой --out' : error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [{ file: options.out, message: why }] };
  }
}
