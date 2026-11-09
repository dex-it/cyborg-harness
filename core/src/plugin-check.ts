import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { PLUGIN_API_VERSION } from './api-version.ts';
import { parseManifest, type PluginManifest } from './manifest.ts';
import { describePermissions } from './permissions.ts';
import { COMPUTED, declarationProblems, UNREADABLE, usesOf } from './plugin-scan.ts';
import { satisfies } from './semver.ts';

// SAD §6.1, дисциплина этапа 1: плагин импортирует только @cyborg-harness/contracts и свои модули. Без Compartment хост не мешает обойти шлюз, поэтому правило держит статика.
// Проверка работает на каталоге плагина, а не на каталогах репозитория: её запускает автор вне репозитория и сборка плагина (P-06).

const CONTRACTS = '@cyborg-harness/contracts';
/** Точка входа главной части: первый найденный файл; тот же порядок у загрузки плагинов стенда. */
export const ENTRY_FILES: readonly string[] = ['index.mjs', 'index.js', 'index.ts'];
const TEST_DIRS = new Set(['test', 'tests', '__tests__']);

/** Нарушение: `file` - путь от каталога плагина, `line` - только у разбора исходников. */
export interface Problem {
  readonly file: string;
  readonly line?: number | undefined;
  readonly message: string;
}

/** Правила разбора импортов одного плагина. */
export interface ImportRules {
  /** Каталог плагина. */
  readonly home: string;
  /** Файлы пакета объявлений рядом с плагином (абсолютные пути): из них допустим только `import type`. */
  readonly declarations: readonly string[];
  /** Пакеты объявлений по имени (`@acme/contracts`): только `import type`. */
  readonly packages: readonly string[];
  /** Главную часть соберёт в один файл сборщик плагинов (P-06): npm-пакеты допустимы, их код уйдёт внутрь. `node:*`, `electron` и пакеты объявлений - по-прежнему нет. */
  readonly bundled?: boolean;
}

export interface CheckOptions {
  /** Версия API, под которую проверяется `engines.cyborg`; по умолчанию версия этого ядра. */
  readonly apiVersion?: string;
  /** Файлы пакета объявлений (пути от текущего каталога): из них допустим только `import type`, и в них не должно быть кода. */
  readonly declarations?: readonly string[];
  /** Имена пакетов объявлений, например `@acme/contracts`: только `import type`. */
  readonly declarationPackages?: readonly string[];
  /** Главную часть соберут в один файл (`cyborg-plugin build`): npm-пакеты в ней допустимы. Без флага плагин грузится как есть, и пакетов в главной части нет. */
  readonly bundled?: boolean;
  /** Каталоги плагина (пути вниз от его корня), которые не читаются как исходники: например, результат сборки. */
  readonly ignore?: readonly string[];
}

export interface CheckReport {
  /** Каталог плагина, как он разобран (абсолютный путь). */
  readonly dir: string;
  /** Нарушений нет. */
  readonly ok: boolean;
  readonly id?: string | undefined;
  /** Разобранный манифест; нет, если в нём ошибки. */
  readonly manifest?: PluginManifest | undefined;
  /** Права словами, теми же строками, что в окне «Плагины Cyborg». */
  readonly permissions: readonly string[];
  readonly problems: readonly Problem[];
  /** Сколько исходников прошло правило импортов. */
  readonly files: number;
}

/** Ссылка манифеста на файл внутри каталога плагина. */
export interface FileRef {
  readonly field: string;
  readonly file: string;
}

const none = (): FileRef[] => [];

/**
 * Для каждого ключа верхнего уровня манифеста: какие файлы каталога он называет. Новый ключ `parseManifest` без записи здесь не проходит тест
 * (`core/test/plugin-check.test.ts`): ссылка на отсутствующий файл не должна пройти проверку молча.
 * Порядок записей - порядок нарушений в отчёте.
 */
export const CHECKED_KEYS: Readonly<Record<string, (manifest: PluginManifest) => FileRef[]>> = {
  ui: (m) => [...Object.entries(m.ui?.views ?? {}).map(([name, file]) => ({ field: `ui.views.${name}`, file })), ...(m.ui?.overlay === undefined ? [] : [{ field: 'ui.overlay', file: m.ui.overlay }])],
  config: (m) => (m.config?.schema === undefined ? [] : [{ field: 'config.schema', file: m.config.schema }]),
  state: (m) => (m.state?.schema === undefined ? [] : [{ field: 'state.schema', file: m.state.schema }]),
  $schema: none,
  id: none,
  version: none,
  engines: none,
  provides: none,
  requires: none,
  optional: none,
  consumes: none,
  commands: none,
  keybindings: none,
  permissions: none,
  documents: none,
  host: none,
  activation: none,
  lock: none,
};

const toPosix = (p: string) => p.split(path.sep).join('/');
const inside = (dir: string, target: string) => target === dir || target.startsWith(dir + path.sep);
/** Путь без расширения исходника: `../contracts.js` в импорте называет `contracts.ts` рядом. */
const stem = (p: string) => p.replace(/\.(?:m|c)?[tj]s$/, '');

/**
 * Реальный путь, как его видит загрузчик node: ссылки раскрыты. Если пути ещё нет (`./x.js` при `x.ts` на диске), раскрывается ближайший существующий предок.
 * Сравнение «внутри каталога плагина» по буквальному пути пропустило бы ссылку наружу.
 */
function realish(p: string): string {
  const tail: string[] = [];
  for (let cur = path.resolve(p); ; cur = path.dirname(cur)) {
    try {
      return path.join(realpathSync(cur), ...tail);
    } catch {
      if (path.dirname(cur) === cur) return path.resolve(p);
      tail.unshift(path.basename(cur));
    }
  }
}

/** Тесты и вспомогательные файлы к ним: в поставку не идут, и правило импортов к ним не применяется. */
export function isTestPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  return parts.some((p) => TEST_DIRS.has(p)) || /\.(?:test|spec)\.[^.]+$/.test(parts.at(-1) ?? '');
}

/** Нарушения правила импортов в файле плагина `file` из каталога `rules.home`. */
export function importProblems(file: string, text: string, rules: ImportRules): Problem[] {
  const found: Problem[] = [];
  const rel = toPosix(path.relative(rules.home, file));
  // Node грузит модуль по реальному пути: относительные импорты считаются от настоящего места файла, а «внутри плагина» - по реальному каталогу.
  const home = realish(rules.home);
  const from = path.dirname(realish(file));
  // Вид - браузерный бандл во фрейме без Node (SAD §3.8): пакеты вроде xterm шлюз не обходят, а встроенные модули и electron - да.
  const view = inside(path.join(rules.home, 'ui'), file);
  const declarations = rules.declarations.map((d) => stem(path.resolve(d)));
  for (const use of usesOf(text)) {
    const report = (message: string) => found.push({ file: rel, line: use.line, message });
    const quoted = `'${use.spec}'`;
    if (use.spec === UNREADABLE) {
      report('оператор import не разобран: файл с ошибкой синтаксиса проверить нельзя');
      continue;
    }
    if (use.spec === CONTRACTS) continue;
    const relative = use.spec.startsWith('.');
    const npm = !relative && !isBuiltin(use.spec) && use.spec !== 'electron' && !use.spec.startsWith('electron/');
    // Вид - всегда бандл; главная часть - если её собирают. Пакет объявлений в бандл не уходит: он общий и только типы.
    if (npm && (view || (rules.bundled === true && !rules.packages.includes(use.spec) && use.spec !== COMPUTED))) continue;
    if (!relative) {
      if (use.spec === COMPUTED) report('вычисляемый путь: статика не видит, какой модуль загрузится');
      else if (rules.packages.includes(use.spec)) {
        if (!use.typeOnly) report(`${quoted}: пакет объявлений - только import type`);
      } else if (rules.bundled === true && !view) report(`${quoted}: в бандле главной части нет ни node:*, ни electron`);
      else report(`${quoted}: только ${CONTRACTS} и свои модули${view ? ' (вид: без node:* и electron)' : ''}`);
      continue;
    }
    const target = path.resolve(from, use.spec);
    if (inside(home, target) && inside(home, realish(target))) {
      if (isTestPath(path.relative(home, target))) report(`${quoted}: тестовый модуль в коде плагина`);
    } else if (inside(home, target)) {
      report(`${quoted}: ведёт за пределы каталога плагина (символическая ссылка)`);
    } else if (declarations.includes(stem(realish(target)))) {
      if (!use.typeOnly) report(`${quoted}: пакет объявлений - только import type`);
    } else report(`${quoted}: модуль вне каталога плагина`);
  }
  return found;
}

/** В пакете объявлений нет кода: иначе через него плагин получил бы общий модуль под видом типов. `file` попадает в отчёт как есть. */
export function checkDeclarations(file: string, text: string): Problem[] {
  return declarationProblems(text, CONTRACTS).map((line) => ({ file, line, message: `в пакете объявлений только типы и declare module '${CONTRACTS}'` }));
}

export function formatProblem(p: Problem): string {
  return `${p.file}${p.line === undefined ? '' : `:${String(p.line)}`}: ${p.message}`;
}

/**
 * Исходники плагина: без `node_modules`, скрытых каталогов, тестов и `.d.ts`; порядок не зависит от ОС. `ignore` - каталоги, которые не обходятся (результат прежней сборки).
 * Ссылки раскрываются: цель вне каталога плагина - нарушение `outside` (загрузчик возьмёт файл оттуда, а проверка его не видит);
 * каталог внутри плагина обходится один раз (по реальному пути), поэтому цикл ссылок не зацикливает обход.
 */
async function sources(home: string, ignore: ReadonlySet<string>, unreadable: (path: string, error: unknown, what: string) => void, outside: (full: string) => void): Promise<string[]> {
  const out: string[] = [];
  const seenDirs = new Set<string>([home]);
  const seenFiles = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      unreadable(dir, error, 'каталог');
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      let directory = entry.isDirectory();
      let real = full;
      if (entry.isSymbolicLink()) {
        try {
          real = await fs.realpath(full);
          directory = (await fs.stat(real)).isDirectory();
        } catch (error) {
          // Битая ссылка: Node её не загрузит, но молча пропускать нельзя.
          if (directory || /\.(?:m|c)?[tj]s$/.test(entry.name)) unreadable(full, error, 'ссылка');
          continue;
        }
        if (!inside(home, real)) {
          if (directory ? !entry.name.startsWith('.') && entry.name !== 'node_modules' && !isTestPath(entry.name) : /\.(?:m|c)?[tj]s$/.test(entry.name) && !isTestPath(entry.name)) outside(full);
          continue;
        }
      }
      if (directory) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || isTestPath(entry.name) || ignore.has(full) || seenDirs.has(real)) continue;
        seenDirs.add(real);
        await walk(full);
      } else if (/\.(?:m|c)?[tj]s$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !isTestPath(entry.name) && !seenFiles.has(real)) {
        seenFiles.add(real);
        out.push(full);
      }
    }
  };
  await walk(home);
  return out;
}

const errno = (error: unknown) => (error instanceof Error && 'code' in error ? String(error.code) : undefined);

/** Файл из манифеста: до сборки модуль вида лежит как `.ts`, поэтому для `./x.js` годится и `./x.ts`. */
async function locate(root: string, ref: string): Promise<'ok' | 'missing' | 'outside'> {
  const candidates = ref.endsWith('.js') ? [ref, `${ref.slice(0, -3)}.ts`, `${ref.slice(0, -3)}.mts`] : [ref];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(path.join(root, candidate));
      if (!inside(root, real)) return 'outside';
      if ((await fs.stat(real)).isFile()) return 'ok';
    } catch {
      // файла нет - пробуем следующую запись
    }
  }
  return 'missing';
}

/** Читает манифест; причина, если он не прочитан. */
async function readManifest(root: string): Promise<{ raw: unknown } | { problem: string }> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  } catch (error) {
    return { problem: errno(error) === 'ENOENT' ? 'файла нет' : `не прочитан - ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { raw: JSON.parse(text) as unknown };
  } catch (error) {
    return { problem: `не JSON - ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Проверка каталога плагина без запуска его кода: манифест (`parseManifest` и версия API), точка входа, файлы из манифеста, правило импортов по всем исходникам.
 * Все нарушения собираются сразу; причины читаются без запуска.
 */
export async function checkPlugin(dir: string, options: CheckOptions = {}): Promise<CheckReport> {
  const apiVersion = options.apiVersion ?? PLUGIN_API_VERSION;
  const problems: Problem[] = [];
  const at = (file: string, message: string, line?: number) => problems.push({ file, message, line });
  const abs = path.resolve(dir);
  let root: string;
  try {
    root = await fs.realpath(abs);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('не каталог');
  } catch {
    at('.', 'каталога нет');
    return { dir: abs, ok: false, permissions: [], problems, files: 0 };
  }

  let manifest: PluginManifest | undefined;
  let id: string | undefined;
  const read = await readManifest(root);
  if ('problem' in read) at('manifest.json', read.problem);
  else {
    const parsed = parseManifest(read.raw, apiVersion);
    if (parsed.ok) {
      manifest = parsed.manifest;
      id = manifest.id;
      // Манифест без ошибок, но под другой API: разбор этого не видит, загрузчик отвергнет плагин той же причиной.
      if (!satisfies(apiVersion, manifest.engines.cyborg)) {
        at('manifest.json', `engines.cyborg: нужен API Cyborg ${manifest.engines.cyborg}, есть ${apiVersion}`);
      }
    } else {
      id = parsed.id;
      for (const error of parsed.errors) at('manifest.json', error);
    }
  }

  if (manifest) {
    for (const reader of Object.values(CHECKED_KEYS)) {
      for (const ref of reader(manifest)) {
        const state = await locate(root, ref.file);
        if (state === 'missing') at('manifest.json', `${ref.field}: файла ${ref.file} нет`);
        else if (state === 'outside') at('manifest.json', `${ref.field}: ${ref.file} ведёт за пределы каталога плагина`);
      }
    }
  }

  const hasEntry = (await Promise.all(ENTRY_FILES.map((f) => fs.stat(path.join(root, f)).then((s) => s.isFile(), () => false)))).some(Boolean);
  if (!hasEntry) at(ENTRY_FILES.join('|'),'нет точки входа главной части');

  // Пути через realpath, как корень плагина: иначе `/var` и `/private/var` на macOS дали бы разные пути одного файла.
  const declarations = await Promise.all((options.declarations ?? []).map((d) => fs.realpath(d).catch(() => path.resolve(d))));
  const rules: ImportRules = { home: root, declarations, packages: options.declarationPackages ?? [], bundled: options.bundled === true };
  // Только вниз от корня: `../x` и абсолютный путь ничего не скрывают.
  const ignore = new Set((options.ignore ?? []).filter((d) => !path.isAbsolute(d)).map((d) => path.resolve(root, d)).filter((d) => d !== root && inside(root, d)));
  const files = await sources(
    root,
    ignore,
    (d, error, what) => at(toPosix(path.relative(root, d)) || '.', `${what} не прочитан${what === 'ссылка' ? 'а' : ''} - ${error instanceof Error ? error.message : String(error)}`),
    (full) => at(toPosix(path.relative(root, full)), 'ссылка ведёт за пределы каталога плагина'),
  );
  for (const file of files) {
    try {
      problems.push(...importProblems(file, await fs.readFile(file, 'utf8'), rules));
    } catch (error) {
      at(toPosix(path.relative(root, file)), `не прочитан - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const file of rules.declarations) {
    const name = toPosix(path.relative(root, file));
    try {
      problems.push(...checkDeclarations(name, await fs.readFile(file, 'utf8')));
    } catch (error) {
      at(name, `не прочитан - ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { dir: root, ok: problems.length === 0, id, manifest, permissions: manifest ? describePermissions(manifest.permissions) : [], problems, files: files.length };
}
