import fs from 'node:fs/promises';
import path from 'node:path';
import { DELIVERY_FILE, writeDelivery } from '@cyborg-harness/core/delivery';
import type { Problem } from '@cyborg-harness/core/plugin-check';
import { buildPlugin, type BuildOptions } from './build.ts';
import { BUILD_MARKER, exists } from './fsx.ts';

// P-07: поставка приложения (SAD 6.1, «Поставка плагинов приложения») - каталог собранных плагинов `<id>/` и `delivery.json` с хешами их файлов.
// Каждый плагин собирает buildPlugin в режиме bundle (index.mjs, проверка исходников и результата); поставка не вводит своих правил сборки.

export interface DeliveryOptions extends Omit<BuildOptions, 'out' | 'main'> {
  /** Каталог поставки: нет такого пути, пустой или результат прежней сборки поставки (в нём `delivery.json`). */
  readonly out: string;
}

export interface DeliveryReport {
  readonly ok: boolean;
  /** Каталог поставки (абсолютный путь). */
  readonly out: string;
  /** id собранных плагинов по алфавиту; пусто при отказе. */
  readonly plugins: readonly string[];
  /** Нарушения; у нарушений плагина в `file` стоит `<id или каталог>: <файл>`. */
  readonly problems: readonly Problem[];
  readonly warnings: readonly string[];
}

const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

/** Занять `out` можно, если его нет, он пуст или это поставка прежней сборки: чужой каталог (`public/`, исходники) стирать нельзя. Текст отказа или undefined. */
async function outRefusal(out: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(out);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? undefined : `${out}: не каталог или не читается - укажите другой --out`;
  }
  return names.length === 0 || names.includes(DELIVERY_FILE) ? undefined : `${out}: каталог не пуст и не поставка (нет ${DELIVERY_FILE}) - укажите другой --out`;
}

/**
 * Собирает поставку из каталогов плагинов. Сначала всё во временный каталог рядом с `out`, затем целиком на место: отказ любого плагина
 * оставляет прежнюю поставку нетронутой. Плагины попадают в `<out>/<id>`; `delivery.json` считается по готовым файлам последним.
 */
export async function buildDelivery(dirs: readonly string[], options: DeliveryOptions): Promise<DeliveryReport> {
  const out = path.resolve(options.out);
  const fail = (problems: Problem[], warnings: string[] = []): DeliveryReport => ({ ok: false, out, plugins: [], problems, warnings });
  if (dirs.length === 0) return fail([{ file: '.', message: 'нет ни одного каталога плагина: поставка пустая' }]);
  const refusal = await outRefusal(out);
  if (refusal !== undefined) return fail([{ file: '.', message: refusal }]);

  const staging = path.join(path.dirname(out), `.${path.basename(out)}.delivery-${String(process.pid)}-${Date.now().toString(36)}`);
  const problems: Problem[] = [];
  const warnings: string[] = [];
  const ids: string[] = [];
  const seen = new Map<string, string>();
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const dir of dirs) {
      const home = path.resolve(dir);
      const id = await manifestId(home);
      if (id === undefined) {
        problems.push({ file: dir, message: 'manifest.json не прочитан или в нём нет id: это не каталог плагина' });
        continue;
      }
      const first = seen.get(id);
      if (first !== undefined) {
        problems.push({ file: dir, message: `повтор id ${id}: уже взят из ${first}` });
        continue;
      }
      seen.set(id, home);
      const report = await buildPlugin(home, { ...options, out: path.join(staging, id), main: 'bundle' });
      warnings.push(...report.warnings.map((w) => `${id}: ${w}`));
      problems.push(...report.problems.map((p) => ({ ...p, file: `${id}: ${p.file}` })));
      if (report.ok) ids.push(id);
    }
    if (problems.length > 0) return fail(problems, warnings);
    // Метка сборки нужна только следующей сборке плагина в этом же `out`; в поставке её нет и хеши её не считают.
    for (const id of ids) await fs.rm(path.join(staging, id, BUILD_MARKER), { force: true });
    await writeDelivery(staging);
    // Между проверкой и заменой `out` мог появиться чужой файл: проверка повторяется непосредственно перед заменой.
    const late = await outRefusal(out);
    if (late !== undefined) return fail([{ file: '.', message: late }], warnings);
    if (await exists(out)) await fs.rm(out, { recursive: true });
    await fs.rename(staging, out);
    return { ok: true, out, plugins: ids.sort(), problems: [], warnings };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function manifestId(home: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(path.join(home, 'manifest.json'), 'utf8'));
    return typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' && raw.id !== '' ? raw.id : undefined;
  } catch {
    return undefined;
  }
}
