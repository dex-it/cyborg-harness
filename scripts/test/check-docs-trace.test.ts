import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { collect, main, renderCoverage } from '../check-docs-trace.ts';

// #186: полнота между нормами, ветками сценариев и критериями историй. Деревья-образцы собираются во временном каталоге.
const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SRS = '# SRS\n\n### FR-CH-1001 Манифест\n\n- **Требование:** x\n\n### NFR-CH-1001 Бюджет\n\n- **Требование:** y\n';
const SCENARIO = '---\nid: UC-PLUGIN-HOST-1001\nfeature: 01-plugin-host\n---\n\n# Сбой плагина\n\n## Основной ход\n\n1. Плагин падает.\n2. Хост ловит.\n\n## Расширения\n\n- **1а. Плагин завис.** Сторож.\n- **1а1. Три раза подряд.** Выключен.\n\n## Постусловия\n\n3. не ветка\n';
const STORY = (criteria: string, extra = ''): string =>
  `---\nlevel: story\nid: ST-1001\nfeature: 01-plugin-host\n---\n\n# ST-1001 Сбой остаётся у плагина\n\n## Критерии приёмки\n\n${criteria}\n${extra}`;
const FULL = '1. [FR-CH-1001] [NFR-CH-1001] [UC-PLUGIN-HOST-1001#1] [UC-PLUGIN-HOST-1001#2] [UC-PLUGIN-HOST-1001#1а] [UC-PLUGIN-HOST-1001#1а1]\n   - Дано плагин\n   - Когда падает\n   - Тогда окно живо\n';

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-trace-'));
  roots.push(root);
  const base: Record<string, string> = {
    'docs/03-requirements/01-plugin-host/srs.md': SRS,
    'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md': SCENARIO,
    'docs/03-requirements/01-plugin-host/stories/ST-1001-failure.md': STORY(FULL),
    'docs/.req_counter/01.ST': '1001\n',
    'docs/.req_counter/01.UC': '1001\n',
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

/** Та же история под другим номером и фичей: заменяются только шапка и заголовок, метки сценария остаются. */
const asStory = (text: string, id: string, feature: string): string => text.replace('id: ST-1001', `id: ${id}`).replace('# ST-1001', `# ${id}`).replace('feature: 01-plugin-host', `feature: ${feature}`);

const STORY_FILE = 'docs/03-requirements/01-plugin-host/stories/ST-1001-failure.md';

describe('collect: разбор норм, веток и критериев', () => {
  it('берёт нормы из заголовков srs.md, шаги и расширения сценария без чужих нумерованных строк', () => {
    const report = collect(tree({}));
    assert.deepEqual(
      report.units.map((u) => u.id),
      ['FR-CH-1001', 'NFR-CH-1001'],
    );
    assert.deepEqual(
      report.scenarios[0]?.branches.map((b) => b.id),
      ['1', '2', '1а', '1а1'],
    );
    assert.equal(report.stories[0]?.criteria[0]?.labels.length, 6);
    assert.deepEqual(report.problems, []);
  });
});

describe('collect: находки', () => {
  it('норма без критерия - находка', () => {
    const root = tree({ [STORY_FILE]: STORY(FULL.replace('[NFR-CH-1001] ', '')) });
    assert.deepEqual(collect(root).problems, ['NFR-CH-1001: норма не дала ни одного критерия приёмки']);
  });

  it('ветка сценария без критерия - находка, строка «Открыто» её снимает', () => {
    const without = FULL.replace(' [UC-PLUGIN-HOST-1001#1а1]', '');
    assert.deepEqual(collect(tree({ [STORY_FILE]: STORY(without) })).problems, ['UC-PLUGIN-HOST-1001#1а1: расширение сценария не покрыт критерием и не назван открытым']);
    assert.deepEqual(collect(tree({ [STORY_FILE]: STORY(without, '\nОткрыто: [UC-PLUGIN-HOST-1001#1а1] вопрос 1 сценария.\n') })).problems, []);
  });

  it('метка на несуществующую норму или ветку и «Открыто» на несуществующую ветку - находки', () => {
    const root = tree({ [STORY_FILE]: STORY(`${FULL}2. [FR-CH-9999] [UC-PLUGIN-HOST-1001#7]\n   - Дано a\n`, '\nОткрыто: [UC-PLUGIN-HOST-1001#8] вопрос.\n') });
    assert.deepEqual(collect(root).problems, [
      'ST-1001/2: метка [FR-CH-9999] указывает на несуществующую норму',
      'ST-1001/2: метка [UC-PLUGIN-HOST-1001#7] указывает на несуществующую ветку сценария',
      'ST-1001: «Открыто» называет несуществующую ветку [UC-PLUGIN-HOST-1001#8]',
    ]);
  });

  it('критерий только с меткой ветки, без метки нормы, - находка', () => {
    const root = tree({ [STORY_FILE]: STORY(`${FULL}2. [UC-PLUGIN-HOST-1001#1]\n   - Дано a\n`) });
    assert.deepEqual(collect(root).problems, ['ST-1001/2: критерий без метки нормы (FR-CH-... или NFR-CH-...)']);
  });

  it('история без критериев и история вне блока своей фичи - находки', () => {
    const root = tree({ [STORY_FILE]: STORY(FULL).replace('ST-1001', 'ST-2001'), 'docs/03-requirements/01-plugin-host/stories/ST-1002-empty.md': STORY('').replace(/ST-1001/g, 'ST-1002') });
    const problems = collect(root).problems;
    assert.ok(problems.includes('ST-2001: номер вне блока фичи 01-plugin-host'), problems.join('\n'));
    assert.ok(problems.includes('ST-1002: нет ни одного критерия приёмки'), problems.join('\n'));
  });

  it('повтор идентификатора истории - находка', () => {
    const root = tree({ 'docs/03-requirements/01-plugin-host/stories/ST-1001-copy.md': STORY(FULL) });
    assert.ok(collect(root).problems.some((p) => p.startsWith('ST-1001: идентификатор истории повторяется')));
  });

  it('счётчик меньше наибольшего номера блока или отсутствует - находка', () => {
    assert.deepEqual(collect(tree({ 'docs/.req_counter/01.ST': '1000\n' })).problems, ['счётчик docs/.req_counter/01.ST равен 1000, а в блоке есть номер 1001']);
    const root = tree({});
    fs.rmSync(path.join(root, 'docs/.req_counter/01.UC'));
    assert.deepEqual(collect(root).problems, ['нет счётчика docs/.req_counter/01.UC, а в блоке есть номер 1001']);
  });
});

describe('collect: нераспознанное - находка, а не молчаливый пропуск (#212, P8)', () => {
  const SCENARIO_FILE = 'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md';

  it('расширение с латинской «a» вместо кириллической не пропадает из счёта', () => {
    const root = tree({ [SCENARIO_FILE]: SCENARIO.replace('- **1а. Плагин завис.**', '- **1a. Плагин завис.**') });
    const problems = collect(root).problems;
    assert.ok(
      problems.some((p) => p.startsWith('UC-PLUGIN-HOST-1001: строка расширения не распознана') && p.includes('1a.')),
      problems.join('\n'),
    );
  });

  it('шаг основного хода не вида «N. » - находка', () => {
    const root = tree({ [SCENARIO_FILE]: SCENARIO.replace('2. Хост ловит.', '2) Хост ловит.') });
    const problems = collect(root).problems;
    assert.ok(problems.some((p) => p.startsWith('UC-PLUGIN-HOST-1001: строка основного хода не распознана') && p.includes('2)')), problems.join('\n'));
  });

  it('файл сценария без слага в имени - находка', () => {
    const root = tree({ 'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1002.md': SCENARIO.replace(/1001/g, '1002') });
    const problems = collect(root).problems;
    assert.ok(problems.includes('docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1002.md: имя файла сценария не вида UC-<ФИЧА>-NNNN-<слаг>.md'), problems.join('\n'));
  });

  it('сценарий без разделов «Основной ход» и «Расширения» - находки, а не нуль веток', () => {
    const root = tree({ [SCENARIO_FILE]: '---\nid: UC-PLUGIN-HOST-1001\nfeature: 01-plugin-host\n---\n\n# Сбой плагина\n\n1. Плагин падает.\n' });
    const problems = collect(root).problems;
    assert.ok(problems.includes('UC-PLUGIN-HOST-1001: нет раздела «Основной ход» с шагами'), problems.join('\n'));
    assert.ok(problems.includes('UC-PLUGIN-HOST-1001: нет раздела «Расширения»'), problems.join('\n'));
  });

  it('заголовок нормы другого вида не пропускается', () => {
    for (const heading of ['### FR-CH-1002: Список', '## FR-CH-1002 Список', '#### NFR-CH-1002 Список', '### FR-CH-1002']) {
      const root = tree({ 'docs/03-requirements/01-plugin-host/srs.md': `${SRS}\n${heading}\n` });
      const problems = collect(root).problems;
      assert.ok(
        problems.some((p) => p.startsWith('docs/03-requirements/01-plugin-host/srs.md:') && p.includes('заголовок нормы не вида «### FR-CH-NNNN Название»')),
        `${heading}: ${problems.join('\n')}`,
      );
    }
  });

  it('фича без srs.md и файл вне схемы в stories - находки', () => {
    const root = tree({ 'docs/03-requirements/02-extension-contracts/stories/ST-2001-x.md': asStory(STORY(FULL), 'ST-2001', '02-extension-contracts'), 'docs/03-requirements/01-plugin-host/stories/notes.md': '# заметки\n' });
    const problems = collect(root).problems;
    assert.ok(problems.includes('docs/03-requirements/02-extension-contracts: нет srs.md'), problems.join('\n'));
    assert.ok(problems.includes('docs/03-requirements/01-plugin-host/stories/notes.md: имя файла истории не вида ST-NNNN-<слаг>.md'), problems.join('\n'));
  });

  it('строка критерия не из одних меток, пропуск или повтор номера - находки', () => {
    const root = tree({ [STORY_FILE]: STORY(`${FULL}2. [FR-CH-1001] текст после метки\n   - Дано a\n4. [FR-CH-1001]\n   - Дано b\n4. [FR-CH-1001]\n   - Дано c\n`) });
    const problems = collect(root).problems;
    assert.ok(problems.includes('ST-1001: строка критерия не распознана «2. [FR-CH-1001] текст после метки» (ждём «N. [метка] [метка]»)'), problems.join('\n'));
    assert.ok(problems.includes('ST-1001: номера критериев идут не подряд: после 1 стоит 4'), problems.join('\n'));
    assert.ok(problems.includes('ST-1001: номер критерия 4 повторяется'), problems.join('\n'));
  });

  it('файлы с CRLF разбираются так же, как с LF', () => {
    const files: Record<string, string> = {
      'docs/03-requirements/01-plugin-host/srs.md': SRS.replaceAll('\n', '\r\n'),
      'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md': SCENARIO.replaceAll('\n', '\r\n'),
      [STORY_FILE]: STORY(FULL, '\nОткрыто: [FR-CH-1001] вопрос.\n').replaceAll('\n', '\r\n'),
    };
    const report = collect(tree(files));
    assert.deepEqual(report.problems, []);
    assert.equal(report.scenarios[0]?.branches.length, 4);
    assert.equal(report.units.length, 2);
  });
});

describe('collect: строка «Открыто» (#212, P9)', () => {
  it('без метки ветки или нормы - находка', () => {
    const root = tree({ [STORY_FILE]: STORY(FULL, '\nОткрыто: норма отложена, вопрос 12.\n') });
    assert.deepEqual(collect(root).problems, ['ST-1001: «Открыто» без метки ветки [UC-...#N] или нормы [FR-CH-NNNN]']);
  });

  it('называет норму: она видна в таблице и не считается обычным покрытием; несуществующая норма - находка', () => {
    const root = tree({ [STORY_FILE]: STORY(FULL, '\nОткрыто: [NFR-CH-1001] отложена.\n') });
    const report = collect(root);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.stories[0]?.openUnits, ['NFR-CH-1001']);
    assert.match(renderCoverage(report), /\| NFR-CH-1001 \| 01-plugin-host \| Бюджет \| ST-1001\/1 \| {2}\| открыта \(ST-1001\) \|/);
    assert.match(renderCoverage(report), /норм 2 \(FR 1, NFR 1\), все дали критерий \(только целевое поведение: 0; открыто: 1\)/);
    const bad = tree({ [STORY_FILE]: STORY(FULL, '\nОткрыто: [FR-CH-9999] вопрос.\n') });
    assert.deepEqual(collect(bad).problems, ['ST-1001: «Открыто» называет несуществующую норму [FR-CH-9999]']);
  });
});

describe('collect: номер блока не из одной цифры (#212, P10)', () => {
  const SRS10 = '# SRS\n\n### FR-CH-10001 Десятая\n\n- **Требование:** x\n';
  const STORY10 = (id: string): string => `---\nlevel: story\nid: ${id}\nfeature: 10-tenth\n---\n\n# ${id} Десятая\n\n## Критерии приёмки\n\n1. [FR-CH-10001]\n   - Дано a\n`;
  const extra = (id: string, counter: string): Record<string, string> => ({
    'docs/03-requirements/10-tenth/srs.md': SRS10,
    [`docs/03-requirements/10-tenth/stories/${id}-x.md`]: STORY10(id),
    'docs/.req_counter/10.ST': counter,
  });

  it('история фичи 10 берёт блок «10», а не «1»: счётчик 10.ST сверяется', () => {
    assert.deepEqual(collect(tree(extra('ST-10001', '10001\n'))).problems, []);
    assert.deepEqual(collect(tree(extra('ST-10001', '10000\n'))).problems, ['счётчик docs/.req_counter/10.ST равен 10000, а в блоке есть номер 10001']);
  });

  it('история фичи 10 с номером из блока 1 - вне блока своей фичи', () => {
    const problems = collect(tree(extra('ST-1002', '10000\n'))).problems;
    assert.ok(problems.includes('ST-1002: номер вне блока фичи 10-tenth'), problems.join('\n'));
  });

  it('идентификатор истории не вида ST-<блок>NNN - находка', () => {
    const problems = collect(tree({ 'docs/03-requirements/01-plugin-host/stories/ST-101-x.md': asStory(STORY(FULL), 'ST-101', '01-plugin-host') })).problems;
    assert.ok(problems.includes('ST-101: идентификатор истории не вида ST-<блок фичи><NNN>'), problems.join('\n'));
  });

  it('сценарий с пятизначным номером находится и сверяется со счётчиком UC блока', () => {
    const uc = SCENARIO.replaceAll('1001', '10001').replace('feature: 01-plugin-host', 'feature: 10-tenth');
    const root = tree({
      'docs/02-use-cases/tenth/UC-PLUGIN-HOST-10001-tenth.md': uc,
      'docs/.req_counter/10.UC': '10000\n',
      'docs/03-requirements/10-tenth/srs.md': SRS10,
      'docs/03-requirements/10-tenth/stories/ST-10001-x.md': STORY10('ST-10001').replace('1. [FR-CH-10001]', '1. [FR-CH-10001] [UC-PLUGIN-HOST-10001#1] [UC-PLUGIN-HOST-10001#2] [UC-PLUGIN-HOST-10001#1а] [UC-PLUGIN-HOST-10001#1а1]'),
      'docs/.req_counter/10.ST': '10001\n',
    });
    assert.deepEqual(collect(root).problems, ['счётчик docs/.req_counter/10.UC равен 10000, а в блоке есть номер 10001']);
  });
});

describe('целевое поведение (#212, P3)', () => {
  const TARGET = FULL.replace('1. [FR-CH-1001]', '1. [целевое поведение] [FR-CH-1001]');

  it('метка не нужна нормой и не считается знакомой единицей; критерий без метки нормы всё равно находка', () => {
    assert.deepEqual(collect(tree({ [STORY_FILE]: STORY(TARGET) })).problems, []);
    const only = tree({ [STORY_FILE]: STORY(`${FULL}2. [целевое поведение]\n   - Дано a\n`) });
    assert.deepEqual(collect(only).problems, ['ST-1001/2: критерий без метки нормы (FR-CH-... или NFR-CH-...)']);
  });

  it('таблица разводит проверяемые критерии и целевое поведение; итог считает нормы и ветки только с целевым', () => {
    const text = renderCoverage(collect(tree({ [STORY_FILE]: STORY(TARGET.replace('[NFR-CH-1001] ', '')) })));
    assert.match(text, /\| Норма \| Фича \| Название \| Критерии \| Целевое поведение \| Открыто \|/);
    assert.match(text, /\| FR-CH-1001 \| 01-plugin-host \| Манифест \| {2}\| ST-1001\/1 \| {2}\|/);
    assert.match(text, /\| шаг 1 \| ST-1001\/1 \(целевое поведение\) \|/);
    assert.match(text, /только целевое поведение: 1; открыто: 0\); веток сценариев 4, покрыто 4 \(только целевое поведение: 4\), открыто 0/);
    const mixed = renderCoverage(collect(tree({ [STORY_FILE]: STORY(`${TARGET.replace('[NFR-CH-1001] ', '')}2. [FR-CH-1001] [UC-PLUGIN-HOST-1001#2]\n   - Дано a\n`) })));
    assert.match(mixed, /\| FR-CH-1001 \| 01-plugin-host \| Манифест \| ST-1001\/2 \| ST-1001\/1 \| {2}\|/);
    assert.match(mixed, /\| шаг 2 \| ST-1001\/1 \(целевое поведение\), ST-1001\/2 \|/);
    assert.match(mixed, /только целевое поведение: 0; открыто: 0\); веток сценариев 4, покрыто 4 \(только целевое поведение: 3\), открыто 0/);
  });
});

describe('сценарий и фичи критериев (#212, P11)', () => {
  it('сценарий без поля feature в шапке - находка', () => {
    const root = tree({ 'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md': SCENARIO.replace('feature: 01-plugin-host\n', '') });
    assert.deepEqual(collect(root).problems, ['UC-PLUGIN-HOST-1001: нет поля feature в шапке']);
  });

  it('критерий фичи, которой нет ни в feature, ни в touches сценария, - находка', () => {
    const scenario = SCENARIO;
    const other = asStory(STORY('1. [FR-CH-2001] [UC-PLUGIN-HOST-1001#1]\n   - Дано a\n'), 'ST-2001', '02-other');
    const root = tree({
      'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md': scenario,
      'docs/03-requirements/02-other/srs.md': SRS.replace('FR-CH-1001', 'FR-CH-2001').replace('NFR-CH-1001 Бюджет', 'NFR-CH-2001 Бюджет'),
      'docs/03-requirements/02-other/stories/ST-2001-x.md': other,
      'docs/.req_counter/02.ST': '2001\n',
    });
    const problems = collect(root).problems;
    assert.ok(problems.includes('UC-PLUGIN-HOST-1001: ST-2001/1 (фича 02-other) метит ветку #1, а фичи нет ни в feature, ни в touches сценария'), problems.join('\n'));
    const fixed = tree({
      'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md': scenario.replace('feature: 01-plugin-host\n', 'feature: 01-plugin-host\ntouches: 02-other\n'),
      'docs/03-requirements/02-other/srs.md': SRS.replace('FR-CH-1001', 'FR-CH-2001').replace('NFR-CH-1001 Бюджет', 'NFR-CH-2001 Бюджет'),
      'docs/03-requirements/02-other/stories/ST-2001-x.md': other,
      'docs/.req_counter/02.ST': '2001\n',
    });
    assert.ok(!collect(fixed).problems.some((p) => p.includes('touches')), collect(fixed).problems.join('\n'));
  });
});

describe('renderCoverage и main', () => {
  it('таблица называет критерии нормы и ветки, открытая ветка помечена', () => {
    const without = FULL.replace(' [UC-PLUGIN-HOST-1001#1а1]', '');
    const text = renderCoverage(collect(tree({ [STORY_FILE]: STORY(without, '\nОткрыто: [UC-PLUGIN-HOST-1001#1а1] вопрос.\n') })));
    assert.match(text, /\| FR-CH-1001 \| 01-plugin-host \| Манифест \| ST-1001\/1 \|/);
    assert.match(text, /\| шаг 1 \| ST-1001\/1 \|/);
    assert.match(text, /\| расширение 1а1 \| открыта \(ST-1001\) \|/);
    assert.match(text, /веток сценариев 4, покрыто 3 \(только целевое поведение: 0\), открыто 1/);
  });

  it('--write записывает таблицу, проверка принимает её и отвергает устаревшую; шапка файла сохраняется', () => {
    const root = tree({});
    assert.equal(main([], root).code, 1);
    assert.match(main([], root).err, /расходится с собранной таблицей/);
    assert.equal(main(['--write'], root).code, 0);
    const written = fs.readFileSync(path.join(root, 'docs/03-requirements/coverage.md'), 'utf8');
    assert.match(written, /^---\nlevel: coverage\n/);
    assert.equal(main([], root).code, 0);
    fs.writeFileSync(path.join(root, 'docs/03-requirements/coverage.md'), written.replace('date: 2026-11-10', 'date: 2027-01-01'));
    assert.equal(main([], root).code, 0, 'дата в шапке в сверке не участвует');
    fs.appendFileSync(path.join(root, 'docs/03-requirements/coverage.md'), '| лишнее |\n');
    assert.equal(main([], root).code, 1);
  });

  it('с находками --write ничего не пишет, код выхода 1 и список находок', () => {
    const root = tree({ [STORY_FILE]: STORY(FULL.replace('[FR-CH-1001] ', '')) });
    const result = main(['--write'], root);
    assert.equal(result.code, 1);
    assert.match(result.err, /FR-CH-1001: норма не дала ни одного критерия приёмки/);
    assert.equal(fs.existsSync(path.join(root, 'docs/03-requirements/coverage.md')), false);
  });
});

describe('документы репозитория', () => {
  it('нормы, ветки сценариев и критерии историй сходятся, таблица покрытия собрана', () => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    const result = main([], repo);
    assert.equal(result.code, 0, result.err);
    const report = collect(repo);
    assert.ok(report.units.length > 100 && report.stories.length > 30, `норм ${String(report.units.length)}, историй ${String(report.stories.length)}`);
  });
});
