import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { collectAcceptance, main, parseExceptions, scanTests } from '../check-acceptance.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SRS = '# SRS\n\n### FR-CH-1001 Манифест\n\n- **Требование:** x\n';
const SCENARIO = '---\nid: UC-PLUGIN-HOST-1001\nfeature: 01-plugin-host\n---\n\n# Сбой плагина\n\n## Основной ход\n\n1. Плагин падает.\n';
const CRITERION = (n: number, extra = ''): string => `${String(n)}. ${extra}[FR-CH-1001] [UC-PLUGIN-HOST-1001#1]\n   - Дано плагин\n   - Когда падает\n   - Тогда окно живо\n`;
const STORY = `---\nlevel: story\nid: ST-1001\nfeature: 01-plugin-host\n---\n\n# ST-1001 Сбой\n\n## Критерии приёмки\n\n${CRITERION(1)}${CRITERION(2)}${CRITERION(3, '[целевое поведение] ')}`;
const ACCEPTANCE = 'docs/05-verification/acceptance.md';
const TEST = 'core/test/loader.test.ts';
const EXCEPTIONS = (rows: string, parts = ''): string =>
  `# Приёмка\n\n## Исключения\n\n| Критерий | Причина | Где проверяется |\n|---|---|---|\n${rows}\n## Части вне тестов\n\n| Критерий | Причина | Где проверяется |\n|---|---|---|\n${parts}\n## Дальше\n\n| ST-1001/9 | не исключение | - |\n`;

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-acceptance-'));
  roots.push(root);
  const base: Record<string, string> = {
    'docs/03-requirements/01-plugin-host/srs.md': SRS,
    'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure.md': SCENARIO,
    'docs/03-requirements/01-plugin-host/stories/ST-1001-failure.md': STORY,
    'docs/.req_counter/01.ST': '1001\n',
    'docs/.req_counter/01.UC': '1001\n',
    [TEST]: "test('ST-1001/1: ловит сбой', () => {});\n",
    [ACCEPTANCE]: EXCEPTIONS('| ST-1001/2 | окно | `npm run smoke` |\n'),
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

describe('scanTests: ключи в именах тестов', () => {
  it('берёт ключи из первого аргумента test, it и describe, несколько ключей через запятую', () => {
    const text = "describe('ST-1001/1: блок', () => {\n  it(\"ST-1001/2, ST-1002/3: тест\", () => {});\n  test(`ST-1003/4 шаблон`, () => {});\n});\n";
    assert.deepEqual(
      scanTests(text, 'a.test.ts').map((k) => k.key),
      ['ST-1001/1', 'ST-1001/2', 'ST-1002/3', 'ST-1003/4'],
    );
  });

  it('ключ вне имени теста не считается', () => {
    const text = "// ST-1001/1\nconst x = 'ST-1001/2';\ntest('без ключа', () => { assert.equal(x, 'ST-1001/3'); });\n";
    assert.deepEqual(scanTests(text, 'a.test.ts'), []);
  });

  it('закомментированный вызов и метод .test() у выражения (регулярное выражение, KEY.test) тестом не считаются', () => {
    const text = [
      "// test('ST-1001/1: закомментирован', () => {});",
      " * it('ST-1001/2: в блочном комментарии', () => {});",
      "const ok = /x/.test('ST-1001/3: регулярное выражение');",
      "KEY.test('ST-1001/4: метод');",
      "test('ST-1001/5: настоящий', () => {});",
    ].join('\n');
    assert.deepEqual(
      scanTests(text, 'a.test.ts').map((k) => k.key),
      ['ST-1001/5'],
    );
  });

  it('skip и todo в параметрах теста помечают его пропущенным; условный skip - нет', () => {
    const text = [
      "test('ST-1001/1: a', { skip: true }, () => {});",
      "it('ST-1001/2: b', { todo: 'позже' }, () => {});",
      "it('ST-1001/3: c', { skip: process.platform === 'win32' }, () => {});",
      "test('ST-1001/4: d', { timeout: 5 }, () => {});",
    ].join('\n');
    assert.deepEqual(
      scanTests(text, 'a.test.ts').map((k) => k.skipped),
      [true, true, false, false],
    );
  });

  it('ключ на .skip и .todo помечен пропущенным, на .only - нет', () => {
    const text = "test.skip('ST-1001/1: a', () => {});\nit.todo('ST-1001/2: b');\ntest.only('ST-1001/3: c', () => {});\n";
    assert.deepEqual(
      scanTests(text, 'a.test.ts').map((k) => k.skipped),
      [true, true, false],
    );
  });
});

describe('parseExceptions: таблица исключений', () => {
  it('читает только раздел «Исключения», несколько ключей в ячейке', () => {
    const parsed = parseExceptions(EXCEPTIONS('| ST-1001/1, ST-1001/2 | этап 2 | SAD §9 |\n'));
    assert.deepEqual(
      parsed.items.map((e) => [e.key, e.reason, e.where]),
      [
        ['ST-1001/1', 'этап 2', 'SAD §9'],
        ['ST-1001/2', 'этап 2', 'SAD §9'],
      ],
    );
    assert.deepEqual(parsed.problems, []);
  });

  it('причина не из списка, пустое «где» и строка без ключа - находки', () => {
    const parsed = parseExceptions(EXCEPTIONS('| ST-1001/1 | лень | x |\n| ST-1001/2 | окно |  |\n| ST-1001 | окно | x |\n'));
    assert.equal(parsed.problems.length, 3);
    assert.match(parsed.problems[0] ?? '', /причина «лень» не из списка/);
    assert.match(parsed.problems[1] ?? '', /не сказано, где проверяется/);
    assert.match(parsed.problems[2] ?? '', /без ключа/);
  });
});

describe('collectAcceptance: находки', () => {
  it('тест, исключение и целевое поведение закрывают все критерии', () => {
    const report = collectAcceptance(tree({}));
    assert.deepEqual(report.problems, []);
    assert.deepEqual([...report.tests.keys()], ['ST-1001/1']);
    assert.deepEqual([...report.exceptions.keys()], ['ST-1001/2']);
  });

  it('критерий без теста и исключения - находка с ключом', () => {
    const report = collectAcceptance(tree({ [TEST]: "test('без ключа', () => {});\n" }));
    assert.deepEqual(report.problems, [`ST-1001/1: нет ни теста с ключом в имени, ни исключения в ${ACCEPTANCE}`]);
  });

  it('висячий ключ в тесте и в исключении - находки', () => {
    const report = collectAcceptance(tree({ [TEST]: "test('ST-1001/1, ST-1001/99: x', () => {});\n", [ACCEPTANCE]: EXCEPTIONS('| ST-1001/2 | окно | smoke |\n| ST-2001/1 | окно | smoke |\n') }));
    assert.deepEqual(report.problems, [`${TEST}: ключ ST-1001/99 - такого критерия нет`, `${ACCEPTANCE}: Исключения: ST-2001/1 - такого критерия нет`]);
  });

  it('тест и исключение на одном критерии - находка', () => {
    const report = collectAcceptance(tree({ [TEST]: "test('ST-1001/1, ST-1001/2: x', () => {});\n" }));
    assert.deepEqual(report.problems, ['ST-1001/2: есть и тест, и исключение - оставьте одно']);
  });

  it('проверка на критерии целевого поведения - находка', () => {
    const report = collectAcceptance(tree({ [TEST]: "test('ST-1001/1, ST-1001/3: x', () => {});\n" }));
    assert.match(report.problems.join('\n'), /ST-1001\/3: критерий помечен \[целевое поведение\]/);
  });

  it('часть вне тестов требует теста с ключом и попадает в матрицу рядом с ним', () => {
    const ok = tree({ [ACCEPTANCE]: EXCEPTIONS('| ST-1001/2 | окно | smoke |\n', '| ST-1001/1 | замер | `npm run spike:hosts` |\n') });
    assert.deepEqual(collectAcceptance(ok).problems, []);
    assert.equal(main(['--write'], ok).code, 0);
    assert.match(fs.readFileSync(path.join(ok, 'docs/05-verification/acceptance-coverage.md'), 'utf8'), /\| ST-1001\/1 \| `core\/test\/loader\.test\.ts`; часть - замер: `npm run spike:hosts` \|/);
    const bad = collectAcceptance(tree({ [ACCEPTANCE]: EXCEPTIONS('| ST-1001/2 | окно | smoke |\n', '| ST-1001/2 | окно | smoke |\n') }));
    assert.deepEqual(bad.problems, ['ST-1001/2: часть вне тестов записана, а теста с ключом нет - запишите критерий в «Исключения»']);
  });

  it('ключ на пропущенном тесте не закрывает критерий', () => {
    const report = collectAcceptance(tree({ [TEST]: "test.skip('ST-1001/1: x', () => {});\n" }));
    assert.deepEqual(report.problems, [`${TEST}: ключ ST-1001/1 стоит на пропущенном тесте (.skip или .todo)`, `ST-1001/1: нет ни теста с ключом в имени, ни исключения в ${ACCEPTANCE}`]);
  });

  it('тесты в node_modules, dist и fixtures не читаются', () => {
    const report = collectAcceptance(tree({ 'core/test/fixtures/x.test.ts': "test('ST-1001/99: x', () => {});\n", 'tools/cyborg-plugin/node_modules/y.test.ts': "test('ST-1001/99: y', () => {});\n" }));
    assert.deepEqual(report.problems, []);
  });
});

describe('main: матрица приёмки', () => {
  it('--write собирает матрицу, проверка без флага сверяет её и падает на расхождении', () => {
    const root = tree({});
    const matrix = path.join(root, 'docs/05-verification/acceptance-coverage.md');
    assert.equal(main([], root).code, 1);
    assert.equal(main(['--write'], root).code, 0);
    const text = fs.readFileSync(matrix, 'utf8');
    assert.match(text, /^---\nlevel: verification\n/);
    assert.match(text, /\| ST-1001\/1 \| `core\/test\/loader\.test\.ts` \|/);
    assert.match(text, /\| ST-1001\/2 \| окно: `npm run smoke` \|/);
    assert.match(text, /\| ST-1001\/3 \| целевое поведение \|/);
    assert.equal(main([], root).code, 0);
    fs.writeFileSync(matrix, text.replace('ST-1001/3 | целевое', 'ST-1001/3 | руками'));
    assert.match(main([], root).err, /расходится с собранной матрицей/);
  });

  it('при находках матрица не пишется', () => {
    const root = tree({ [TEST]: "test('x', () => {});\n" });
    const result = main(['--write'], root);
    assert.equal(result.code, 1);
    assert.equal(fs.existsSync(path.join(root, 'docs/05-verification/acceptance-coverage.md')), false);
  });
});
