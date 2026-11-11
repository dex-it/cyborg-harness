import fs from 'node:fs';
import path from 'node:path';

// `node scripts/check-docs-trace.ts [--write]` - полнота двух сторон между сценариями, нормами и историями (#186, CI-шаг «ссылки в docs»).
// Каждая норма (`### FR-CH-NNNN`, `### NFR-CH-NNNN` в srs.md фич) обязана дать критерий приёмки в какой-нибудь истории, каждая ветка сценария
// (шаг основного хода и расширение) - быть покрыта критерием либо названа открытой строкой `Открыто: [UC-...#ветка]` в истории;
// метка критерия не должна указывать на несуществующую единицу. Метка `[целевое поведение]` на критерии отмечает поведение, которого ещё нет
// (нормы с «Ещё нет»): таблица выводит такие критерии отдельно от проверяемых. Всё, что скрипт не смог разобрать (расширение с латинской «a»,
// файл без слага, заголовок нормы другого вида, строка «Открыто» без метки), - находка, а не молчаливый пропуск. Таблица покрытия
// `docs/03-requirements/coverage.md` собирается этим же скриптом (`--write`), в режиме проверки она обязана совпадать с собранной.
// Цепочка BR продукта -> BR фичи (`brd-feat.md`) -> норма проверяется так же: у каждой нормы `traced from` называет BR своей фичи (или находку из журнала решений фичи), у каждого BR фичи - BR продукта.
// Без сети и без зависимостей.

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
  /** Метки норм и веток; метка `[целевое поведение]` сюда не входит. */
  readonly labels: readonly string[];
  /** Критерий описывает поведение, которого ещё нет. */
  readonly target: boolean;
}

export interface Story {
  readonly id: string;
  readonly feature: string;
  readonly title: string;
  readonly file: string;
  readonly criteria: readonly Criterion[];
  /** Ветки, названные в строках «Открыто: ...». */
  readonly open: readonly string[];
  /** Нормы, названные в строках «Открыто: ...». */
  readonly openUnits: readonly string[];
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** Фича из шапки и фичи из `touches`. */
  readonly features: readonly string[];
  readonly branches: readonly Branch[];
}

export interface TraceReport {
  readonly units: readonly Unit[];
  readonly scenarios: readonly Scenario[];
  readonly stories: readonly Story[];
  readonly problems: readonly string[];
}

const UNIT_LABEL = /^N?FR-CH-\d+$/;
const BRANCH_LABEL = /^(UC-[A-Z-]+-\d{4,})#(.+)$/;
const TARGET_LABEL = 'целевое поведение';

/** Сравнение по кодовым точкам: порядок в таблице не зависит от локали (R2 задачи #212). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clip(line: string): string {
  const text = line.trim();
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(compare);
}

function listFiles(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Файл целиком с `\n` вместо `\r\n`: регулярные выражения ниже не знают `\r`. */
function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8').replaceAll('\r\n', '\n');
}

interface Parsed<T> {
  readonly items: T[];
  readonly problems: string[];
}

/** Номер фичи из имени папки: `01-plugin-host` -> 1, `10-x` -> 10. */
function featureBlock(feature: string): number | undefined {
  const m = /^(\d+)-/.exec(feature);
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** Нормы фич в порядке папок и появления в srs.md; заголовок нормы другого вида и фича без srs.md - находки. */
function readUnits(root: string): Parsed<Unit> {
  const units: Unit[] = [];
  const problems: string[] = [];
  for (const feature of listDirs(path.join(root, REQUIREMENTS))) {
    const srs = path.join(REQUIREMENTS, feature, 'srs.md');
    if (!fs.existsSync(path.join(root, srs))) {
      problems.push(`${REQUIREMENTS}/${feature}: нет srs.md`);
      continue;
    }
    const lines = read(root, srs).split('\n');
    lines.forEach((line, index) => {
      const m = /^### (N?FR-CH-\d+) (.+)$/.exec(line);
      if (m?.[1] !== undefined && m[2] !== undefined) units.push({ id: m[1], title: m[2].trim(), feature });
      else if (/^#{1,6}\s*N?FR-CH-/.test(line)) problems.push(`${srs.replaceAll(path.sep, '/')}:${String(index + 1)}: заголовок нормы не вида «### FR-CH-NNNN Название»: ${clip(line)}`);
    });
  }
  return { items: units, problems };
}

/** Шапка файла: поля `ключ: значение` между первой парой `---`. */
function frontMatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const block = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1] ?? '';
  for (const line of block.split('\n')) {
    const m = /^([^:\s]+):\s*(.*)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) fields.set(m[1], m[2].trim());
  }
  return fields;
}

/** Ветки сценария: шаги основного хода (`1.`) и расширения (`- **1а.`, `- **1а1.`); строка раздела, которой не нашлось места, - находка. */
function readScenarios(root: string): Parsed<Scenario> {
  const scenarios: Scenario[] = [];
  const problems: string[] = [];
  for (const dir of listDirs(path.join(root, USE_CASES))) {
    for (const name of listFiles(path.join(root, USE_CASES, dir), /\.md$/)) {
      const rel = `${USE_CASES}/${dir}/${name}`;
      const id = /^(UC-[A-Z-]+-\d{4,})-.+\.md$/.exec(name)?.[1];
      if (id === undefined) {
        problems.push(`${rel}: имя файла сценария не вида UC-<ФИЧА>-NNNN-<слаг>.md`);
        continue;
      }
      const text = read(root, path.join(USE_CASES, dir, name));
      const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? id;
      const head = frontMatter(text);
      const own = head.get('feature');
      if (own === undefined || own === '') problems.push(`${id}: нет поля feature в шапке`);
      const touches = (head.get('touches') ?? '').split(',').map((f) => f.trim()).filter((f) => f !== '' && f !== '-');
      const branches: Branch[] = [];
      let section = '';
      let hasExtensions = false;
      for (const line of text.split('\n')) {
        const heading = /^## (.+)$/.exec(line);
        if (heading?.[1] !== undefined) {
          section = heading[1].trim();
          if (section === 'Расширения') hasExtensions = true;
          continue;
        }
        if (section === 'Основной ход') {
          const step = /^(\d+)\. /.exec(line)?.[1];
          if (step !== undefined) branches.push({ uc: id, id: step, kind: 'шаг' });
          else if (/^\d/.test(line)) problems.push(`${id}: строка основного хода не распознана «${clip(line)}» (ждём «N. текст»)`);
        } else if (section === 'Расширения') {
          const ext = /^- \*\*(\d+[а-яё]\d*)\./.exec(line)?.[1];
          if (ext !== undefined) branches.push({ uc: id, id: ext, kind: 'расширение' });
          else if (line.startsWith('- **')) problems.push(`${id}: строка расширения не распознана «${clip(line)}» (ждём «- **Nб. ...»: цифры и кириллическая буква)`);
        }
      }
      if (!branches.some((b) => b.kind === 'шаг')) problems.push(`${id}: нет раздела «Основной ход» с шагами`);
      if (!hasExtensions) problems.push(`${id}: нет раздела «Расширения»`);
      scenarios.push({ id, title, features: [...(own === undefined || own === '' ? [] : [own]), ...touches], branches });
    }
  }
  return { items: scenarios.sort((a, b) => compare(a.id, b.id)), problems };
}

function readStories(root: string): Parsed<Story> {
  const stories: Story[] = [];
  const problems: string[] = [];
  for (const feature of listDirs(path.join(root, REQUIREMENTS))) {
    const dir = path.join(REQUIREMENTS, feature, 'stories');
    for (const name of listFiles(path.join(root, dir), /\.md$/)) {
      const file = path.join(dir, name);
      if (!/^ST-\d+-.+\.md$/.test(name)) {
        problems.push(`${file.replaceAll(path.sep, '/')}: имя файла истории не вида ST-NNNN-<слаг>.md`);
        continue;
      }
      const text = read(root, file);
      const id = /^id: (ST-\d+)$/m.exec(text)?.[1] ?? /^ST-\d+/.exec(name)?.[0] ?? name;
      const title = /^# ST-\d+ (.+)$/m.exec(text)?.[1]?.trim() ?? id;
      const criteria: Criterion[] = [];
      const open: string[] = [];
      const openUnits: string[] = [];
      let section = '';
      for (const line of text.split('\n')) {
        const heading = /^## (.+)$/.exec(line);
        if (heading?.[1] !== undefined) section = heading[1].trim();
        const criterion = /^(\d+)\. ((?:\[[^\]]+\] ?)+)$/.exec(line);
        if (criterion?.[1] !== undefined && criterion[2] !== undefined) {
          const all = [...criterion[2].matchAll(/\[([^\]]+)\]/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
          criteria.push({ story: id, number: Number(criterion[1]), labels: all.filter((l) => l !== TARGET_LABEL), target: all.includes(TARGET_LABEL) });
        } else if (section === 'Критерии приёмки' && /^\d+\. /.test(line)) {
          problems.push(`${id}: строка критерия не распознана «${clip(line)}» (ждём «N. [метка] [метка]»)`);
        } else if (line.startsWith('Открыто:')) {
          const labels = [...line.matchAll(/\[([^\]]+)\]/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
          let named = false;
          for (const label of labels) {
            if (BRANCH_LABEL.test(label)) {
              open.push(label);
              named = true;
            } else if (UNIT_LABEL.test(label)) {
              openUnits.push(label);
              named = true;
            }
          }
          if (!named) problems.push(`${id}: «Открыто» без метки ветки [UC-...#N] или нормы [FR-CH-NNNN]`);
        }
      }
      const seen = new Set<number>();
      let previous = 0;
      for (const c of criteria) {
        if (seen.has(c.number)) problems.push(`${id}: номер критерия ${String(c.number)} повторяется`);
        else if (c.number !== previous + 1) problems.push(`${id}: номера критериев идут не подряд: после ${String(previous)} стоит ${String(c.number)}`);
        seen.add(c.number);
        previous = c.number;
      }
      stories.push({ id, feature, title, file, criteria, open, openUnits });
    }
  }
  return { items: stories, problems };
}

function counterValue(root: string, key: string): number | undefined {
  const file = path.join(root, COUNTER, key);
  if (!fs.existsSync(file)) return undefined;
  return Number(fs.readFileSync(file, 'utf8').trim());
}

/** Блок номера и номер единицы: `ST-1001` -> блок 1, `ST-10001` -> блок 10 (три последние цифры - порядковый номер в блоке). */
function numberBlock(id: string, prefix: 'ST-' | 'UC-'): { block: number; value: number } | undefined {
  const m = (prefix === 'ST-' ? /^ST-(\d+?)(\d{3})$/ : /-(\d+?)(\d{3})$/).exec(id);
  return m?.[1] === undefined || m[2] === undefined ? undefined : { block: Number(m[1]), value: Number(`${m[1]}${m[2]}`) };
}

/** Сверка счётчиков `NN.ST` и `NN.UC` с наибольшим номером единиц своего блока. */
function counterProblems(root: string, stories: readonly Story[], scenarios: readonly Scenario[]): string[] {
  const problems: string[] = [];
  const maxima = new Map<string, number>();
  const bump = (key: string, value: number): void => {
    maxima.set(key, Math.max(maxima.get(key) ?? 0, value));
  };
  for (const s of stories) {
    const n = numberBlock(s.id, 'ST-');
    if (n !== undefined) bump(`${String(n.block).padStart(2, '0')}.ST`, n.value);
  }
  for (const sc of scenarios) {
    const n = numberBlock(sc.id, 'UC-');
    if (n !== undefined) bump(`${String(n.block).padStart(2, '0')}.UC`, n.value);
  }
  for (const [key, max] of [...maxima].sort(([a], [b]) => compare(a, b))) {
    const value = counterValue(root, key);
    if (value === undefined) problems.push(`нет счётчика ${COUNTER}/${key}, а в блоке есть номер ${String(max)}`);
    else if (!(value >= max)) problems.push(`счётчик ${COUNTER}/${key} равен ${String(value)}, а в блоке есть номер ${String(max)}`);
  }
  return problems;
}

const PRODUCT_BRD = 'docs/01-product/brd.md';

/** Номера BR по заголовкам `### BR-CH-NNN` (продукт - три цифры, фича - блок и три цифры номера) и заголовки `BR-CH-` другого вида. */
function readBrHeadings(text: string, digits: string): { ids: string[]; odd: string[] } {
  const ids: string[] = [];
  const odd: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^### (BR-CH-\d+)(?: .+)?$/.exec(line);
    if (m?.[1] !== undefined && new RegExp(`^BR-CH-\\d${digits}$`).test(m[1])) ids.push(m[1]);
    else if (/^#{1,6}\s*BR-CH-/.test(line)) odd.push(clip(line));
  }
  return { ids, odd };
}

/** Строка `traced from` каждого заголовка: id единицы -> текст строки (undefined, если строки нет). */
function tracedFrom(text: string, headingPattern: RegExp): Map<string, string | undefined> {
  const traced = new Map<string, string | undefined>();
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const m = headingPattern.exec(line);
    if (m?.[1] !== undefined) {
      current = m[1];
      traced.set(current, undefined);
    } else if (current !== undefined && line.startsWith('- **traced from:**')) traced.set(current, line);
  }
  return traced;
}

/** Цепочка BR продукта -> BR фичи -> норма (#137 п. 4): у фичи есть brd-feat.md, у каждого её BR - родитель в BRD продукта, у каждой нормы - BR своей фичи или находка из журнала решений; счётчик `NN.BR` не меньше наибольшего номера. */
function chainProblems(root: string): string[] {
  const problems: string[] = [];
  const expanded = new Set<string>();
  const productPath = path.join(root, PRODUCT_BRD);
  const product = new Set(fs.existsSync(productPath) ? readBrHeadings(read(root, PRODUCT_BRD), '{3}').ids : []);
  for (const feature of listDirs(path.join(root, REQUIREMENTS))) {
    const dir = `${REQUIREMENTS}/${feature}`;
    if (!fs.existsSync(path.join(root, dir, 'srs.md'))) continue;
    const block = featureBlock(feature);
    const brdPath = `${dir}/brd-feat.md`;
    if (!fs.existsSync(path.join(root, brdPath))) {
      problems.push(`${brdPath}: нет brd-feat.md (BRD фичи обязателен)`);
      continue;
    }
    const brdText = read(root, brdPath);
    const headings = readBrHeadings(brdText, '{4,}');
    for (const odd of headings.odd) problems.push(`${brdPath}: заголовок BR не вида «### BR-CH-<блок>NNN Название»: ${odd}`);
    const own = new Set<string>();
    let max = 0;
    for (const id of headings.ids) {
      const number = Number(id.slice('BR-CH-'.length));
      if (Math.floor(number / 1000) !== block) problems.push(`${brdPath}: ${id} вне блока номеров фичи ${feature}`);
      else {
        own.add(id);
        max = Math.max(max, number);
      }
    }
    for (const [id, line] of tracedFrom(brdText, /^### (BR-CH-\d{4,})(?: .+)?$/)) {
      const parents = [...(line ?? '').matchAll(/\bBR-CH-(\d{3})\b/g)].map((m) => `BR-CH-${m[1] ?? ''}`);
      if (parents.length === 0) problems.push(`${id}: traced from не называет BR продукта`);
      for (const parent of parents) expanded.add(parent);
      for (const parent of parents) if (!product.has(parent)) problems.push(`${id}: traced from называет ${parent}, которого нет в BRD продукта (${PRODUCT_BRD})`);
    }
    const logPath = path.join(root, dir, 'decision-log.md');
    const log = fs.existsSync(logPath) ? read(root, `${dir}/decision-log.md`) : '';
    for (const [norm, line] of tracedFrom(read(root, `${dir}/srs.md`), /^### (N?FR-CH-\d+) /)) {
      if (line === undefined) {
        problems.push(`${norm}: нет строки traced from`);
        continue;
      }
      const found = /находка (D-\d+)/.exec(line)?.[1];
      if (found !== undefined) {
        if (!new RegExp(`\\|\\s*${found}\\s*\\|`).test(log)) problems.push(`${norm}: находка ${found} не записана в ${dir}/decision-log.md`);
        continue;
      }
      const ids = [...line.matchAll(/\bBR-CH-(\d{4,})\b/g)].map((m) => `BR-CH-${m[1] ?? ''}`);
      if (ids.length === 0) problems.push(`${norm}: traced from не называет BR фичи (BR-CH-NNNN) и не ссылается на находку`);
      for (const id of ids) {
        if (Math.floor(Number(id.slice('BR-CH-'.length)) / 1000) !== block) problems.push(`${norm}: ${id} вне блока номеров фичи ${feature}`);
        else if (!own.has(id)) problems.push(`${norm}: ${id} нет в ${brdPath}`);
      }
    }
    const key = `${String(block).padStart(2, '0')}.BR`;
    const value = counterValue(root, key);
    if (value === undefined) problems.push(`нет счётчика ${COUNTER}/${key}, а в блоке есть номер ${String(max)}`);
    else if (!(value >= max)) problems.push(`счётчик ${COUNTER}/${key} равен ${String(value)}, а в блоке есть номер ${String(max)}`);
  }
  for (const id of [...product].sort(compare)) if (!expanded.has(id)) problems.push(`${id}: BR продукта не развёрнут ни в одном BR фичи`);
  return problems;
}

export function collect(root: string): TraceReport {
  const parsedUnits = readUnits(root);
  const parsedScenarios = readScenarios(root);
  const parsedStories = readStories(root);
  const units = parsedUnits.items;
  const scenarios = parsedScenarios.items;
  const stories = parsedStories.items;
  const problems: string[] = [...parsedUnits.problems, ...parsedScenarios.problems, ...parsedStories.problems];
  const unitIds = new Set(units.map((u) => u.id));
  const branchKeys = new Set(scenarios.flatMap((sc) => sc.branches.map((b) => `${b.uc}#${b.id}`)));
  const scenarioFeatures = new Map(scenarios.map((sc) => [sc.id, sc.features]));
  const storyIds = new Set<string>();
  const coveredUnits = new Set<string>();
  const coveredBranches = new Set<string>();
  for (const story of stories) {
    if (storyIds.has(story.id)) problems.push(`${story.id}: идентификатор истории повторяется (${story.file})`);
    storyIds.add(story.id);
    const number = numberBlock(story.id, 'ST-');
    if (number === undefined) problems.push(`${story.id}: идентификатор истории не вида ST-<блок фичи><NNN>`);
    else if (number.block !== featureBlock(story.feature)) problems.push(`${story.id}: номер вне блока фичи ${story.feature}`);
    if (story.criteria.length === 0) problems.push(`${story.id}: нет ни одного критерия приёмки`);
    for (const c of story.criteria) {
      const where = `${story.id}/${String(c.number)}`;
      if (!c.labels.some((l) => UNIT_LABEL.test(l))) problems.push(`${where}: критерий без метки нормы (FR-CH-... или NFR-CH-...)`);
      const strangers = new Map<string, string[]>();
      for (const label of c.labels) {
        const branch = BRANCH_LABEL.exec(label);
        if (UNIT_LABEL.test(label)) {
          if (unitIds.has(label)) coveredUnits.add(label);
          else problems.push(`${where}: метка [${label}] указывает на несуществующую норму`);
        } else if (branch) {
          if (branchKeys.has(label)) {
            coveredBranches.add(label);
            const uc = branch[1] ?? '';
            const known = scenarioFeatures.get(uc) ?? [];
            if (known.length > 0 && !known.includes(story.feature)) strangers.set(uc, [...(strangers.get(uc) ?? []), `#${branch[2] ?? ''}`]);
          } else problems.push(`${where}: метка [${label}] указывает на несуществующую ветку сценария`);
        } else problems.push(`${where}: незнакомая метка [${label}]`);
      }
      for (const [uc, ids] of strangers) problems.push(`${uc}: ${where} (фича ${story.feature}) метит ${ids.length === 1 ? 'ветку' : 'ветки'} ${ids.join(', ')}, а фичи нет ни в feature, ни в touches сценария`);
    }
    for (const label of story.open) {
      if (branchKeys.has(label)) coveredBranches.add(label);
      else problems.push(`${story.id}: «Открыто» называет несуществующую ветку [${label}]`);
    }
    for (const label of story.openUnits) if (!unitIds.has(label)) problems.push(`${story.id}: «Открыто» называет несуществующую норму [${label}]`);
  }
  for (const unit of units) if (!coveredUnits.has(unit.id)) problems.push(`${unit.id}: норма не дала ни одного критерия приёмки`);
  for (const sc of scenarios) for (const b of sc.branches) if (!coveredBranches.has(`${b.uc}#${b.id}`)) problems.push(`${b.uc}#${b.id}: ${b.kind} сценария не покрыт критерием и не назван открытым`);
  problems.push(...counterProblems(root, stories, scenarios), ...chainProblems(root));
  return { units, scenarios, stories, problems };
}

const HEAD = ['---', 'level: coverage', 'status: review', 'date: 2026-11-10', 'origin: derived', '---', ''].join('\n');

function sortKey(id: string): string {
  return id.padStart(4, '0');
}

function byStory(a: string, b: string): number {
  const [sa = '', na = '0'] = a.split('/');
  const [sb = '', nb = '0'] = b.split('/');
  return sa === sb ? Number(na) - Number(nb) : compare(sortKey(sa), sortKey(sb));
}

/** Тело таблицы покрытия: без шапки, чтобы дата в шапке не участвовала в сверке. */
export function renderCoverage(report: TraceReport): string {
  // Метка -> критерии, разведённые на проверяемые и описывающие целевое поведение.
  const refs = new Map<string, { checked: string[]; target: string[] }>();
  for (const story of report.stories) {
    for (const c of story.criteria) {
      for (const label of c.labels) {
        const entry = refs.get(label) ?? { checked: [], target: [] };
        const list = c.target ? entry.target : entry.checked;
        const ref = `${story.id}/${String(c.number)}`;
        if (!list.includes(ref)) list.push(ref);
        refs.set(label, entry);
      }
    }
  }
  const open = new Map<string, string[]>();
  for (const story of report.stories) for (const label of [...story.open, ...story.openUnits]) open.set(label, [...(open.get(label) ?? []), story.id]);
  const criteria = report.stories.reduce((n, s) => n + s.criteria.length, 0);
  const targetCriteria = report.stories.reduce((n, s) => n + s.criteria.filter((c) => c.target).length, 0);
  const branches = report.scenarios.flatMap((sc) => sc.branches);
  const entryOf = (key: string): { checked: string[]; target: string[] } => refs.get(key) ?? { checked: [], target: [] };
  const has = (key: string): boolean => entryOf(key).checked.length + entryOf(key).target.length > 0;
  const onlyTarget = (key: string): boolean => entryOf(key).checked.length === 0 && entryOf(key).target.length > 0;
  const openBranches = branches.filter((b) => !has(`${b.uc}#${b.id}`) && open.has(`${b.uc}#${b.id}`)).length;
  const targetBranches = branches.filter((b) => onlyTarget(`${b.uc}#${b.id}`)).length;
  const targetUnits = report.units.filter((u) => onlyTarget(u.id)).length;
  const openUnits = report.units.filter((u) => open.has(u.id)).length;
  const frCount = report.units.filter((u) => u.id.startsWith('FR')).length;
  const out: string[] = [
    '# Покрытие критериями приёмки',
    '',
    `Таблица собрана из \`srs.md\` фич, сценариев и историй командой \`npm run check:docs-trace -- --write\`; руками не правится. \`npm run check:docs-trace\` падает, если норма не дала критерия, ветка сценария не покрыта и не названа открытой, метка указывает на несуществующую единицу, строка скриптом не разобрана или эта таблица расходится с собранной. Метка критерия - \`[FR-CH-NNNN]\` или \`[NFR-CH-NNNN]\` (норма) и \`[UC-{ФИЧА}-NNNN#ветка]\` (шаг \`N\` или расширение \`Nб\` сценария); метка \`[${TARGET_LABEL}]\` отмечает критерий на поведение, которого ещё нет (норма с «Ещё нет»): он описывает цель, а не проверенное. Строка \`Открыто: [метка] ...\` в истории называет ветку или норму, по которой решения нет. В ячейках ниже \`ST-NNNN/k\` - критерий k истории; критерии на целевое поведение выведены отдельно от проверяемых.`,
    '',
    `Итог: историй ${String(report.stories.length)}, критериев ${String(criteria)} (из них на целевое поведение ${String(targetCriteria)}); норм ${String(report.units.length)} (FR ${String(frCount)}, NFR ${String(report.units.length - frCount)}), все дали критерий (только целевое поведение: ${String(targetUnits)}; открыто: ${String(openUnits)}); веток сценариев ${String(branches.length)}, покрыто ${String(branches.length - openBranches)} (только целевое поведение: ${String(targetBranches)}), открыто ${String(openBranches)}.`,
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
      const entry = refs.get(key) ?? { checked: [], target: [] };
      const covered = [...entry.checked.map((r) => ({ r, target: false })), ...entry.target.map((r) => ({ r, target: true }))].sort((x, y) => byStory(x.r, y.r));
      const holders = open.get(key);
      const cell = covered.length > 0 ? covered.map((c) => (c.target ? `${c.r} (${TARGET_LABEL})` : c.r)).join(', ') : `открыта (${(holders ?? []).join(', ')})`;
      out.push(`| ${b.kind} ${b.id} | ${cell} |`);
    }
    out.push('');
  }
  out.push('## Нормы', '', '| Норма | Фича | Название | Критерии | Целевое поведение | Открыто |', '|---|---|---|---|---|---|');
  for (const u of report.units) {
    const entry = refs.get(u.id) ?? { checked: [], target: [] };
    const holders = open.get(u.id);
    out.push(`| ${u.id} | ${u.feature} | ${u.title} | ${[...entry.checked].sort(byStory).join(', ')} | ${[...entry.target].sort(byStory).join(', ')} | ${holders === undefined ? '' : `открыта (${holders.join(', ')})`} |`);
  }
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
