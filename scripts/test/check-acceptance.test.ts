import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { collectAcceptance, main, readExceptions, renderMatrix, scanSource } from '../check-acceptance.ts';
import { acceptanceFiles } from '../test-acceptance.ts';

// #230: связь «критерий -> тест». Деревья-образцы собираются во временном каталоге; вызовы тестов в исходниках-образцах строятся через `call`,
// чтобы сам этот файл не содержал литералов вида «it('ST-...')», которые скрипт принял бы за разметку.
const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const call = (fn: string, name: string, options = ''): string => `${fn}(${JSON.stringify(name)}${options}, () => {});\n`;

const SRS = '# SRS\n\n### FR-CH-1001 Манифест\n\n- **Требование:** x\n';
const SCENARIO = '---\nid: UC-PLUGIN-HOST-1001\nfeature: 01-plugin-host\n---\n\n# Сбой\n\n## Основной ход\n\n1. Плагин падает.\n\n## Расширения\n\n- **1а. Завис.** Сторож.\n';
const CRITERIA = ['1. [FR-CH-1001] [UC-PLUGIN-HOST-1001#1]', '2. [FR-CH-1001] [UC-PLUGIN-HOST-1001#1а]', '3. [целевое поведение] [FR-CH-1001]'].map((c) => `${c}\n   - Дано a\n   - Когда b\n   - Тогда c\n`).join('');
const STORY = `---\nlevel: story\nid: ST-1001\nfeature: 01-plugin-host\n---\n\n# ST-1001 Сбой остаётся у плагина\n\n## Критерии приёмки\n\n${CRITERIA}`;
const TABLE = (...rows: string[]): string => `# Исключения\n\n| Критерий | Категория | Причина |\n|---|---|---|\n${rows.join('\n')}\n`;

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-acceptance-'));
  roots.push(root);
  const base: Record<string, string> = {
    'docs/03-requirements/01-plugin-host/srs.md': SRS,
    'docs/02-use-cases/plugin-host/UC-PLUGIN-HOST-1001-plugin-failure.md': SCENARIO,
    'docs/03-requirements/01-plugin-host/stories/ST-1001-failure.md': STORY,
    'docs/.req_counter/01.ST': '1001\n',
    'docs/.req_counter/01.UC': '1001\n',
    'docs/05-verification/acceptance.md': TABLE(),
  };
  for (const [name, text] of Object.entries({ ...base, ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

describe('scanSource: имена тестов с ключом', () => {
  it('находит ключи в test, it и describe, с кавычками трёх видов и переносом строки после скобки', () => {
    const text = [call('describe', 'ST-1001/1: группа'), call('it', 'ST-1001/2 и ST-1001/3: два ключа'), "test(\n  `ST-1002/4: шаблон`, () => {});\n", "test('без ключа', () => {});\n"].join('');
    const refs = scanSource('x.test.ts', text);
    assert.deepEqual(
      refs.map((r) => [r.kind, r.line, r.keys.join(' ')]),
      [
        ['describe', 1, 'ST-1001/1'],
        ['test', 2, 'ST-1001/2 ST-1001/3'],
        ['test', 3, 'ST-1002/4'],
        ['test', 5, ''],
      ],
    );
  });

  it('skip, todo и параметры skip: true отключают тест; условный skip не отключает; закомментированный вызов не считается', () => {
    const text = [call('it.skip', 'ST-1001/1: a'), call('test.todo', 'ST-1001/2: b'), call('it', 'ST-1001/3: c', ', { skip: true }'), call('it', 'ST-1001/4: d', ", { skip: process.platform === 'win32' }"), '// ' + call('it', 'ST-1001/5: e')].join('');
    assert.deepEqual(
      scanSource('x.test.ts', text).map((r) => [r.keys.join(), r.disabled]),
      [
        ['ST-1001/1', true],
        ['ST-1001/2', true],
        ['ST-1001/3', true],
        ['ST-1001/4', false],
      ],
    );
  });

  it('ключ в строке-аргументе, а не в имени вызова, не считается', () => {
    assert.deepEqual(scanSource('x.test.ts', "assert.equal(problems[0], 'ST-1001/2: метка');\n").length, 0);
  });
});

describe('readExceptions: таблица исключений', () => {
  it('читает строки, пропускает пояснения, ловит неизвестную категорию, короткую причину и повтор', () => {
    const { rows, problems } = readExceptions(
      TABLE('| ST-1001/1 | окно | Окно вне охвата, смотреть smoke |', '| ST-1001/2 | ручная, дефект #?  | Ядро не снимает подписку при выходе |', '| ST-1001/1 | окно | Окно вне охвата, второй раз |', '| ST-1001/3 | прочее | Причина достаточно длинная |', '| ST-1001/4 | окно | мало |'),
    );
    assert.deepEqual(
      rows.map((r) => r.key),
      ['ST-1001/1', 'ST-1001/2', 'ST-1001/1', 'ST-1001/3', 'ST-1001/4'],
    );
    assert.equal(problems.length, 3);
    assert.match(problems.join('\n'), /повторяет строку 5/);
    assert.match(problems.join('\n'), /неизвестная категория «прочее»/);
    assert.match(problems.join('\n'), /короче 10 знаков/);
  });

  it('строка с ключом не того вида - находка, а не молчаливый пропуск', () => {
    assert.match(readExceptions(TABLE('| ST-1001 | окно | причина причина |')).problems.join(), /не вида/);
  });
});

describe('collectAcceptance: исходы критериев', () => {
  const test1 = { 'core/test/a.test.ts': call('it', 'ST-1001/1: первый') };

  it('тест с ключом или исключение закрывают критерий, целевое поведение не требует ничего', () => {
    const root = tree({ ...test1, 'docs/05-verification/acceptance.md': TABLE('| ST-1001/2 | окно | Окно вне охвата, смотреть smoke |') });
    const report = collectAcceptance(root);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(
      report.rows.map((r) => r.outcome),
      ['тест', 'исключение', 'целевое поведение'],
    );
  });

  it('критерий без теста и исключения - находка', () => {
    assert.deepEqual(collectAcceptance(tree({})).problems, [
      'ST-1001/1: нет теста с ключом в имени и нет исключения в docs/05-verification/acceptance.md',
      'ST-1001/2: нет теста с ключом в имени и нет исключения в docs/05-verification/acceptance.md',
    ]);
  });

  it('и тест, и исключение у одного критерия - находка', () => {
    const root = tree({ ...test1, 'core/test/b.test.ts': call('it', 'ST-1001/2: второй'), 'docs/05-verification/acceptance.md': TABLE('| ST-1001/1 | окно | Окно вне охвата, смотреть smoke |') });
    assert.match(collectAcceptance(root).problems.join('\n'), /ST-1001\/1: и тест с ключом \(core\/test\/a\.test\.ts\), и исключение/);
  });

  it('ключ несуществующего критерия, отключённый тест, исключение для целевого поведения и для несуществующего критерия - находки', () => {
    const root = tree({
      'core/test/a.test.ts': call('it', 'ST-1001/1: первый') + call('it', 'ST-1001/2: второй', ', { skip: true }') + call('it', 'ST-1001/9: нет такого') + call('it', 'ST-1001/3: целевое'),
      'docs/05-verification/acceptance.md': TABLE('| ST-1001/2 | окно | Окно вне охвата, смотреть smoke |', '| ST-1001/3 | окно | Окно вне охвата, смотреть smoke |', '| ST-1001/8 | окно | Окно вне охвата, смотреть smoke |'),
    });
    const text = collectAcceptance(root).problems.join('\n');
    assert.match(text, /core\/test\/a\.test\.ts:3: ключ ST-1001\/9 указывает на несуществующий критерий/);
    assert.match(text, /a\.test\.ts:2: тест с ключом ST-1001\/2 отключён/);
    assert.match(text, /ST-1001\/3: критерий на целевое поведение с тестом/);
    assert.match(text, /acceptance\.md:6: ST-1001\/3: исключение для критерия на целевое поведение не нужно/);
    assert.match(text, /acceptance\.md:7: ST-1001\/8: исключение указывает на несуществующий критерий/);
  });

  it('ключ в describe критерий не закрывает: засчитываются только test и it', () => {
    const root = tree({ 'core/test/a.test.ts': call('describe', 'ST-1001/1: группа') + call('it', 'ST-1001/2: второй') });
    assert.deepEqual(collectAcceptance(root).problems, ['ST-1001/1: нет теста с ключом в имени и нет исключения в docs/05-verification/acceptance.md']);
  });

  it('node_modules, dist и docs обход не заходит', () => {
    const root = tree({ ...test1, 'node_modules/x/a.test.ts': call('it', 'ST-9999/1: чужой'), 'core/dist/a.test.ts': call('it', 'ST-9999/2: сборка'), 'docs/a.test.ts': call('it', 'ST-9999/3: документ'), 'docs/05-verification/acceptance.md': TABLE('| ST-1001/2 | окно | Окно вне охвата, смотреть smoke |') });
    assert.deepEqual(collectAcceptance(root).problems, []);
  });
});

describe('main: таблица покрытия и код выхода', () => {
  const closed = { 'core/test/a.test.ts': call('it', 'ST-1001/1: первый') + call('it', 'ST-1001/1: ещё раз'), 'docs/05-verification/acceptance.md': TABLE('| ST-1001/2 | ручная, дефект #?  | Ядро не снимает подписку при выходе |') };

  it('без таблицы - код 1 с подсказкой; --write пишет её, затем проверка зелёная и называет исходы', () => {
    const root = tree(closed);
    assert.equal(main([], root).code, 1);
    assert.match(main([], root).err, /acceptance-coverage\.md расходится/);
    assert.equal(main(['--write'], root).code, 0);
    const result = main([], root);
    assert.equal(result.code, 0);
    assert.match(result.out, /критериев 3: тест 1, исключение 1, целевое поведение 1; дефектов без номера задачи: 1/);
    const matrix = fs.readFileSync(path.join(root, 'docs/05-verification/acceptance-coverage.md'), 'utf8');
    assert.match(matrix, /^---\nlevel: coverage/);
    assert.match(matrix, /Итог: историй 1, критериев 3: тест 1 \(тестов с ключом 2\), исключение 1, целевое поведение 1\./);
    assert.match(matrix, /\| ST-1001\/1 \| тест \| core\/test\/a\.test\.ts \(2\) \|/);
    assert.match(matrix, /\| ST-1001\/2 \| исключение \| ручная, дефект #\? \|/);
    assert.match(matrix, /Исключения по категориям: ручная, дефект 1\./);
  });

  it('новая правка теста делает таблицу устаревшей; дата в шапке в сверке не участвует', () => {
    const root = tree(closed);
    main(['--write'], root);
    const file = path.join(root, 'docs/05-verification/acceptance-coverage.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('date: 2026-11-12', 'date: 2030-01-01'));
    assert.equal(main([], root).code, 0);
    fs.writeFileSync(path.join(root, 'core/test/c.test.ts'), call('it', 'ST-1001/1: третий'));
    assert.equal(main([], root).code, 1);
  });

  it('находки печатаются списком, таблица при этом не проверяется', () => {
    const result = main([], tree({}));
    assert.equal(result.code, 1);
    assert.match(result.err, /^находок: 2\n/);
  });

  it('renderMatrix без исходов «нет» не пишет «без исхода»', () => {
    assert.doesNotMatch(renderMatrix(collectAcceptance(tree(closed))), /без исхода/);
  });
});

describe('acceptanceFiles: файлы для test:acceptance', () => {
  it('только файлы с включёнными тестами с ключом, без повторов; describe, skip и тесты без ключа файл не называют', () => {
    const root = tree({
      'core/test/a.test.ts': call('it', 'ST-1001/1: первый') + call('it', 'ST-1001/1: второй'),
      'core/test/b.test.ts': call('describe', 'ST-1001/2: группа'),
      'core/test/c.test.ts': call('it', 'ST-1001/2: отключён', ', { skip: true }'),
      'core/test/d.test.ts': call('it', 'без ключа'),
    });
    assert.deepEqual(acceptanceFiles(root), ['core/test/a.test.ts']);
  });
});
