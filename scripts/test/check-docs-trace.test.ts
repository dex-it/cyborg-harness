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
const SCENARIO = '---\nid: UC-PLUGIN-HOST-1001\n---\n\n# Сбой плагина\n\n## Основной ход\n\n1. Плагин падает.\n2. Хост ловит.\n\n## Расширения\n\n- **1а. Плагин завис.** Сторож.\n- **1а1. Три раза подряд.** Выключен.\n\n## Постусловия\n\n3. не ветка\n';
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

describe('renderCoverage и main', () => {
  it('таблица называет критерии нормы и ветки, открытая ветка помечена', () => {
    const without = FULL.replace(' [UC-PLUGIN-HOST-1001#1а1]', '');
    const text = renderCoverage(collect(tree({ [STORY_FILE]: STORY(without, '\nОткрыто: [UC-PLUGIN-HOST-1001#1а1] вопрос.\n') })));
    assert.match(text, /\| FR-CH-1001 \| 01-plugin-host \| Манифест \| ST-1001\/1 \|/);
    assert.match(text, /\| шаг 1 \| ST-1001\/1 \|/);
    assert.match(text, /\| расширение 1а1 \| открыта \(ST-1001\) \|/);
    assert.match(text, /веток сценариев 4, покрыто 3, открыто 1/);
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
