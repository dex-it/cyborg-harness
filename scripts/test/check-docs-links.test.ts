import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkLinks, extractLinks, headingAnchors, main, slugify } from '../check-docs-links.ts';

// P-10: проверка относительных ссылок и якорей в docs/. Деревья-образцы собираются во временном каталоге.
const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-links-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

const reasons = (root: string, paths: string[] = ['docs']): string[] => checkLinks(root, paths).problems.map((p) => `${p.file}:${String(p.line)} ${p.link}`);

describe('slugify: якорь заголовка как у GitHub', () => {
  it('нижний регистр, пробелы в дефисы, знаки препинания убраны, кириллица остаётся', () => {
    assert.equal(slugify('3.1. Воркспейс как главная сессия'), '31-воркспейс-как-главная-сессия');
    assert.equal(slugify('Пакет контрактов: поставка и версии'), 'пакет-контрактов-поставка-и-версии');
    assert.equal(slugify('NFR-CH-1001 Накладные расходы'), 'nfr-ch-1001-накладные-расходы');
  });

  it('код в обратных кавычках даёт текст, в том числе угловые скобки внутри него', () => {
    assert.equal(slugify('3. Замеры: окно, `<iframe>` и мост'), '3-замеры-окно-iframe-и-мост');
    assert.equal(slugify('Метод `ctx.os.fs`'), 'метод-ctxosfs');
  });

  it('ссылка в заголовке даёт свой текст, разметка выделения и теги пропадают', () => {
    assert.equal(slugify('См. [SAD](sad.md) и **важное**'), 'см-sad-и-важное');
    assert.equal(slugify('Тег <b>жирный</b>'), 'тег-жирный');
  });
});

describe('headingAnchors', () => {
  it('повторные заголовки получают суффиксы -1, -2', () => {
    assert.deepEqual([...headingAnchors('# Итог\n\n## Итог\n\n## Итог\n')], ['итог', 'итог-1', 'итог-2']);
  });

  it('заголовки в блоке кода и в front matter якорей не дают', () => {
    const text = '---\ntitle: x\n# не заголовок\n---\n\n# Настоящий\n\n```md\n# В коде\n```\n';
    assert.deepEqual([...headingAnchors(text)], ['настоящий']);
  });

  it('id и name в HTML и {#свой-якорь} считаются якорями', () => {
    const text = '<a id="ручной"></a>\n<a name="old-name"></a>\n\n## Заголовок {#custom}\n';
    assert.deepEqual([...headingAnchors(text)].sort(), ['custom', 'old-name', 'ручной']);
  });
});

describe('extractLinks', () => {
  it('ссылки, изображения, ссылки-определения и href; код пропускается', () => {
    const text = [
      'Строка [один](a.md) и ![рисунок](img/x.png "подпись").',
      '`[в коде](нет.md)` и [два](<с пробелом.md#якорь>).',
      '[метка]: ./ref.md',
      '<a href="html.md#h">html</a>',
      '```',
      '[в блоке](нет.md)',
      '```',
    ].join('\n');
    assert.deepEqual(
      extractLinks(text).map((l) => [l.line, l.target]),
      [
        [1, 'a.md'],
        [1, 'img/x.png'],
        [2, 'с пробелом.md#якорь'],
        [3, './ref.md'],
        [4, 'html.md#h'],
      ],
    );
  });
});

describe('checkLinks', () => {
  it('рабочие ссылки на файл, каталог, заголовок и заголовок в другом файле проходят', () => {
    const root = tree({
      'docs/a.md': '# А\n\n## Раздел один\n\n[b](b.md) [c](sub/) [x](#раздел-один) [y](sub/c.md#вложенный) [z](b.md#%D0%B8%D1%82%D0%BE%D0%B3)\n',
      'docs/b.md': '# Б\n\n## Итог\n',
      'docs/sub/c.md': '# С\n\n## Вложенный\n',
    });
    const report = checkLinks(root, ['docs']);
    assert.deepEqual(report.problems, []);
    assert.equal(report.files, 3);
    assert.equal(report.links, 5);
  });

  it('несуществующий путь - ошибка со строкой и ссылкой', () => {
    const root = tree({ 'docs/a.md': 'Текст\n\n[битая](missing.md)\n' });
    assert.deepEqual(reasons(root), ['docs/a.md:3 missing.md']);
    assert.match(checkLinks(root, ['docs']).problems[0]?.reason ?? '', /нет такого пути: docs\/missing\.md/);
  });

  it('несуществующий якорь в существующем файле - ошибка, в том числе в своём файле', () => {
    const root = tree({ 'docs/a.md': '# А\n\n[нет](b.md#нет-такого) [сам](#нет-здесь)\n', 'docs/b.md': '# Б\n' });
    assert.deepEqual(reasons(root), ['docs/a.md:3 b.md#нет-такого', 'docs/a.md:3 #нет-здесь']);
  });

  it('регистр имени файла сверяется точно: на macOS работает, на Linux и GitHub нет', () => {
    const root = tree({ 'docs/a.md': '[b](B.md)\n', 'docs/b.md': '# Б\n' });
    assert.deepEqual(reasons(root), ['docs/a.md:1 B.md']);
  });

  it('внешние адреса, mailto, абсолютные пути сайта и ссылки в коде не проверяются', () => {
    const root = tree({
      'docs/a.md': '[1](https://example.com/x) [2](mailto:a@b.c) [3](/development/tests-ci/) [4](//cdn/x.js) `[5](нет.md)`\n',
    });
    const report = checkLinks(root, ['docs']);
    assert.deepEqual(report.problems, []);
    assert.equal(report.links, 0);
  });

  it('якорь на файл не из Markdown (номер строки кода) не проверяется, путь проверяется', () => {
    const root = tree({ 'docs/a.md': '[код](../core/x.ts#L10) [нет](../core/y.ts#L10)\n', 'core/x.ts': 'export {};\n' });
    assert.deepEqual(reasons(root), ['docs/a.md:1 ../core/y.ts#L10']);
  });

  it('ссылка вне docs (корень репозитория) проверяется по диску', () => {
    const root = tree({ 'docs/a.md': '[рид](../README.md#установка)\n', 'README.md': '# Проект\n\n## Установка\n' });
    assert.deepEqual(reasons(root), []);
  });
});

describe('main: код выхода и вывод', () => {
  it('чистое дерево - код 0 и счётчики', () => {
    const root = tree({ 'docs/a.md': '[b](b.md)\n', 'docs/b.md': '# Б\n' });
    const result = main([], root);
    assert.equal(result.code, 0);
    assert.match(result.out, /ссылки в порядке: файлов 2, относительных ссылок 1/);
  });

  it('битая ссылка - код 1 и строка «файл:строка: [ссылка] причина»', () => {
    const root = tree({ 'docs/a.md': '[b](нет.md#x)\n' });
    const result = main(['docs'], root);
    assert.equal(result.code, 1);
    assert.match(result.err, /битых ссылок: 1 из 1/);
    assert.match(result.err, /docs\/a\.md:1: \[нет\.md#x\] нет такого пути: docs\/нет\.md/);
  });
});

describe('документы репозитория', () => {
  it('ссылки и якоря в docs/ и README.md целы', () => {
    const repo = path.resolve(import.meta.dirname, '..', '..');
    const report = checkLinks(repo, ['docs', 'README.md']);
    assert.deepEqual(
      report.problems.map((p) => `${p.file}:${String(p.line)} [${p.link}] ${p.reason}`),
      [],
    );
    assert.ok(report.links > 1000, `проверено ссылок: ${String(report.links)}`);
  });
});
