import fs from 'node:fs';
import path from 'node:path';
import { collect, type Criterion } from './check-docs-trace.ts';

// Разбор историй и его находки - из check-docs-trace.ts: номер критерия значит одно и то же в обеих проверках.

const ACCEPTANCE = 'docs/05-verification/acceptance.md';
const MATRIX = 'docs/05-verification/acceptance-coverage.md';
const EXCEPTIONS = 'Исключения';
const PARTS = 'Части вне тестов';
const TEST_DIRS = ['core/test', 'electron/test', 'contracts/test', 'testing/test', 'playground/test', 'playground/src', 'tools', 'templates/plugin/test', 'scripts/test'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'fixtures']);
// Образцы ключей в собственном тесте - данные, а не проверки.
const SELF = 'scripts/test/check-acceptance.test.ts';
export const REASONS = ['окно', 'инструменты', 'документ', 'замер', 'этап 2', 'ручная'] as const;

const KEY = /ST-\d{4,}\/\d+/g;
// `.skip` и `.todo` ловятся отдельно: пропущенный тест не проверяет критерий. Перед именем вызова не бывает `.`, буквы и `$`: `regexp.test('ST-1001/1')` - не тест.
const CALL = /(?<![\w.$])(?:test|it|describe)(\.(?:skip|todo|only))?\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
// Параметры теста: `{ skip: true }`, `{ todo: 'позже' }`; условие (`skip: process.platform === 'win32'`) тест не пропускает безусловно.
const DISABLED = /^\s*,\s*\{[^}]*\b(?:skip|todo)\s*:\s*(?:true\b|['"`])/;

export interface TestKey {
  readonly key: string;
  readonly file: string;
  readonly skipped: boolean;
}

export interface Exception {
  readonly key: string;
  readonly reason: string;
  readonly where: string;
}

export interface AcceptanceReport {
  readonly criteria: readonly Criterion[];
  readonly tests: ReadonlyMap<string, readonly string[]>;
  readonly exceptions: ReadonlyMap<string, Exception>;
  readonly parts: ReadonlyMap<string, Exception>;
  readonly problems: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function walk(root: string, rel: string, out: string[]): void {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.posix.join(rel, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, child, out);
    } else if (e.isFile() && e.name.endsWith('.test.ts') && child !== SELF) out.push(child);
  }
}

export function testFiles(root: string): string[] {
  const out: string[] = [];
  for (const dir of TEST_DIRS) walk(root, dir, out);
  return out.sort(compare);
}

export function scanTests(text: string, file: string): TestKey[] {
  const keys: TestKey[] = [];
  const source = text.replaceAll('\r\n', '\n');
  for (const m of source.matchAll(CALL)) {
    const lineStart = source.lastIndexOf('\n', m.index) + 1;
    if (/^\s*(\/\/|\/\*|\*)/.test(source.slice(lineStart, m.index + 1))) continue;
    const skipped = m[1] === '.skip' || m[1] === '.todo' || DISABLED.test(source.slice(m.index + m[0].length, m.index + m[0].length + 200));
    for (const k of (m[3] ?? '').matchAll(KEY)) keys.push({ key: k[0], file, skipped });
  }
  return keys;
}

/** Строки таблицы раздела `section`: `| ST-NNNN/k[, ST-NNNN/k] | причина | где проверяется |`. */
export function parseExceptions(text: string, section = EXCEPTIONS): { items: Exception[]; problems: string[] } {
  const items: Exception[] = [];
  const problems: string[] = [];
  let current = '';
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading?.[1] !== undefined) current = heading[1].trim();
    if (current !== section || !line.startsWith('|') || /^\|\s*(Критерий|-)/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const [keys = '', reason = '', where = ''] = cells;
    const found = [...keys.matchAll(KEY)].map((m) => m[0]);
    if (found.length === 0) {
      problems.push(`${ACCEPTANCE}: строка исключения без ключа ST-NNNN/k «${line.slice(0, 80)}»`);
      continue;
    }
    if (!(REASONS as readonly string[]).includes(reason)) problems.push(`${ACCEPTANCE}: ${found.join(', ')}: причина «${reason}» не из списка (${REASONS.join(', ')})`);
    if (where === '') problems.push(`${ACCEPTANCE}: ${found.join(', ')}: не сказано, где проверяется`);
    for (const key of found) items.push({ key, reason, where });
  }
  return { items, problems };
}

export function collectAcceptance(root: string): AcceptanceReport {
  const trace = collect(root);
  const criteria = trace.stories.flatMap((s) => s.criteria);
  const known = new Map(criteria.map((c) => [`${c.story}/${String(c.number)}`, c]));
  const problems: string[] = [];

  const tests = new Map<string, string[]>();
  for (const file of testFiles(root)) {
    for (const t of scanTests(fs.readFileSync(path.join(root, file), 'utf8'), file)) {
      if (!known.has(t.key)) problems.push(`${t.file}: ключ ${t.key} - такого критерия нет`);
      else if (t.skipped) problems.push(`${t.file}: ключ ${t.key} стоит на пропущенном тесте (.skip или .todo)`);
      else {
        const files = tests.get(t.key) ?? [];
        if (!files.includes(t.file)) files.push(t.file);
        tests.set(t.key, files);
      }
    }
  }

  const read = (section: string): Map<string, Exception> => {
    const items = new Map<string, Exception>();
    const parsed = parseExceptions(text, section);
    problems.push(...parsed.problems);
    for (const e of parsed.items) {
      if (!known.has(e.key)) problems.push(`${ACCEPTANCE}: ${section}: ${e.key} - такого критерия нет`);
      else if (items.has(e.key)) problems.push(`${ACCEPTANCE}: ${section}: ${e.key} записан дважды`);
      else items.set(e.key, e);
    }
    return items;
  };
  const file = path.join(root, ACCEPTANCE);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const exceptions = read(EXCEPTIONS);
  const parts = read(PARTS);
  for (const key of parts.keys()) if (!tests.has(key)) problems.push(`${key}: часть вне тестов записана, а теста с ключом нет - запишите критерий в «${EXCEPTIONS}»`);

  for (const [key, c] of known) {
    const tested = tests.has(key);
    const excepted = exceptions.has(key);
    if (tested && excepted) problems.push(`${key}: есть и тест, и исключение - оставьте одно`);
    else if (c.target && (tested || excepted)) problems.push(`${key}: критерий помечен [целевое поведение], но проверка есть - снимите метку в истории или проверку`);
    else if (!c.target && !tested && !excepted) problems.push(`${key}: нет ни теста с ключом в имени, ни исключения в ${ACCEPTANCE}`);
  }
  return { criteria, tests, exceptions, parts, problems };
}

const HEAD = ['---', 'level: verification', 'status: review', 'date: 2026-11-12', 'origin: derived', '---', ''].join('\n');

function sortKey(key: string): string {
  const [story = '', n = '0'] = key.split('/');
  return `${story}/${n.padStart(3, '0')}`;
}

export function renderMatrix(report: AcceptanceReport): string {
  const keyOf = (c: Criterion): string => `${c.story}/${String(c.number)}`;
  const tested = report.criteria.filter((c) => report.tests.has(keyOf(c))).length;
  const target = report.criteria.filter((c) => c.target).length;
  const out = [
    '# Матрица приёмки',
    '',
    'Собрана из историй, имён тестов и исключений [acceptance.md](acceptance.md) командой `npm run check:acceptance -- --write`; руками не правится.',
    '',
    `Итог: критериев ${String(report.criteria.length)}; тестом ${String(tested)}, исключением ${String(report.exceptions.size)}, целевое поведение ${String(target)}.`,
    '',
    '| Критерий | Чем проверяется |',
    '|---|---|',
  ];
  for (const c of [...report.criteria].sort((a, b) => compare(sortKey(keyOf(a)), sortKey(keyOf(b))))) {
    const key = keyOf(c);
    const files = report.tests.get(key);
    const exception = report.exceptions.get(key);
    const part = report.parts.get(key);
    const rest = part !== undefined ? `; часть - ${part.reason}: ${part.where}` : '';
    const how = files !== undefined ? `${files.map((f) => `\`${f}\``).join(', ')}${rest}` : exception !== undefined ? `${exception.reason}: ${exception.where}` : c.target ? 'целевое поведение' : '**нет**';
    out.push(`| ${key} | ${how} |`);
  }
  out.push('');
  return out.join('\n');
}

function splitHead(text: string): { head: string; body: string } {
  const m = /^---\n[\s\S]*?\n---\n\n?/.exec(text);
  return m ? { head: m[0].replace(/\n*$/, '\n\n'), body: text.slice(m[0].length) } : { head: '', body: text };
}

export function main(args: readonly string[], root: string): { code: number; out: string; err: string } {
  const report = collectAcceptance(root);
  const target = path.join(root, MATRIX);
  const body = renderMatrix(report);
  if (report.problems.length > 0) return { code: 1, out: '', err: `находок: ${String(report.problems.length)}\n${report.problems.join('\n')}\n` };
  if (args.includes('--write')) {
    const head = fs.existsSync(target) ? splitHead(fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n')).head : `${HEAD}\n`;
    fs.writeFileSync(target, `${head}${body}`);
    return { code: 0, out: `матрица приёмки записана: ${MATRIX}\n`, err: '' };
  }
  if (!fs.existsSync(target) || splitHead(fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n')).body !== body) return { code: 1, out: '', err: `${MATRIX} расходится с собранной матрицей: npm run check:acceptance -- --write\n` };
  return { code: 0, out: `приёмка в порядке: критериев ${String(report.criteria.length)}, тестом ${String(report.tests.size)}, исключением ${String(report.exceptions.size)}\n`, err: '' };
}

if (process.argv[1] === import.meta.filename) {
  const result = main(process.argv.slice(2), process.cwd());
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
