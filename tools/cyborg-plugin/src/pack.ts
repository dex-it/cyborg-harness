import fs from 'node:fs/promises';
import path from 'node:path';
import { checkPlugin, CHECKED_KEYS, isTestPath, type Problem } from '@cyborg-harness/core/plugin-check';
import { INTEGRITY_FILE, hashFiles, parseIntegrity } from '@cyborg-harness/core/integrity';
import { inside, listFiles, realpathLoose, toPosix } from './fsx.ts';
import { tarGz, type TarEntry } from './tar.ts';

// P-06: формат поставки плагина (SAD 6.1) - каталог результата `build`; `pack` складывает его в один воспроизводимый tar.gz.
// Подпись (TR-10, ADR-CH-0017) ставит `sign` на каталог до упаковки: `integrity.json` едет в архив обычным файлом, а `pack` проверяет, что он не устарел.
// Источник установки (вопрос 8 SAD) формат не задаёт.

export interface PackOptions {
  /** Файл архива; по умолчанию `<id>-<версия>.tgz` в текущем каталоге. */
  readonly out?: string;
  /** Только проверить состав и перечислить файлы, архив не писать. */
  readonly dryRun?: boolean;
  readonly apiVersion?: string;
}

export interface PackReport {
  readonly ok: boolean;
  readonly dir: string;
  readonly id?: string | undefined;
  readonly version?: string | undefined;
  readonly problems: readonly Problem[];
  /** Файл архива; нет при `dryRun` или отказе. */
  readonly archive?: string | undefined;
  /** Файлы в архиве: путь от каталога плагина и размер. */
  readonly files: readonly { readonly path: string; readonly size: number }[];
  /** Размер архива в байтах (при `dryRun` - каким он был бы); 0 при отказе. */
  readonly bytes: number;
}

/** Корень архива: распаковка в каталог плагинов даёт `<id>/manifest.json`. */
export const archiveRoot = (id: string): string => id;

export async function packPlugin(dir: string, options: PackOptions = {}): Promise<PackReport> {
  const abs = path.resolve(dir);
  const bad = (problems: Problem[], extra: Partial<PackReport> = {}): PackReport => ({ ok: false, dir: abs, problems, files: [], bytes: 0, ...extra });
  const report = await checkPlugin(abs, options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion });
  const problems: Problem[] = [...report.problems];
  if (report.manifest === undefined) return bad(problems, { id: report.id });
  const home = report.dir;
  const manifest = report.manifest;

  // Поставка - уже собранный каталог: исходник вместо результата сборки загрузил бы плагин без бандла, а `.ts` в `node_modules` Node не снимает.
  const skipped = (rel: string): boolean => isTestPath(rel);
  const all = await listFiles(home, skipped, (rel) => problems.push({ file: rel, message: 'символическая ссылка не входит в поставку: положите в каталог сам файл' }));
  for (const rel of all) {
    if (/\.(?:m|c)?ts$/.test(rel) && !rel.endsWith('.d.ts')) problems.push({ file: rel, message: 'исходник .ts в поставке: сначала `cyborg-plugin build`' });
  }
  if (!all.includes('index.mjs')) problems.push({ file: 'index.mjs', message: 'в поставке главная часть - index.mjs, собранный `cyborg-plugin build`' });
  for (const reader of Object.values(CHECKED_KEYS)) {
    for (const ref of reader(manifest)) {
      const rel = toPosix(path.normalize(ref.file));
      if (!all.includes(rel)) problems.push({ file: 'manifest.json', message: `${ref.field}: в поставке нет ${ref.file} (виды и схемы - готовые файлы, без исходников)` });
    }
  }
  if (all.includes(INTEGRITY_FILE)) problems.push(...(await staleSignature(home, all)));
  if (problems.length > 0) return bad(problems, { id: manifest.id, version: manifest.version });

  const archive = path.resolve(options.out ?? `${manifest.id}-${manifest.version}.tgz`);
  if (inside(home, await realpathLoose(archive))) return bad([{ file: '.', message: `--out ${archive}: архив не может лежать внутри упаковываемого каталога` }], { id: manifest.id, version: manifest.version });

  const entries: TarEntry[] = [];
  const files: { path: string; size: number }[] = [];
  for (const rel of all) {
    const data = await fs.readFile(path.join(home, rel));
    entries.push({ name: `${archiveRoot(manifest.id)}/${rel}`, data });
    files.push({ path: rel, size: data.length });
  }
  let packed: Buffer;
  try {
    packed = tarGz(entries);
    if (options.dryRun !== true) await fs.writeFile(archive, packed);
  } catch (error) {
    return bad([{ file: '.', message: error instanceof Error ? error.message : String(error) }], { id: manifest.id, version: manifest.version, files });
  }
  return { ok: true, dir: home, id: manifest.id, version: manifest.version, problems: [], archive: options.dryRun === true ? undefined : archive, files, bytes: packed.length };
}

/**
 * Подпись, оставшаяся от прежней сборки, в архив не едет: после правки файла она описывает не то, что упаковано, и `verify` отказал бы на стороне установки.
 * Ключа у `pack` нет, поэтому сверяются хеши и состав; верность самой подписи проверяет `verify`.
 */
async function staleSignature(home: string, all: readonly string[]): Promise<Problem[]> {
  const parsed = parseIntegrity(await fs.readFile(path.join(home, INTEGRITY_FILE), 'utf8'));
  if (typeof parsed === 'string') return [{ file: INTEGRITY_FILE, message: parsed }];
  const files = new Map<string, Buffer>();
  for (const rel of all) if (rel !== INTEGRITY_FILE) files.set(rel, await fs.readFile(path.join(home, rel)));
  const actual = hashFiles(files);
  const changed = [...new Set([...Object.keys(actual), ...Object.keys(parsed.files)])].filter((file) => actual[file] !== parsed.files[file]);
  return changed.length === 0 ? [] : [{ file: INTEGRITY_FILE, message: `подпись устарела, не совпадают: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' и другие' : ''}; подпишите заново (cyborg-plugin sign)` }];
}
