import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { deliveryEntries, type DeliveryManifest } from './delivery.ts';
import { INTEGRITY_FILE, describeDiff, diffHashes, keyIdOf, readPackageTree, verifyIntegrity, type IntegrityCode, type PackageTree } from './integrity.ts';
import { compareVersions, parseVersion } from './semver.ts';
import type { TrustStore } from './trust-store.ts';

// TR-11 (ADR-CH-0017): проверка пакета перед запуском. Ядро читает каталог плагина один раз, проверяет эти байты (подпись, хеши, версия, отзыв) и отдаёт хосту их же:
// второй раз файл с диска не открывается, поэтому между проверкой и исполнением его не подменить (`VerifiedPackage`, host-runtime). Встроенные плагины проверяются
// по подписанному `delivery.json` (TR-12), плагины каталога пользователя - по `integrity.json` пакета и ключам из `trust.json`.

/** `off` - не проверять; `warn` - записать `integrity-failed` и запустить как раньше; `enforce` - записать и не запускать. */
export type TrustMode = 'off' | 'warn' | 'enforce';

/** Проверенный пакет для хоста: адрес каталога и содержимое файлов, которые можно загружать как модули. */
export interface VerifiedPackage {
  /** Адрес каталога плагина (`file:`, с косой чертой на конце), настоящий путь после `realpath`. */
  readonly base: string;
  /** Путь от каталога через `/` -> байты, проверенные ядром, в base64: так они одинаково доезжают по любому каналу хоста (structuredClone, JSON). */
  readonly files: Readonly<Record<string, string>>;
}

export type ProvenanceVerdict =
  | { readonly ok: true; /** Нет при `mode: 'off'`: проверять было нечего. */ readonly verified?: VerifiedPackage }
  | { readonly ok: false; readonly code: IntegrityCode; readonly reason: string; readonly mode: 'warn' | 'enforce'; readonly keyId?: string };

/** Проверка происхождения плагина перед активацией (`LoadOptions.provenance`). */
export interface Provenance {
  check(manifest: { readonly id: string; readonly version: string }): Promise<ProvenanceVerdict>;
}

/** Итог проверки подписи `delivery.json` при старте (TR-12). */
export type DeliverySignature = { readonly ok: true; readonly keyId: string; readonly notAfter: string } | { readonly ok: false; readonly code: IntegrityCode; readonly reason: string; readonly keyId?: string };

export interface DeliveryState {
  readonly manifest: DeliveryManifest | undefined;
  /** Подпись поставки; `undefined` - не проверялась (в `warn` нет ключей поставки). */
  readonly signature?: DeliverySignature | undefined;
}

export interface ProvenanceOptions {
  readonly trust: TrustStore;
  /** Открытые ключи издателя поставки, зашитые в приложение. Они же доверенные издатели пакетов каталога пользователя. */
  readonly releaseKeys: readonly string[];
  /** Режим для плагина; обычно по происхождению (поставка начинает с `warn`). */
  readonly mode: (pluginId: string) => TrustMode;
  readonly bundled: (pluginId: string) => boolean;
  readonly homeOf: (pluginId: string) => string | undefined;
  /** Манифест плагина, как его разобрал поиск плагинов: он должен совпасть с подписанным `manifest.json`, иначе права ядра взяты из другого файла. */
  readonly rawManifestOf?: ((pluginId: string) => unknown) | undefined;
  readonly delivery?: DeliveryState | undefined;
  readonly now?: () => number;
}

/** Файлы, которые хост грузит как модули. Остальное (виды, схемы, картинки) хосту не нужно, по каналу не едет. */
const LOADABLE = /\.(?:mjs|cjs|js|json)$/;

const fail = (code: IntegrityCode, reason: string, mode: 'warn' | 'enforce', keyId?: string): ProvenanceVerdict => ({ ok: false, code, reason, mode, ...(keyId !== undefined && { keyId }) });

function parseManifest(tree: PackageTree): { id?: string; version?: string; raw?: unknown } {
  const bytes = tree.files.get('manifest.json');
  if (bytes === undefined) return {};
  try {
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    return { raw, ...('id' in raw && typeof raw.id === 'string' && { id: raw.id }), ...('version' in raw && typeof raw.version === 'string' && { version: raw.version }) };
  } catch {
    return {};
  }
}

async function packageOf(tree: PackageTree, home: string): Promise<VerifiedPackage> {
  const files: Record<string, string> = {};
  for (const [file, data] of tree.files) if (LOADABLE.test(file)) files[file] = data.toString('base64');
  return { base: pathToFileURL(`${await fs.realpath(home)}${path.sep}`).href, files };
}

export function createProvenance(options: ProvenanceOptions): Provenance {
  const now = options.now ?? Date.now;

  async function check(manifest: { id: string; version: string }): Promise<ProvenanceVerdict> {
    const mode = options.mode(manifest.id);
    if (mode === 'off') return { ok: true };
    try {
      return await verify(manifest, mode);
    } catch (error) {
      return fail('unavailable', `проверка не выполнена: ${error instanceof Error ? error.message : String(error)}`, mode);
    }
  }

  async function verify(manifest: { id: string; version: string }, mode: 'warn' | 'enforce'): Promise<ProvenanceVerdict> {
    const { trust } = options;
    if (trust.error !== undefined) return fail('unavailable', trust.error, mode);
    const home = options.homeOf(manifest.id);
    if (home === undefined) return fail('unavailable', 'каталог плагина не найден', mode);
    const tree = await readPackageTree(home);
    const parsed = parseManifest(tree);
    if (parsed.id !== manifest.id || parsed.version !== manifest.version) return fail('mismatch', `manifest.json пакета (${parsed.id ?? '?'} ${parsed.version ?? '?'}) не тот, что прочитал поиск плагинов (${manifest.id} ${manifest.version})`, mode);
    const seen = options.rawManifestOf?.(manifest.id);
    if (seen !== undefined && !isDeepStrictEqual(seen, parsed.raw)) return fail('mismatch', 'manifest.json изменился после того, как ядро разобрало права плагина', mode);

    if (options.bundled(manifest.id)) {
      const failure = bundledFailure(manifest, tree, mode, home);
      if (failure !== undefined) return failure;
    } else {
      const keys = trust.publisherKeys();
      for (const key of options.releaseKeys) keys.set(keyIdOf(key), key);
      const verdict = verifyIntegrity(tree, { keys, revokedKeys: trust.revokedKeys(), revokedHashes: trust.revokedHashes(), now: now(), expect: { id: manifest.id, version: manifest.version }, highestSeen: trust.highestSeen(manifest.id) });
      if (!verdict.ok) return fail(verdict.code, verdict.reason, mode, verdict.keyId);
    }
    await trust.recordVersion(manifest.id, manifest.version);
    return { ok: true, verified: await packageOf(tree, home) };
  }

  /** Встроенный плагин сверяется со списком поставки; отказ или `undefined`, если расхождений нет. */
  function bundledFailure(manifest: { id: string; version: string }, tree: PackageTree, mode: 'warn' | 'enforce', home: string): ProvenanceVerdict | undefined {
    const { trust, delivery } = options;
    if (delivery?.manifest === undefined) return fail('no-integrity', 'в каталоге поставки нет delivery.json: контрольные суммы не проверены', mode);
    const signature = delivery.signature;
    if (signature !== undefined && !signature.ok) return fail(signature.code, signature.reason, mode, signature.keyId);
    if (signature?.ok === true && trust.revokedKeys().has(signature.keyId)) return fail('revoked-key', `ключ поставки ${signature.keyId} отозван`, mode, signature.keyId);
    const name = path.basename(home);
    const expected = Object.hasOwn(delivery.manifest.plugins, name) ? delivery.manifest.plugins[name] : undefined;
    if (expected === undefined) return fail('missing', `плагина ${name} нет в delivery.json`, mode);
    const files = new Map(tree.files);
    if (tree.integrity !== undefined) files.set(INTEGRITY_FILE, tree.integrity);
    const actual = deliveryEntries(files, tree.links);
    const problem = describeDiff(diffHashes(actual, expected));
    if (problem !== undefined) return fail(problem.code, problem.reason.replace('после подписи', 'после выпуска поставки'), mode, signature?.ok === true ? signature.keyId : undefined);
    const have = parseVersion(manifest.version);
    const highest = trust.highestSeen(manifest.id);
    const seen = highest === undefined ? null : parseVersion(highest);
    if (have !== null && seen !== null && compareVersions(have, seen) < 0) return fail('rollback', `версия ${manifest.version} ниже уже принимавшейся ${highest ?? ''}: откат отвергнут`, mode);
    const revoked = trust.revokedHashes();
    const bad = Object.entries(actual).filter(([, hash]) => revoked.has(hash)).map(([file]) => file);
    if (bad.length > 0) return fail('revoked-hash', `файл отозван: ${bad.slice(0, 5).join(', ')}`, mode);
    return undefined;
  }

  return { check };
}
