import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// P-07: контрольные суммы поставки (SAD 6.1, «Поставка плагинов приложения»). Файл delivery.json лежит в каталоге поставки рядом с каталогами плагинов:
// плагин -> файл (путь от каталога плагина через /) -> sha256. На этапе 1 расхождение только сообщается; подпись и отказ - этап 2.

/** Имя файла со списком хешей в каталоге поставки. */
export const DELIVERY_FILE = 'delivery.json';

export interface DeliveryManifest {
  readonly format: 1;
  /** Имя каталога плагина -> файл -> sha256 в hex (для символической ссылки - `link:<цель>`). */
  readonly plugins: Readonly<Record<string, Readonly<Record<string, string>>>>;
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

/** Файлы каталога плагина -> хеш; пути через `/`, по алфавиту. Ссылка не читается: хешируется её цель-текст, подмена файла ссылкой видна. */
async function hashTree(home: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(home, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isSymbolicLink()) out[rel] = `${LINK}${await fs.readlink(full)}`;
      else if (entry.isFile()) out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    }
  };
  await walk(home);
  return out;
}

async function hashCatalog(root: string): Promise<DeliveryManifest['plugins']> {
  const plugins: Record<string, Record<string, string>> = {};
  for (const name of await pluginDirs(root)) plugins[name] = await hashTree(path.join(root, name));
  return plugins;
}

/** Считает хеши всех плагинов каталога поставки и пишет `delivery.json`. Прежний файл на результат не влияет: он лежит в корне, а не в каталоге плагина. */
export async function writeDelivery(root: string): Promise<DeliveryManifest> {
  const manifest: DeliveryManifest = { format: 1, plugins: await hashCatalog(root) };
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
    throw new Error(`${DELIVERY_FILE} не прочитан - ${error instanceof Error ? error.message : String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${DELIVERY_FILE} не разобран - ${error instanceof Error ? error.message : String(error)}`);
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
  return { format: 1, plugins };
}

const short = (hash: string): string => (hash.startsWith(LINK) ? hash : hash.slice(0, 12));

/**
 * Сверка каталога поставки со списком. Возвращает по строке на расхождение (пустой список - поставка цела): изменённый, пропавший и лишний файл,
 * пропавший и лишний каталог плагина. Ничего не бросает на отсутствие каталога: пропавшая поставка - расхождение всех плагинов.
 */
export async function verifyDelivery(root: string, manifest: DeliveryManifest): Promise<string[]> {
  const problems: string[] = [];
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
