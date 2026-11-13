import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { keyIdOf, signBytes, verifyBytes, checkPublicKey, publicKeyOf, type IntegrityCode } from './integrity.ts';

// P-07: контрольные суммы поставки (SAD 6.1, «Поставка плагинов приложения»). Файл delivery.json лежит в каталоге поставки рядом с каталогами плагинов:
// плагин -> файл (путь от каталога плагина через /) -> sha256. Расхождение сообщается; отказ запуска и подпись списка ключом выпуска - TR-11 и TR-12 (ADR-CH-0017):
// список подписан Ed25519 (`signature`), ключ выпуска зашит в приложение, и перед запуском плагина ядро сверяет его файлы с подписанным списком, а не с диском.

/** Имя файла со списком хешей в каталоге поставки. */
export const DELIVERY_FILE = 'delivery.json';

/** Подпись списка поставки ключом выпуска (TR-12). */
export interface DeliverySignatureRecord {
  /** Идентификатор ключа выпуска (`keyIdOf`). */
  readonly keyId: string;
  /** Срок подписи, UTC, `Date.toISOString()`; позже него поставка не считается подписанной. */
  readonly notAfter: string;
  /** Подпись Ed25519, base64, над канонической записью без этого поля. */
  readonly value: string;
}

export interface DeliveryManifest {
  readonly format: 1;
  /** Имя каталога плагина -> файл -> sha256 в hex (для символической ссылки - `link:<цель>`). */
  readonly plugins: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Подпись ключом выпуска; нет - список не подписан (старые поставки читаются как раньше). */
  readonly signature?: DeliverySignatureRecord;
}

/** Итог проверки подписи списка поставки. */
export type DeliverySignature =
  | { readonly ok: true; readonly keyId: string; readonly notAfter: string }
  | { readonly ok: false; readonly code: IntegrityCode; readonly reason: string; readonly keyId?: string };

/** Метка области подписи: подпись поставки не сойдётся с подписью пакета того же ключа. */
const SIGNATURE_DOMAIN = 'cyborg-delivery/v1\n';

/** Байты, над которыми стоит подпись: метка, формат, ключ, срок и хеши плагинов в каноническом порядке. */
function signedBytes(plugins: DeliveryManifest['plugins'], keyId: string, notAfter: string): Buffer {
  const sorted = Object.fromEntries(Object.entries(plugins).sort(([a], [b]) => byName(a, b)).map(([name, files]) => [name, Object.fromEntries(Object.entries(files).sort(([a], [b]) => byName(a, b)))]));
  return Buffer.from(`${SIGNATURE_DOMAIN}${JSON.stringify({ format: 1, keyId, notAfter, plugins: sorted })}`, 'utf8');
}

const SHA256 = /^[0-9a-f]{64}$/;
const LINK = 'link:';

/** Каталог плагина - любой подкаталог поставки; скрытые тоже: подброшенное под скрытым именем должно попасть в список. */
async function pluginDirs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(byName);
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Запись списка по прочитанным файлам и ссылкам каталога плагина: путь -> sha256 (у ссылки - `link:<цель>`), по алфавиту. Одно правило для записи списка и для проверки перед запуском. */
export function deliveryEntries(files: ReadonlyMap<string, Uint8Array>, links: ReadonlyMap<string, string> = new Map()): Record<string, string> {
  const all: [string, string][] = [
    ...[...files].map(([file, data]): [string, string] => [file, createHash('sha256').update(data).digest('hex')]),
    ...[...links].map(([file, target]): [string, string] => [file, `${LINK}${target}`]),
  ];
  return Object.fromEntries(all.sort(([a], [b]) => byName(a, b)));
}

/** Файлы каталога плагина -> хеш; пути через `/`, по алфавиту. Ссылка не читается: хешируется её цель-текст, подмена файла ссылкой видна. */
async function hashTree(home: string): Promise<Record<string, string>> {
  const files = new Map<string, Buffer>();
  const links = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(home, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) links.set(rel, await fs.readlink(full));
      else if (entry.isFile()) files.set(rel, await fs.readFile(full));
    }
  };
  await walk(home);
  return deliveryEntries(files, links);
}

async function hashCatalog(root: string): Promise<DeliveryManifest['plugins']> {
  const plugins: Record<string, Record<string, string>> = {};
  for (const name of await pluginDirs(root)) plugins[name] = await hashTree(path.join(root, name));
  return plugins;
}

export interface WriteDeliveryOptions {
  /** Подписать список ключом выпуска (`ed25519-secret:…`) со сроком `notAfter`. */
  readonly sign?: { readonly secretKey: string; readonly notAfter: Date };
}

/** Считает хеши всех плагинов каталога поставки и пишет `delivery.json`. Прежний файл на результат не влияет: он лежит в корне, а не в каталоге плагина. */
export async function writeDelivery(root: string, options: WriteDeliveryOptions = {}): Promise<DeliveryManifest> {
  const plugins = await hashCatalog(root);
  let signature: DeliverySignatureRecord | undefined;
  if (options.sign !== undefined) {
    if (Number.isNaN(options.sign.notAfter.getTime())) throw new Error('срок подписи поставки: ожидалась дата');
    const keyId = keyIdOf(publicKeyOf(options.sign.secretKey));
    const notAfter = options.sign.notAfter.toISOString();
    signature = { keyId, notAfter, value: signBytes(options.sign.secretKey, signedBytes(plugins, keyId, notAfter)) };
  }
  const manifest: DeliveryManifest = { format: 1, plugins, ...(signature !== undefined && { signature }) };
  await fs.writeFile(path.join(root, DELIVERY_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Список из `delivery.json`; `undefined`, если файла нет. Файл нечитаемый или чужого формата - исключение с причиной. */
export async function readDelivery(root: string): Promise<DeliveryManifest | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, DELIVERY_FILE), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new Error(`${DELIVERY_FILE} не прочитан - ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${DELIVERY_FILE} не разобран - ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) throw new Error(`${DELIVERY_FILE}: ожидался объект`);
  if (raw.format !== 1) throw new Error(`${DELIVERY_FILE}: формат ${JSON.stringify(raw.format)} не поддерживается (ожидался 1)`);
  if (!isRecord(raw.plugins)) throw new Error(`${DELIVERY_FILE}: нет объекта plugins`);
  const plugins: Record<string, Record<string, string>> = {};
  for (const [name, files] of Object.entries(raw.plugins)) {
    if (!isRecord(files)) throw new Error(`${DELIVERY_FILE}: ${name}: ожидался объект файлов`);
    const hashes: Record<string, string> = {};
    for (const [file, hash] of Object.entries(files)) {
      if (typeof hash !== 'string' || !(SHA256.test(hash) || hash.startsWith(LINK))) throw new Error(`${DELIVERY_FILE}: ${name}/${file}: ожидался sha256`);
      hashes[file] = hash;
    }
    plugins[name] = hashes;
  }
  const signature = parseSignature(raw.signature);
  return { format: 1, plugins, ...(signature !== undefined && { signature }) };
}

function parseSignature(raw: unknown): DeliverySignatureRecord | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.keyId !== 'string' || typeof raw.notAfter !== 'string' || typeof raw.value !== 'string') throw new Error(`${DELIVERY_FILE}: signature - ожидались keyId, notAfter и value`);
  return { keyId: raw.keyId, notAfter: raw.notAfter, value: raw.value };
}

/**
 * Подпись списка поставки (TR-12): ключ выпуска из `releaseKeys` (зашит в приложение), подпись верна, срок не вышел. Списка без подписи, подписи чужого ключа и
 * правленного списка не принимает. Хеши файлов этим не сверяются: их сверяет `verifyDelivery` и проверка перед запуском плагина.
 */
export function verifyDeliverySignature(manifest: DeliveryManifest, releaseKeys: readonly string[], now: number): DeliverySignature {
  const sig = manifest.signature;
  if (sig === undefined) return { ok: false, code: 'no-integrity', reason: `${DELIVERY_FILE} не подписан ключом выпуска` };
  const keys = new Map(releaseKeys.filter((key) => checkPublicKey(key) === undefined).map((key) => [keyIdOf(key), key]));
  const publicKey = keys.get(sig.keyId);
  if (publicKey === undefined) return { ok: false, code: 'unknown-key', reason: `${DELIVERY_FILE} подписан ключом ${sig.keyId}, которого нет среди ключей выпуска приложения`, keyId: sig.keyId };
  if (!verifyBytes(publicKey, signedBytes(manifest.plugins, sig.keyId, sig.notAfter), sig.value)) return { ok: false, code: 'bad-signature', reason: `подпись ${DELIVERY_FILE} не сходится: список правили или подписал другой ключ`, keyId: sig.keyId };
  if (Number.isNaN(Date.parse(sig.notAfter)) || Date.parse(sig.notAfter) < now) return { ok: false, code: 'expired', reason: `срок подписи ${DELIVERY_FILE} истёк ${sig.notAfter}`, keyId: sig.keyId };
  return { ok: true, keyId: sig.keyId, notAfter: sig.notAfter };
}

const short = (hash: string): string => (hash.startsWith(LINK) ? hash : hash.slice(0, 12));

/**
 * Сверка каталога поставки со списком. Возвращает по строке на расхождение (пустой список - поставка цела): изменённый, пропавший и лишний файл,
 * пропавший и лишний каталог плагина; с `releaseKeys` ещё и подпись списка (TR-12). Ничего не бросает на отсутствие каталога: пропавшая поставка - расхождение всех плагинов.
 */
export async function verifyDelivery(root: string, manifest: DeliveryManifest, options: { readonly releaseKeys?: readonly string[]; readonly now?: number } = {}): Promise<string[]> {
  const problems: string[] = [];
  if (options.releaseKeys !== undefined) {
    const signature = verifyDeliverySignature(manifest, options.releaseKeys, options.now ?? Date.now());
    if (!signature.ok) problems.push(signature.reason);
  }
  const onDisk = await hashCatalog(root);
  for (const [name, expected] of Object.entries(manifest.plugins)) {
    const actual = onDisk[name];
    if (actual === undefined) {
      problems.push(`${name}: каталога плагина нет в поставке`);
      continue;
    }
    for (const [file, hash] of Object.entries(expected)) {
      const found = actual[file];
      if (found === undefined) problems.push(`${name}/${file}: файла нет в поставке`);
      else if (found !== hash) problems.push(`${name}/${file}: контрольная сумма не совпала (в ${DELIVERY_FILE} ${short(hash)}, на диске ${short(found)})`);
    }
    for (const file of Object.keys(actual)) if (!(file in expected)) problems.push(`${name}/${file}: файла нет в ${DELIVERY_FILE}`);
  }
  for (const name of Object.keys(onDisk)) if (!(name in manifest.plugins)) problems.push(`${name}: каталога плагина нет в ${DELIVERY_FILE}`);
  return problems;
}
