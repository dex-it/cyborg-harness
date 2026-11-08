import fs from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { build as esbuild, type Message, type Metafile, type OutputFile } from 'esbuild';
import { checkPlugin, CHECKED_KEYS, ENTRY_FILES, isTestPath, type Problem } from '@cyborg-harness/core/plugin-check';
import { exists, inside, listFiles, realpathLoose, toPosix } from './fsx.ts';

// P-06: сборка плагина. Две формы главной части: `bundle` - один файл index.mjs с npm-зависимостями внутри (формат поставки, SAD 6.1),
// `source` - исходники как есть (стенд: его плагины без зависимостей, а загрузку `.ts` стенд проверяет сам). Виды `ui/*.ts` собираются одинаково.

export interface BuildOptions {
  /** Куда класть результат; по умолчанию `<каталог плагина>/dist`. */
  readonly out?: string;
  /** `bundle` (по умолчанию) или `source`. */
  readonly main?: 'bundle' | 'source';
  /** Проверить исходники до сборки и результат после; для `bundle` проверка обязательна (манифест нужен сборке). По умолчанию включена. */
  readonly check?: boolean;
  readonly apiVersion?: string;
  readonly declarations?: readonly string[];
  readonly declarationPackages?: readonly string[];
}

export interface BuildReport {
  readonly ok: boolean;
  /** Каталог плагина, как он разобран (абсолютный путь); нет, если каталога нет. */
  readonly dir: string;
  /** Каталог результата (абсолютный путь). */
  readonly out: string;
  readonly id?: string | undefined;
  readonly problems: readonly Problem[];
  /** Предупреждения сборщика строками `файл:строка: текст`; сборку не останавливают. */
  readonly warnings: readonly string[];
  /** Файлы результата, пути от `out` через `/`; пусто, если сборка отказала до записи. */
  readonly files: readonly string[];
}

/** Версия сборщика: цель node - Node из Electron 45, цель вида - Chromium оттуда же (как было в build.mjs стенда). */
const NODE_TARGET = 'node24';
const VIEW_TARGET = 'chrome130';

const TS_MODULE = /\.(?:m)?ts$/;
const isSourceTs = (rel: string): boolean => TS_MODULE.test(rel) && !rel.endsWith('.d.ts') && !isTestPath(rel);

function fromMessage(message: Message, home: string): Problem {
  const file = message.location?.file;
  return {
    file: file === undefined ? '.' : toPosix(path.relative(home, path.resolve(home, file))),
    ...(message.location ? { line: message.location.line } : {}),
    message: message.text,
  };
}

const asMessages = (error: unknown): Message[] | undefined => {
  if (typeof error !== 'object' || error === null || !('errors' in error) || !Array.isArray(error.errors)) return undefined;
  return error.errors as Message[];
};

/** Файлы `ui/*.ts` первого уровня: каждый - отдельный модуль вида (как собирал build.mjs стенда). Имя результата - от каталога плагина. */
async function uiEntries(home: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(home, 'ui'), { withFileTypes: true })).filter((d) => d.isFile() && isSourceTs(d.name)).map((d) => `ui/${d.name}`).sort();
  } catch {
    return [];
  }
}

const jsName = (ts: string): string => ts.replace(TS_MODULE, '.js');

/** Каталог результата: создаётся пустым. Чужой непустой каталог не стирается: у результата сборки есть manifest.json. */
async function prepareOut(out: string): Promise<string | undefined> {
  let names: string[] = [];
  try {
    names = await fs.readdir(out);
  } catch {
    // каталога нет - создадим
  }
  if (names.length > 0 && !names.includes('manifest.json')) return `${out}: каталог не пуст и не похож на результат сборки (нет manifest.json) - укажите другой --out`;
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  return undefined;
}

async function writeOutputs(files: readonly OutputFile[]): Promise<void> {
  for (const file of files) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.contents);
  }
}

interface Compiled {
  readonly files: OutputFile[];
  readonly warnings: string[];
  readonly problems: Problem[];
  readonly meta: Metafile[];
}

/** Вид или главная часть через esbuild без записи на диск: ничего не пишется, пока не собрано всё. */
async function compile(home: string, entry: string, outfile: string, kind: 'main' | 'view', into: Compiled): Promise<void> {
  try {
    const result = await esbuild({
      absWorkingDir: home,
      entryPoints: [path.join(home, entry)],
      outfile,
      bundle: true,
      sourcemap: true,
      write: false,
      metafile: kind === 'main',
      logLevel: 'silent',
      ...(kind === 'main'
        ? { platform: 'node', format: 'esm', target: NODE_TARGET, external: ['electron', 'electron/*'] }
        : { platform: 'browser', format: 'esm', target: VIEW_TARGET }),
    } as const);
    into.files.push(...result.outputFiles);
    into.warnings.push(...result.warnings.map((w) => `${fromMessage(w, home).file}:${String(w.location?.line ?? 0)}: ${w.text}`));
    if (result.metafile !== undefined) into.meta.push(result.metafile);
  } catch (error) {
    const messages = asMessages(error);
    if (messages === undefined) throw error;
    into.problems.push(...messages.map((m) => fromMessage(m, home)));
  }
}

/**
 * Запрещённое в бандле главной части, что подтянули зависимости: источник проверок на исходниках видит только прямые импорты,
 * а `node:fs` внутри `node_modules/dep` виден сборщику. Метафайл называет, кто именно импортирует.
 */
function bundleProblems(meta: Metafile, home: string): Problem[] {
  const found: Problem[] = [];
  for (const [input, info] of Object.entries(meta.inputs)) {
    for (const imported of info.imports) {
      if (!imported.external) continue;
      if (isBuiltin(imported.path) || imported.path === 'electron' || imported.path.startsWith('electron/')) {
        found.push({ file: toPosix(path.relative(home, path.resolve(home, input))), message: `'${imported.path}' попал в бандл главной части: в нём нет ни node:*, ни electron` });
      }
    }
  }
  return found;
}

/** Ссылки манифеста на файлы: что нужно положить в результат. Модуль `.js` без одноимённого исходника копируется, с исходником - собирается. */
async function manifestRefs(home: string, refs: readonly string[]): Promise<{ views: string[]; copy: string[] }> {
  const views: string[] = [];
  const copy: string[] = [];
  for (const ref of refs) {
    const rel = toPosix(path.normalize(ref));
    const candidates = rel.endsWith('.js') ? [`${rel.slice(0, -3)}.ts`, `${rel.slice(0, -3)}.mts`] : [];
    const source = (await Promise.all(candidates.map(async (c) => ((await exists(path.join(home, c))) && isSourceTs(c) ? c : undefined)))).find((c) => c !== undefined);
    if (source === undefined) copy.push(rel);
    else views.push(source);
  }
  return { views, copy };
}

async function copyFile(home: string, out: string, rel: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(out, rel)), { recursive: true });
  await fs.copyFile(path.join(home, rel), path.join(out, rel));
}

/**
 * Собирает плагин из `dir` в каталог `out`.
 * `bundle`: проверка исходников -> сборка в памяти (главная часть + виды) -> запись -> проверка результата. Отказ до записи не трогает `out`.
 * `source`: исходники копируются как есть без `ui/*.ts`, виды собираются.
 */
export async function buildPlugin(dir: string, options: BuildOptions = {}): Promise<BuildReport> {
  const mode = options.main ?? 'bundle';
  const abs = path.resolve(dir);
  const fail = (problems: Problem[], extra: Partial<BuildReport> = {}): BuildReport => ({ ok: false, dir: abs, out: path.resolve(options.out ?? path.join(abs, 'dist')), problems, warnings: [], files: [], ...extra });
  let home: string;
  try {
    home = await fs.realpath(abs);
    if (!(await fs.stat(home)).isDirectory()) throw new Error('не каталог');
  } catch {
    return fail([{ file: '.', message: 'каталога нет' }]);
  }
  const out = await realpathLoose(options.out ?? path.join(home, 'dist'));
  if (out === home || inside(out, home)) return fail([{ file: '.', message: `--out ${out}: результат не может совпадать с каталогом плагина или содержать его` }], { dir: home, out });
  const ignore = inside(home, out) ? [path.relative(home, out)] : [];

  let id: string | undefined;
  let refs: readonly string[] = [];
  if (mode === 'bundle' || options.check !== false) {
    const report = await checkPlugin(home, {
      bundled: mode === 'bundle',
      ignore,
      ...(options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion }),
      ...(options.declarations === undefined ? {} : { declarations: options.declarations }),
      ...(options.declarationPackages === undefined ? {} : { declarationPackages: options.declarationPackages }),
    });
    const manifest = report.manifest;
    if (!report.ok || !manifest) return fail([...report.problems], { dir: home, out, id: report.id });
    id = report.id;
    refs = Object.values(CHECKED_KEYS).flatMap((reader) => reader(manifest).map((r) => r.file));
  }

  const compiled: Compiled = { files: [], warnings: [], problems: [], meta: [] };
  let viewSources: string[];
  let copied: string[];
  if (mode === 'bundle') {
    const entry = (await Promise.all(ENTRY_FILES.map(async (f) => ((await exists(path.join(home, f))) ? f : undefined)))).find((f) => f !== undefined);
    if (entry === undefined) return fail([{ file: ENTRY_FILES.join('|'), message: 'нет точки входа главной части' }], { dir: home, out, id });
    await compile(home, entry, path.join(out, 'index.mjs'), 'main', compiled);
    const fromManifest = await manifestRefs(home, refs);
    viewSources = [...new Set([...(await uiEntries(home)), ...fromManifest.views])].sort();
    // Всё из ui/, что не исходник, едет как есть: стили и ресурсы вида грузятся только со своего origin.
    const ui = (await listFiles(path.join(home, 'ui')).catch(() => [])).map((f) => `ui/${f}`).filter((f) => !TS_MODULE.test(f) && !f.endsWith('.d.ts') && !isTestPath(f));
    copied = [...new Set(['manifest.json', ...fromManifest.copy, ...ui])].sort();
  } else {
    viewSources = await uiEntries(home);
    copied = [];
  }
  for (const source of viewSources) await compile(home, source, path.join(out, jsName(source)), 'view', compiled);
  const problems = [...compiled.problems, ...compiled.meta.flatMap((m) => bundleProblems(m, home))];
  if (problems.length > 0) return fail(problems, { dir: home, out, id, warnings: compiled.warnings });

  const refusal = await prepareOut(out);
  if (refusal !== undefined) return fail([{ file: '.', message: refusal }], { dir: home, out, id });
  // Сборка выигрывает у одноимённого готового файла: рядом с ui/x.ts лежал бы старый ui/x.js.
  const built = new Set(compiled.files.map((f) => toPosix(path.relative(out, f.path))));
  if (mode === 'source') {
    const skipUiTs = (rel: string): boolean => /^ui\/[^/]+\.ts$/.test(toPosix(rel));
    await fs.cp(home, out, { recursive: true, filter: (from) => !skipUiTs(path.relative(home, from)) && !(ignore.length > 0 && inside(path.join(home, ignore[0] ?? ''), from)) });
  } else {
    for (const rel of copied) if (!built.has(rel)) await copyFile(home, out, rel);
  }
  await writeOutputs(compiled.files);

  const files = await listFiles(out);
  if (mode === 'bundle') {
    // Вторая проверка - на результате, а не на исходниках: в нём нет ничего, кроме того, что уйдёт в поставку.
    const result = await checkPlugin(out, options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion });
    if (!result.ok) {
      const label = inside(home, out) ? toPosix(path.relative(home, out)) : path.basename(out);
      return fail(result.problems.map((p) => ({ ...p, file: `${label}/${p.file}` })), { dir: home, out, id, warnings: compiled.warnings, files });
    }
  }
  return { ok: true, dir: home, out, id, problems: [], warnings: compiled.warnings, files };
}
