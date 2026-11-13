import fs from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { build as esbuild, type Message, type Metafile, type OutputFile } from 'esbuild';
import { checkPlugin, CHECKED_KEYS, ENTRY_FILES, isTestPath, type Problem } from '@cyborg-harness/core/plugin-check';
import { BUILD_MARKER, exists, inside, listFiles, realpathLoose, toPosix } from './fsx.ts';

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
  /**
   * Пакеты npm, код которых попал в бандл главной части (TR-14, У-42): имя, версия, сколько байт вклада. Пусто в режиме `source` и когда зависимостей нет.
   * Это перечень для ревью поставки и для `npm audit`, а не проверка содержимого пакетов.
   */
  readonly packages: readonly BundledPackage[];
}

export interface BundledPackage {
  readonly name: string;
  /** Версия из `package.json` пакета; `undefined`, если файла нет или в нём нет версии. */
  readonly version: string | undefined;
  /** Байт этого пакета в `index.mjs` (метафайл сборщика). */
  readonly bytes: number;
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

const errorCode = (error: unknown): unknown => (error instanceof Error && 'code' in error ? error.code : undefined);

/**
 * Можно ли занять `out` результатом: нет такого пути, пустой каталог или каталог, который раньше создала сама сборка (в нём метка BUILD_MARKER).
 * Любой другой каталог чужой, даже с manifest.json: это могут быть исходники соседнего плагина или `public/` веб-приложения. Текст отказа или undefined.
 */
async function outRefusal(out: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(out);
  } catch (error) {
    // Занять можно только то, чего нет: файл на месте --out (опечатка, путь архива pack) остаётся нетронутым.
    return errorCode(error) === 'ENOENT' ? undefined : `${out}: не каталог или не читается - укажите другой --out`;
  }
  if (names.length === 0 || names.includes(BUILD_MARKER)) return undefined;
  return `${out}: каталог не пуст и не результат сборки (нет метки ${BUILD_MARKER}) - укажите другой --out; результат сборки прежней версии инструмента удалите вручную`;
}

/** Результат встаёт на место `out` целиком: прежний результат (если был) убирается только после того, как новый собран и проверен. */
async function replaceOut(staging: string, out: string): Promise<string | undefined> {
  const refusal = await outRefusal(out);
  if (refusal !== undefined) return refusal;
  const previous = `${staging}.previous`;
  let moved = false;
  try {
    await fs.rename(out, previous);
    moved = true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(staging, out);
  } catch (error) {
    if (moved) await fs.rename(previous, out);
    throw error;
  }
  if (moved) await fs.rm(previous, { recursive: true, force: true });
  return undefined;
}

/**
 * Символические ссылки в `ui/`: ресурсы вида грузятся только из результата, и ссылка там не файл. Ссылка на файл внутри каталога плагина копируется
 * как обычный файл, остальные (за пределы каталога, на каталог, битые, на исходник `.ts`) - нарушение: молча терять ресурс нельзя.
 */
async function uiLinks(home: string): Promise<{ readonly all: ReadonlySet<string>; readonly copy: readonly string[]; readonly problems: readonly Problem[] }> {
  const all = new Set<string>();
  const copy: string[] = [];
  const problems: Problem[] = [];
  const found: string[] = [];
  // Сам ui/ - ссылка: fs.cp в режиме source перенёс бы её ссылкой, и сборка видов записала бы ui/*.js в её цель, мимо временного каталога.
  if ((await fs.lstat(path.join(home, 'ui')).catch(() => undefined))?.isSymbolicLink() === true) {
    return { all, copy, problems: [{ file: 'ui', message: 'символическая ссылка не поддерживается: ui/ ведёт на другой каталог; положите в каталог плагина сам ui/' }] };
  }
  await listFiles(path.join(home, 'ui'), (rel) => isTestPath(`ui/${rel}`), (rel) => found.push(`ui/${rel}`)).catch(() => []);
  for (const rel of found) {
    all.add(rel);
    const refuse = (why: string): number => problems.push({ file: rel, message: `символическая ссылка не поддерживается: ${why}; положите в ui/ сам файл` });
    let real: string;
    let isFile: boolean;
    try {
      real = await fs.realpath(path.join(home, rel));
      isFile = (await fs.stat(real)).isFile();
    } catch {
      refuse('цель не найдена');
      continue;
    }
    if (!inside(home, real)) refuse('цель лежит вне каталога плагина');
    else if (!isFile) refuse('цель не файл');
    else if (isSourceTs(rel)) refuse('ссылка на исходник .ts');
    else copy.push(rel);
  }
  return { all, copy, problems };
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
        // Шрифт из импорта (значки Monaco, PL-05) кладётся рядом с модулем вида: фрейм грузит ресурсы только со своего origin.
        : { platform: 'browser', format: 'esm', target: VIEW_TARGET, loader: { '.ttf': 'file' } }),
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

/** Имя пакета и каталог его корня по пути входа метафайла (`node_modules/@acme/dep/lib/x.js`); берётся последний `node_modules` пути. */
function packageOfInput(input: string): { name: string; root: string } | undefined {
  const parts = toPosix(input).split('/');
  const at = parts.lastIndexOf('node_modules');
  const first = parts[at + 1];
  if (at < 0 || first === undefined) return undefined;
  const scoped = first.startsWith('@');
  const second = parts[at + 2];
  if (scoped && second === undefined) return undefined;
  const length = scoped ? 2 : 1;
  return { name: parts.slice(at + 1, at + 1 + length).join('/'), root: parts.slice(0, at + 1 + length).join('/') };
}

/** Пакеты npm в бандле главной части по метафайлу: что именно и какой версии уйдёт в поставку вместе с плагином (TR-14). */
async function bundledPackages(meta: readonly Metafile[], home: string): Promise<BundledPackage[]> {
  const found = new Map<string, { name: string; root: string; bytes: number }>();
  for (const m of meta) {
    for (const output of Object.values(m.outputs)) {
      for (const [input, info] of Object.entries(output.inputs)) {
        const pkg = packageOfInput(input);
        if (pkg === undefined) continue;
        const key = pkg.root;
        const have = found.get(key);
        found.set(key, { ...pkg, bytes: (have?.bytes ?? 0) + info.bytesInOutput });
      }
    }
  }
  const list: BundledPackage[] = [];
  for (const { name, root, bytes } of found.values()) {
    let version: string | undefined;
    try {
      const raw: unknown = JSON.parse(await fs.readFile(path.resolve(home, root, 'package.json'), 'utf8'));
      version = typeof raw === 'object' && raw !== null && 'version' in raw && typeof raw.version === 'string' ? raw.version : undefined;
    } catch {
      version = undefined;
    }
    list.push({ name, version, bytes });
  }
  return list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.version ?? '') < (b.version ?? '') ? -1 : 1));
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
 * `bundle`: проверка исходников -> сборка в памяти (главная часть + виды) -> запись во временный каталог рядом с `out` -> проверка результата там -> замена `out`.
 * Отказ на любом шаге не трогает `out`: прежний результат остаётся, временный каталог убирается. Занять `out` можно, только если его нет, он пуст
 * или в нём метка, оставленная прежней сборкой (`BUILD_MARKER`): чужой каталог, даже с manifest.json, не стирается.
 * `source`: исходники копируются как есть без `ui/*.ts`, виды собираются.
 */
export async function buildPlugin(dir: string, options: BuildOptions = {}): Promise<BuildReport> {
  const mode = options.main ?? 'bundle';
  const abs = path.resolve(dir);
  const fail = (problems: Problem[], extra: Partial<BuildReport> = {}): BuildReport => ({ ok: false, dir: abs, out: path.resolve(options.out ?? path.join(abs, 'dist')), problems, warnings: [], files: [], packages: [], ...extra });
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
  // fs.cp не копирует каталог в собственный подкаталог (ERR_FS_CP_EINVAL) и бросил бы уже после очистки out.
  if (mode === 'source' && ignore.length > 0) return fail([{ file: '.', message: `--out ${out}: в режиме source результат не может лежать внутри каталога плагина` }], { dir: home, out });

  const occupied = await outRefusal(out);
  if (occupied !== undefined) return fail([{ file: '.', message: occupied }], { dir: home, out });

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

  // Собирается рядом с `out` (одна файловая система, rename целиком); имя скрытое, чтобы проверка исходников, если `out` внутри плагина, его не читала.
  const staging = path.join(path.dirname(out), `.${path.basename(out)}.build-${String(process.pid)}-${Date.now().toString(36)}`);
  const links = await uiLinks(home);
  const compiled: Compiled = { files: [], warnings: [], problems: [...links.problems], meta: [] };
  let viewSources: string[];
  let copied: string[];
  if (mode === 'bundle') {
    const entry = (await Promise.all(ENTRY_FILES.map(async (f) => ((await exists(path.join(home, f))) ? f : undefined)))).find((f) => f !== undefined);
    if (entry === undefined) return fail([{ file: ENTRY_FILES.join('|'), message: 'нет точки входа главной части' }], { dir: home, out, id });
    await compile(home, entry, path.join(staging, 'index.mjs'), 'main', compiled);
    const fromManifest = await manifestRefs(home, refs);
    viewSources = [...new Set([...(await uiEntries(home)), ...fromManifest.views])].sort();
    // Всё из ui/, что не исходник, едет как есть: стили и ресурсы вида грузятся только со своего origin.
    const ui = (await listFiles(path.join(home, 'ui')).catch(() => [])).map((f) => `ui/${f}`).filter((f) => !TS_MODULE.test(f) && !f.endsWith('.d.ts') && !isTestPath(f));
    copied = [...new Set(['manifest.json', ...fromManifest.copy, ...ui, ...links.copy])].sort();
  } else {
    viewSources = await uiEntries(home);
    copied = [...links.copy];
  }
  for (const source of viewSources) await compile(home, source, path.join(staging, jsName(source)), 'view', compiled);
  const problems = [...compiled.problems, ...compiled.meta.flatMap((m) => bundleProblems(m, home))];
  if (problems.length > 0) return fail(problems, { dir: home, out, id, warnings: compiled.warnings });

  try {
    await fs.mkdir(staging, { recursive: true });
    // Сборка выигрывает у одноимённого готового файла: рядом с ui/x.ts лежал бы старый ui/x.js.
    const built = new Set(compiled.files.map((f) => toPosix(path.relative(staging, f.path))));
    if (mode === 'source') {
      const skipUiTs = (rel: string): boolean => /^ui\/[^/]+\.ts$/.test(toPosix(rel));
      await fs.cp(home, staging, { recursive: true, filter: (from) => !skipUiTs(path.relative(home, from)) && !links.all.has(toPosix(path.relative(home, from))) });
    }
    for (const rel of copied) if (!built.has(rel)) await copyFile(home, staging, rel);
    await writeOutputs(compiled.files);

    if (mode === 'bundle') {
      // Вторая проверка - на результате, а не на исходниках: в нём нет ничего, кроме того, что уйдёт в поставку. Идёт до замены `out`.
      const result = await checkPlugin(staging, options.apiVersion === undefined ? {} : { apiVersion: options.apiVersion });
      if (!result.ok) {
        const label = inside(home, out) ? toPosix(path.relative(home, out)) : path.basename(out);
        return fail(result.problems.map((p) => ({ ...p, file: `${label}/${p.file}` })), { dir: home, out, id, warnings: compiled.warnings });
      }
    }
    await fs.writeFile(path.join(staging, BUILD_MARKER), 'cyborg-plugin build: этот каталог создала сборка, следующая может его заменить\n');
    const files = await listFiles(staging);
    const refusal = await replaceOut(staging, out);
    if (refusal !== undefined) return fail([{ file: '.', message: refusal }], { dir: home, out, id });
    return { ok: true, dir: home, out, id, problems: [], warnings: compiled.warnings, files, packages: await bundledPackages(compiled.meta, home) };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
