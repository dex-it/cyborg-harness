import fs from 'node:fs';
import path from 'node:path';

// `node scripts/check-docs-trace.ts [--write]` - полнота двух сторон между сценариями, нормами и историями (#186, CI-шаг «ссылки в docs»).
// Каждая норма (`### FR-CH-NNNN`, `### NFR-CH-NNNN` в srs.md фич) обязана дать критерий приёмки в какой-нибудь истории, каждая ветка сценария
// (шаг основного хода и расширение) - быть покрыта критерием либо названа открытой строкой `Открыто: [UC-...#ветка]` в истории;
// метка критерия не должна указывать на несуществующую единицу. Таблица покрытия `docs/03-requirements/coverage.md` собирается этим же
// скриптом (`--write`), в режиме проверки она обязана совпадать с собранной. Без сети и без зависимостей.

const REQUIREMENTS = 'docs/03-requirements';
const USE_CASES = 'docs/02-use-cases';
const COUNTER = 'docs/.req_counter';
const COVERAGE = `${REQUIREMENTS}/coverage.md`;

export interface Unit {
  readonly id: string;
  readonly title: string;
  readonly feature: string;
}

export interface Branch {
  readonly uc: string;
  readonly id: string;
  readonly kind: 'шаг' | 'расширение';
}

export interface Criterion {
  readonly story: string;
  readonly number: number;
  readonly labels: readonly string[];
}

export interface Story {
  readonly id: string;
  readonly feature: string;
  readonly title: string;
  readonly file: string;
  readonly criteria: readonly Criterion[];
  /** Ветки, названные в строках «Открыто: ...». */
  readonly open: readonly string[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly branches: readonly Branch[];
}

export interface TraceReport {
  readonly units: readonly Unit[];
  readonly scenarios: readonly Scenario[];
  readonly stories: readonly Story[];
  readonly problems: readonly string[];
}

const UNIT_LABEL = /^N?FR-CH-\d+$/;
const BRANCH_LABEL = /^(UC-[A-Z-]+-\d{4})#(.+)$/;

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => e.name)
    .sort();
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Нормы фич в порядке папок и появления в srs.md. */
function readUnits(root: string): Unit[] {
  const units: Unit[] = [];
  for (const feature of listDirs(path.join(root, REQUIREMENTS))) {
    const srs = path.join(REQUIREMENTS, feature, 'srs.md');
    if (!fs.existsSync(path.join(root, srs))) continue;
    for (const m of read(root, srs).matchAll(/^### (N?FR-CH-\d+) (.+)$/gm)) if (m[1] !== undefined && m[2] !== undefined) units.push({ id: m[1], title: m[2].trim(), feature });
  }
  return units;
}

/** Ветки сценария: шаги основного хода (`1.`) и расширения (`- **1а.`, `- **1а1.`). */
function readScenarios(root: string): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const dir of listDirs(path.join(root, USE_CASES))) {
    for (const name of listFiles(path.join(root, USE_CASES, dir), /^UC-.+\.md$/)) {
      const id = /^(UC-[A-Z-]+-\d{4})-/.exec(name)?.[1];
      if (id === undefined) continue;
      const text = read(root, path.join(USE_CASES, dir, name));
      const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? id;
      const branches: Branch[] = [];
      let section = '';
      for (const line of text.split('\n')) {
        const heading = /^## (.+)$/.exec(line);
        if (heading?.[1] !== undefined) {
          section = heading[1].trim();
          continue;
        }
        if (section === 'Основной ход') {
          const step = /^(\d+)\. /.exec(line)?.[1];
          if (step !== undefined) branches.push({ uc: id, id: step, kind: 'шаг' });
        } else if (section === 'Расширения') {
          const ext = /^- \*\*(\d+[а-яё]\d*)\./.exec(line)?.[1];
          if (ext !== undefined) branches.push({ uc: id, id: ext, kind: 'расширение' });
        }
      }
      scenarios.push({ id, title, branches });
    }
  }
  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

function readStories(root: string): Story[] {
  const stories: Story[] = [];
  for (const feature of listDirs(path.join(root, REQUIREMENTS))) {
    const dir = path.join(REQUIREMENTS, feature, 'stories');
    for (const name of listFiles(path.join(root, dir), /^ST-.+\.md$/)) {
      const file = path.join(dir, name);
      const text = read(root, file);
      const id = /^id: (ST-\d+)$/m.exec(text)?.[1] ?? /^ST-\d+/.exec(name)?.[0] ?? name;
      const title = /^# ST-\d+ (.+)$/m.exec(text)?.[1]?.trim() ?? id;
      const criteria: Criterion[] = [];
      const open: string[] = [];
      for (const line of text.split('\n')) {
        const criterion = /^(\d+)\. ((?:\[[^\]]+\] ?)+)$/.exec(line);
        if (criterion?.[1] !== undefined && criterion[2] !== undefined) {
          const labels = [...criterion[2].matchAll(/\[([^\]]+)\]/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
          criteria.push({ story: id, number: Number(criterion[1]), labels });
        } else if (line.startsWith('Открыто:')) {
          for (const m of line.matchAll(/\[(UC-[A-Z-]+-\d{4}#[^\]]+)\]/g)) if (m[1] !== undefined) open.push(m[1]);
        }
      }
      stories.push({ id, feature, title, file, criteria, open });
    }
  }
  return stories;
}

function counterValue(root: string, key: string): number | undefined {
  const file = path.join(root, COUNTER, key);
  if (!fs.existsSync(file)) return undefined;
  return Number(fs.readFileSync(file, 'utf8').trim());
}

/** Сверка счётчиков `N.ST` и `N.UC` с наибольшим номером единиц своего блока. */
function counterProblems(root: string, stories: readonly Story[], scenarios: readonly Scenario[]): string[] {
  const problems: string[] = [];
  const maxima = new Map<string, number>();
  const bump = (key: string, value: number): void => {
    maxima.set(key, Math.max(maxima.get(key) ?? 0, value));
  };
  for (const s of stories) {
    const m = /^ST-(\d)(\d{3})$/.exec(s.id);
    if (m?.[1] !== undefined) bump(`0${m[1]}.ST`, Number(`${m[1]}${m[2] ?? ''}`));
  }
  for (const sc of scenarios) {
    const m = /-(\d)(\d{3})$/.exec(sc.id);
    if (m?.[1] !== undefined) bump(`0${m[1]}.UC`, Number(`${m[1]}${m[2] ?? ''}`));
  }
  for (const [key, max] of [...maxima].sort(([a], [b]) => a.localeCompare(b))) {
    const value = counterValue(root, key);
    if (value === undefined) problems.push(`нет счётчика ${COUNTER}/${key}, а в блоке есть номер ${String(max)}`);
    else if (!(value >= max)) problems.push(`счётчик ${COUNTER}/${key} равен ${String(value)}, а в блоке есть номер ${String(max)}`);
  }
  return problems;
}

export function collect(root: string): TraceReport {
  const units = readUnits(root);
  const scenarios = readScenarios(root);
  const stories = readStories(root);
  const problems: string[] = [];
  const unitIds = new Set(units.map((u) => u.id));
  const branchKeys = new Set(scenarios.flatMap((sc) => sc.branches.map((b) => `${b.uc}#${b.id}`)));
  const storyIds = new Set<string>();
  const coveredUnits = new Set<string>();
  const coveredBranches = new Set<string>();
  for (const story of stories) {
    if (storyIds.has(story.id)) problems.push(`${story.id}: идентификатор истории повторяется (${story.file})`);
    storyIds.add(story.id);
    const block = /^0*(\d)/.exec(story.feature)?.[1];
    if (block !== undefined && story.id.charAt(3) !== block) problems.push(`${story.id}: номер вне блока фичи ${story.feature}`);
    if (story.criteria.length === 0) problems.push(`${story.id}: нет ни одного критерия приёмки`);
    for (const c of story.criteria) {
      const where = `${story.id}/${String(c.number)}`;
      if (!c.labels.some((l) => UNIT_LABEL.test(l))) problems.push(`${where}: критерий без метки нормы (FR-CH-... или NFR-CH-...)`);
      for (const label of c.labels) {
        const branch = BRANCH_LABEL.exec(label);
        if (UNIT_LABEL.test(label)) {
          if (unitIds.has(label)) coveredUnits.add(label);
          else problems.push(`${where}: метка [${label}] указывает на несуществующую норму`);
        } else if (branch) {
          if (branchKeys.has(label)) coveredBranches.add(label);
          else problems.push(`${where}: метка [${label}] указывает на несуществующую ветку сценария`);
        } else problems.push(`${where}: незнакомая метка [${label}]`);
      }
    }
    for (const label of story.open) {
      if (branchKeys.has(label)) coveredBranches.add(label);
      else problems.push(`${story.id}: «Открыто» называет несуществующую ветку [${label}]`);
    }
  }
  for (const unit of units) if (!coveredUnits.has(unit.id)) problems.push(`${unit.id}: норма не дала ни одного критерия приёмки`);
  for (const sc of scenarios) for (const b of sc.branches) if (!coveredBranches.has(`${b.uc}#${b.id}`)) problems.push(`${b.uc}#${b.id}: ${b.kind} сценария не покрыт критерием и не назван открытым`);
  problems.push(...counterProblems(root, stories, scenarios));
  return { units, scenarios, stories, problems };
}

const HEAD = ['---', 'level: coverage', 'status: review', 'date: 2026-11-10', 'origin: derived', '---', ''].join('\n');

function sortKey(id: string): string {
  return id.padStart(4, '0');
}

function byStory(a: string, b: string): number {
  const [sa = '', na = '0'] = a.split('/');
  const [sb = '', nb = '0'] = b.split('/');
  return sa === sb ? Number(na) - Number(nb) : sortKey(sa).localeCompare(sortKey(sb));
}

/** Тело таблицы покрытия: без шапки, чтобы дата в шапке не участвовала в сверке. */
export function renderCoverage(report: TraceReport): string {
  const refs = new Map<string, string[]>();
  const add = (key: string, ref: string): void => {
    const list = refs.get(key) ?? [];
    if (!list.includes(ref)) list.push(ref);
    refs.set(key, list);
  };
  for (const story of report.stories) for (const c of story.criteria) for (const label of c.labels) add(label, `${story.id}/${String(c.number)}`);
  const open = new Map<string, string[]>();
  for (const story of report.stories) for (const label of story.open) open.set(label, [...(open.get(label) ?? []), story.id]);
  const criteria = report.stories.reduce((n, s) => n + s.criteria.length, 0);
  const branches = report.scenarios.flatMap((sc) => sc.branches);
  const openBranches = branches.filter((b) => !refs.has(`${b.uc}#${b.id}`) && open.has(`${b.uc}#${b.id}`)).length;
  const frCount = report.units.filter((u) => u.id.startsWith('FR')).length;
  const out: string[] = [
    '# Покрытие критериями приёмки',
    '',
    'Таблица собрана из `srs.md` фич, сценариев и историй командой `npm run check:docs-trace -- --write`; руками не правится. `npm run check:docs-trace` падает, если норма не дала критерия, ветка сценария не покрыта и не названа открытой, метка указывает на несуществующую единицу или эта таблица расходится с собранной. Метка критерия - `[FR-CH-NNNN]` или `[NFR-CH-NNNN]` (норма) и `[UC-{ФИЧА}-NNNN#ветка]` (шаг `N` или расширение `Nб` сценария); в ячейках ниже `ST-NNNN/k` - критерий k истории.',
    '',
    `Итог: историй ${String(report.stories.length)}, критериев ${String(criteria)}; норм ${String(report.units.length)} (FR ${String(frCount)}, NFR ${String(report.units.length - frCount)}), все дали критерий; веток сценариев ${String(branches.length)}, покрыто ${String(branches.length - openBranches)}, открыто ${String(openBranches)}.`,
    '',
    '## Истории',
    '',
    '| История | Фича | Критериев | Название |',
    '|---|---|---|---|',
  ];
  for (const s of report.stories) out.push(`| [${s.id}](${s.file.slice(REQUIREMENTS.length + 1).replaceAll(path.sep, '/')}) | ${s.feature} | ${String(s.criteria.length)} | ${s.title} |`);
  out.push('', '## Ветки сценариев', '');
  for (const sc of report.scenarios) {
    out.push(`### ${sc.id} ${sc.title}`, '', '| Ветка | Критерии |', '|---|---|');
    for (const b of sc.branches) {
      const key = `${b.uc}#${b.id}`;
      const covered = [...(refs.get(key) ?? [])].sort(byStory);
      const holders = open.get(key);
      const cell = covered.length > 0 ? covered.join(', ') : `открыта (${(holders ?? []).join(', ')})`;
      out.push(`| ${b.kind} ${b.id} | ${cell} |`);
    }
    out.push('');
  }
  out.push('## Нормы', '', '| Норма | Фича | Название | Критерии |', '|---|---|---|---|');
  for (const u of report.units) out.push(`| ${u.id} | ${u.feature} | ${u.title} | ${[...(refs.get(u.id) ?? [])].sort(byStory).join(', ')} |`);
  out.push('');
  return out.join('\n');
}

function splitHead(text: string): { head: string; body: string } {
  const m = /^---\n[\s\S]*?\n---\n\n?/.exec(text);
  return m ? { head: m[0].replace(/\n*$/, '\n\n'), body: text.slice(m[0].length) } : { head: '', body: text };
}

/** Разбор командной строки и печать отчёта; код выхода 1, если есть находки или таблица покрытия устарела. */
export function main(args: readonly string[], root: string): { code: number; out: string; err: string } {
  const report = collect(root);
  const write = args.includes('--write');
  const target = path.join(root, COVERAGE);
  const body = renderCoverage(report);
  if (report.problems.length > 0) return { code: 1, out: '', err: `находок: ${String(report.problems.length)}\n${report.problems.join('\n')}\n` };
  if (write) {
    const head = fs.existsSync(target) ? splitHead(fs.readFileSync(target, 'utf8')).head : `${HEAD}\n`;
    fs.writeFileSync(target, `${head}${body}`);
    return { code: 0, out: `таблица покрытия записана: ${COVERAGE}\n`, err: '' };
  }
  if (!fs.existsSync(target) || splitHead(fs.readFileSync(target, 'utf8')).body !== body) return { code: 1, out: '', err: `${COVERAGE} расходится с собранной таблицей: npm run check:docs-trace -- --write\n` };
  const frCount = report.units.filter((u) => u.id.startsWith('FR')).length;
  return {
    code: 0,
    out: `покрытие в порядке: историй ${String(report.stories.length)}, норм ${String(report.units.length)} (FR ${String(frCount)}), веток сценариев ${String(report.scenarios.reduce((n, sc) => n + sc.branches.length, 0))}\n`,
    err: '',
  };
}

if (process.argv[1] === import.meta.filename) {
  const result = main(process.argv.slice(2), process.cwd());
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
