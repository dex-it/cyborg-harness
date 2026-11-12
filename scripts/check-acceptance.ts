import fs from 'node:fs';
import path from 'node:path';
import { collect } from './check-docs-trace.ts';

// `node scripts/check-acceptance.ts [--write]` - связь «критерий приёмки -> тест» (#230, CI-шаг «ссылки в docs»).
// `check-docs-trace` держит «норма -> критерий»; этот скрипт держит следующее звено. У каждого критерия истории `ST-NNNN/k`, кроме отмеченного
// `[целевое поведение]`, обязана быть ровно одна из двух вещей: тест, чьё имя несёт ключ критерия (`ST-1002/4: ...`), либо строка-исключение с категорией
// и причиной в `docs/05-verification/acceptance.md`. Находка: критерий без того и другого; критерий и с тестом, и с исключением; целевое поведение с тестом
// или исключением (оно описывает то, чего ещё нет); ключ в имени теста, указывающий на несуществующий критерий; тест с ключом, отключённый `skip` или `todo`;
// строка исключения с неизвестным критерием, неизвестной категорией, пустой причиной или повтором. Таблица `acceptance-coverage.md` собирается этим же
// скриптом (`--write`), в режиме проверки она обязана совпадать с собранной. Без сети и без зависимостей.

export const EXCEPTIONS = 'docs/05-verification/acceptance.md';
export const MATRIX = 'docs/05-verification/acceptance-coverage.md';

/** Ключ критерия в имени теста: `ST-1002/4`. */
export const KEY = /ST-\d+\/\d+/g;
/** Имена, которые обход не заходит: сборки, зависимости, документы. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'docs', 'site']);

/** Закрытый перечень категорий исключений (решение владельца 2026-11-11: охват - ядро и адаптер Electron без окна). */
export const CATEGORIES = ['окно', 'инструменты автора', 'документы', 'замеры', 'этап 2', 'ручная'] as const;
/** Дефект ядра: критерий не выполняется, код в этой задаче не чинится. Номер задачи `#N` или `#?`, пока задача не заведена. */
const DEFECT = /^ручная, дефект (#\d+|#\?)$/;

export interface TestRef {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: 'test' | 'describe';
  /** `skip` или `todo` в имени вызова либо в литеральных параметрах. */
  readonly disabled: boolean;
  readonly keys: readonly string[];
}

export interface ExceptionRow {
  readonly key: string;
  readonly category: string;
  readonly reason: string;
  readonly line: number;
}

export interface Row {
  readonly key: string;
  readonly story: string;
  readonly number: number;
  readonly outcome: 'тест' | 'исключение' | 'целевое поведение' | 'нет';
  /** Файлы тестов с числом тестов на критерий, по алфавиту. */
  readonly tests: readonly { readonly file: string; readonly count: number }[];
  readonly category?: string;
}

export interface AcceptanceReport {
  readonly rows: readonly Row[];
  readonly titles: ReadonlyMap<string, string>;
  readonly tests: readonly TestRef[];
  readonly exceptions: readonly ExceptionRow[];
  readonly problems: readonly string[];
}

/** Сравнение по кодовым точкам: порядок в таблице не зависит от локали. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function testFiles(root: string, dir = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...testFiles(root, path.join(dir, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(toPosix(path.join(dir, entry.name)));
  }
  return found.sort(compare);
}

/** Строковый литерал с кавычкой в `start`: значение и позиция за закрывающей кавычкой; `undefined`, если литерал не закрыт. */
function literal(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text.charAt(start);
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      value += text.charAt(i + 1);
      i++;
    } else if (ch === quote) return { value, end: i + 1 };
    else if (ch === '\n' && quote !== '`') return undefined;
    else value += ch;
  }
  return undefined;
}

/** Вызовы `test`, `it`, `describe` с литеральным именем; закомментированные строки пропускаются. */
export function scanSource(file: string, text: string): TestRef[] {
  const refs: TestRef[] = [];
  const call = /(?<![\w.$])(describe|test|it)(?:\.(skip|todo|only))?\(\s*(?=['"`])/g;
  for (const m of text.matchAll(call)) {
    const kind = m[1] === 'describe' ? 'describe' : 'test';
    const start = m.index + m[0].length;
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index + 1))) continue;
    const name = literal(text, start);
    if (name === undefined) continue;
    const options = /^\s*,\s*\{([^}\n]*)\}/.exec(text.slice(name.end, name.end + 200))?.[1] ?? '';
    const disabled = m[2] === 'skip' || m[2] === 'todo' || /\b(skip|todo)\s*:\s*true\b/.test(options);
    refs.push({
      file,
      line: text.slice(0, m.index).split('\n').length,
      name: name.value,
      kind,
      disabled,
      keys: [...new Set(name.value.match(KEY) ?? [])],
    });
  }
  return refs;
}

/** Все тесты репозитория, чьё имя несёт хотя бы один ключ критерия. */
export function scanTests(root: string): TestRef[] {
  const refs: TestRef[] = [];
  for (const file of testFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
    refs.push(...scanSource(file, text).filter((r) => r.keys.length > 0));
  }
  return refs;
}

/** Строки таблицы исключений `| ST-NNNN/k | категория | причина |`; остальной текст файла - пояснения. */
export function readExceptions(text: string): { rows: ExceptionRow[]; problems: string[] } {
  const rows: ExceptionRow[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .forEach((line, index) => {
      if (!/^\|\s*ST-/.test(line)) return;
      const where = `${EXCEPTIONS}:${String(index + 1)}`;
      const cells = line
        .replace(/^\||\|\s*$/g, '')
        .split(/(?<!\\)\|/)
        .map((c) => c.trim());
      const [key = '', category = '', ...rest] = cells;
      const reason = rest.join('|').trim();
      if (cells.length < 3 || !/^ST-\d+\/\d+$/.test(key)) {
        problems.push(`${where}: строка не вида «| ST-NNNN/k | категория | причина |»`);
        return;
      }
      if (!(CATEGORIES as readonly string[]).includes(category) && !DEFECT.test(category)) problems.push(`${where}: ${key}: неизвестная категория «${category}» (${CATEGORIES.join(', ')}, «ручная, дефект #N»)`);
      if (reason.length < 10) problems.push(`${where}: ${key}: причина пуста или короче 10 знаков`);
      const first = seen.get(key);
      if (first !== undefined) problems.push(`${where}: ${key}: исключение повторяет строку ${String(first)}`);
      else seen.set(key, index + 1);
      rows.push({ key, category, reason, line: index + 1 });
    });
  return { rows, problems };
}

export function collectAcceptance(root: string): AcceptanceReport {
  const trace = collect(root);
  const tests = scanTests(root);
  const parsed = readExceptions(fs.existsSync(path.join(root, EXCEPTIONS)) ? fs.readFileSync(path.join(root, EXCEPTIONS), 'utf8') : '');
  const problems: string[] = [...parsed.problems];
  const known = new Map<string, { story: string; number: number; target: boolean }>();
  const titles = new Map<string, string>();
  for (const story of trace.stories) {
    titles.set(story.id, story.title);
    for (const c of story.criteria) known.set(`${story.id}/${String(c.number)}`, { story: story.id, number: c.number, target: c.target });
  }
  const byKey = new Map<string, TestRef[]>();
  for (const t of tests) {
    for (const key of t.keys) {
      if (!known.has(key)) {
        problems.push(`${t.file}:${String(t.line)}: ключ ${key} указывает на несуществующий критерий`);
        continue;
      }
      if (t.kind === 'describe') continue;
      if (t.disabled) {
        problems.push(`${t.file}:${String(t.line)}: тест с ключом ${key} отключён (skip или todo): ключ не засчитан`);
        continue;
      }
      byKey.set(key, [...(byKey.get(key) ?? []), t]);
    }
  }
  const exceptions = new Map<string, ExceptionRow>();
  for (const row of parsed.rows) {
    if (!known.has(row.key)) problems.push(`${EXCEPTIONS}:${String(row.line)}: ${row.key}: исключение указывает на несуществующий критерий`);
    else if (!exceptions.has(row.key)) exceptions.set(row.key, row);
  }
  const rows: Row[] = [];
  for (const [key, info] of known) {
    const refs = byKey.get(key) ?? [];
    const files = new Map<string, number>();
    for (const r of refs) files.set(r.file, (files.get(r.file) ?? 0) + 1);
    const tested = [...files].sort(([a], [b]) => compare(a, b)).map(([file, count]) => ({ file, count }));
    const exception = exceptions.get(key);
    const base = { key, story: info.story, number: info.number, tests: tested };
    if (info.target) {
      if (refs.length > 0) problems.push(`${key}: критерий на целевое поведение с тестом (${refs[0]?.file ?? ''}): снять метку [целевое поведение] или убрать ключ`);
      if (exception !== undefined) problems.push(`${EXCEPTIONS}:${String(exception.line)}: ${key}: исключение для критерия на целевое поведение не нужно`);
      rows.push({ ...base, outcome: 'целевое поведение' });
    } else if (refs.length > 0 && exception !== undefined) {
      problems.push(`${EXCEPTIONS}:${String(exception.line)}: ${key}: и тест с ключом (${refs[0]?.file ?? ''}), и исключение: оставить одно`);
      rows.push({ ...base, outcome: 'тест' });
    } else if (refs.length > 0) rows.push({ ...base, outcome: 'тест' });
    else if (exception !== undefined) rows.push({ ...base, outcome: 'исключение', category: exception.category });
    else {
      problems.push(`${key}: нет теста с ключом в имени и нет исключения в ${EXCEPTIONS}`);
      rows.push({ ...base, outcome: 'нет' });
    }
  }
  rows.sort((a, b) => (a.story === b.story ? a.number - b.number : compare(a.story, b.story)));
  return { rows, titles, tests, exceptions: parsed.rows, problems };
}

const HEAD = ['---', 'level: coverage', 'status: review', 'date: 2026-11-12', 'origin: derived', '---', ''].join('\n');

/** Категория исключения без номера дефекта: «ручная, дефект #12» -> «ручная, дефект». */
function bucket(category: string): string {
  return category.startsWith('ручная, дефект') ? 'ручная, дефект' : category;
}

/** Тело таблицы: без шапки, чтобы дата в шапке не участвовала в сверке. */
export function renderMatrix(report: AcceptanceReport): string {
  const count = (outcome: Row['outcome']): number => report.rows.filter((r) => r.outcome === outcome).length;
  const categories = new Map<string, number>();
  for (const r of report.rows) if (r.category !== undefined) categories.set(bucket(r.category), (categories.get(bucket(r.category)) ?? 0) + 1);
  const keyed = report.rows.filter((r) => r.outcome === 'тест').reduce((n, r) => n + r.tests.reduce((m, t) => m + t.count, 0), 0);
  const stories = new Set(report.rows.map((r) => r.story)).size;
  const out: string[] = [
    '# Покрытие критериев приёмки проверками',
    '',
    `Таблица собрана из критериев историй, имён тестов и \`acceptance.md\` командой \`npm run check:acceptance -- --write\`; руками не правится. \`npm run check:acceptance\` падает, если у критерия нет ни теста с ключом \`ST-NNNN/k\` в имени, ни исключения в [acceptance.md](acceptance.md), если есть и то и другое, если ключ указывает на несуществующий критерий или эта таблица расходится с собранной. Исход критерия: «тест» - в имени хотя бы одного включённого теста ключ критерия (запуск - \`npm run test:acceptance\`); «исключение» - категория из [acceptance.md](acceptance.md); «целевое поведение» - критерий на то, чего ещё нет, проверки не требует. В ячейке «Проверка» путь файла и число тестов с ключом.`,
    '',
    `Итог: историй ${String(stories)}, критериев ${String(report.rows.length)}: тест ${String(count('тест'))} (тестов с ключом ${String(keyed)}), исключение ${String(count('исключение'))}, целевое поведение ${String(count('целевое поведение'))}${count('нет') > 0 ? `, без исхода ${String(count('нет'))}` : ''}.`,
    '',
    `Исключения по категориям: ${[...categories].sort(([a], [b]) => compare(a, b)).map(([name, n]) => `${name} ${String(n)}`).join(', ') || 'нет'}.`,
    '',
  ];
  let story = '';
  for (const r of report.rows) {
    if (r.story !== story) {
      story = r.story;
      out.push(`## ${story} ${report.titles.get(story) ?? ''}`.trimEnd(), '', '| Критерий | Исход | Проверка |', '|---|---|---|');
    }
    const check = r.outcome === 'тест' ? r.tests.map((t) => `${t.file} (${String(t.count)})`).join(', ') : r.outcome === 'исключение' ? (r.category ?? '') : '';
    out.push(`| ${r.key} | ${r.outcome} | ${check} |`);
    const next = report.rows[report.rows.indexOf(r) + 1];
    if (next?.story !== story) out.push('');
  }
  return out.join('\n');
}

function splitHead(text: string): { head: string; body: string } {
  const m = /^---\n[\s\S]*?\n---\n\n?/.exec(text);
  return m ? { head: m[0].replace(/\n*$/, '\n\n'), body: text.slice(m[0].length) } : { head: '', body: text };
}

/** Разбор командной строки и печать отчёта; код выхода 1, если есть находки или таблица устарела. */
export function main(args: readonly string[], root: string): { code: number; out: string; err: string } {
  const report = collectAcceptance(root);
  const target = path.join(root, MATRIX);
  const body = renderMatrix(report);
  if (args.includes('--write')) {
    const head = fs.existsSync(target) ? splitHead(fs.readFileSync(target, 'utf8')).head : `${HEAD}\n`;
    fs.writeFileSync(target, `${head}${body}`);
    const note = report.problems.length > 0 ? `; находок: ${String(report.problems.length)}` : '';
    return { code: 0, out: `таблица записана: ${MATRIX}${note}\n`, err: '' };
  }
  if (report.problems.length > 0) return { code: 1, out: '', err: `находок: ${String(report.problems.length)}\n${report.problems.join('\n')}\n` };
  if (!fs.existsSync(target) || splitHead(fs.readFileSync(target, 'utf8')).body !== body) return { code: 1, out: '', err: `${MATRIX} расходится с собранной таблицей: npm run check:acceptance -- --write\n` };
  const count = (outcome: Row['outcome']): number => report.rows.filter((r) => r.outcome === outcome).length;
  const pending = report.exceptions.filter((e) => e.category.endsWith('#?')).length;
  const note = pending > 0 ? `; дефектов без номера задачи: ${String(pending)}` : '';
  return {
    code: 0,
    out: `приёмка в порядке: критериев ${String(report.rows.length)}: тест ${String(count('тест'))}, исключение ${String(count('исключение'))}, целевое поведение ${String(count('целевое поведение'))}${note}\n`,
    err: '',
  };
}

if (process.argv[1] === import.meta.filename) {
  const result = main(process.argv.slice(2), process.cwd());
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
