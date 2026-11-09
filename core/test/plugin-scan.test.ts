import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { COMPUTED, declarationProblems, UNREADABLE, usesOf } from '../src/plugin-scan.ts';
import { declarationLines, usesOf as oracle } from './imports.ts';

// P-09: разбор импортов без компилятора. Образец - TypeScript (core/test/imports.ts): на всём коде репозитория разбор ядра должен дать то же, что компилятор.
const repo = path.resolve(import.meta.dirname, '..', '..');
const CONTRACTS = '@cyborg-harness/contracts';
const specs = (text: string) => usesOf(text).map((u) => u.spec);

function corpus(): string[] {
  const roots = ['core/src', 'core/test', 'core/examples', 'core/elements', 'playground/src', 'playground/plugins', 'playground/scripts', 'contracts'];
  return roots.flatMap((r) =>
    fs
      .readdirSync(path.join(repo, r), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(m|c)?[tj]s$/.test(f) && !f.endsWith('.d.ts') && !f.includes('node_modules') && !f.includes('dist' + path.sep))
      .map((f) => path.join(repo, r, f)),
  );
}

describe('разбор импортов: сверка с компилятором', () => {
  it('на всех исходниках репозитория совпадает с TypeScript (спецификатор, строка, только-типы)', () => {
    const files = corpus();
    assert.ok(files.length > 150, `файлов в выборке: ${files.length}`);
    let total = 0;
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const want = oracle(file, text).map((u) => `${u.line} ${u.spec} ${u.typeOnly}`);
      const got = usesOf(text).map((u) => `${u.line} ${u.spec} ${u.typeOnly}`);
      assert.deepEqual(got, want, path.relative(repo, file));
      total += want.length;
    }
    assert.ok(total > 500, `использований в выборке: ${total}`);
  });

  it('пакеты объявлений: операторы с кодом те же, что видит компилятор', () => {
    for (const rel of ['core/examples/contracts.ts', 'playground/plugins/contracts.ts', 'contracts/index.ts']) {
      const file = path.join(repo, rel);
      assert.ok(fs.existsSync(file), rel);
      const text = fs.readFileSync(file, 'utf8');
      assert.deepEqual(declarationProblems(text, CONTRACTS), declarationLines(file, text, CONTRACTS), rel);
    }
  });
});

describe('разбор импортов: формы', () => {
  it('все формы загрузки модуля', () => {
    const text = [
      "import a from 'a1';",
      "import { b } from 'a2';",
      "import * as c from 'a3';",
      "import d, { e } from 'a4';",
      "import 'a5';",
      "export * from 'a6';",
      "export * as f from 'a7';",
      "export { g } from 'a8';",
      "const h = await import('a9');",
      "const i = require('a10');",
      "import j = require('a11');",
      "type K = import('a12').K;",
      "export type { L } from 'a13';",
      'import {',
      '  m,',
      "} from 'a14';",
    ].join('\n');
    assert.deepEqual(
      usesOf(text).map((u) => `${u.line}:${u.spec}`),
      ['1:a1', '2:a2', '3:a3', '4:a4', '5:a5', '6:a6', '7:a7', '8:a8', '9:a9', '10:a10', '11:a11', '12:a12', '13:a13', '14:a14'],
    );
  });

  it('только типы: import type, export type, все элементы с type; значение по умолчанию и смешанное - нет', () => {
    const only = (t: string) => usesOf(t).map((u) => u.typeOnly);
    assert.deepEqual(only("import type { A } from 'x';"), [true]);
    assert.deepEqual(only("import type A from 'x';"), [true]);
    assert.deepEqual(only("import type * as A from 'x';"), [true]);
    assert.deepEqual(only("import { type A, type B } from 'x';"), [true]);
    assert.deepEqual(only("import { type A, B } from 'x';"), [false]);
    assert.deepEqual(only("import A, { type B } from 'x';"), [false]);
    assert.deepEqual(only("import { type as x } from 'x';"), [false], 'неоднозначное считается значением');
    assert.deepEqual(only("import type from 'x';"), [false], 'type - имя импорта по умолчанию');
    assert.deepEqual(only("import type X = require('x');"), [true]);
    assert.deepEqual(only("export type * from 'x';"), [true]);
    assert.deepEqual(only("export { type A } from 'x';"), [false]);
  });

  it('вычисляемый путь и неразобранный оператор - отдельные записи', () => {
    assert.deepEqual(specs('await import(name);'), [COMPUTED]);
    assert.deepEqual(specs("require('a' + b);"), [COMPUTED]);
    assert.deepEqual(specs('await import(`./${name}.js`);'), [COMPUTED]);
    assert.deepEqual(specs('require(...args);'), [COMPUTED]);
    assert.deepEqual(specs("await import('x', { with: { type: 'json' } });"), ['x']);
    assert.deepEqual(specs('import x from ;'), [UNREADABLE]);
    assert.deepEqual(specs("import { a from 'x';"), [UNREADABLE]);
    assert.deepEqual(specs('require();'), []);
  });

  it('значение строки - после escape-последовательностей', () => {
    assert.deepEqual(specs("import fs from 'n\\x6fde:fs';"), ['node:fs']);
    assert.deepEqual(specs("import fs from 'node\\u003afs';"), ['node:fs']);
    assert.deepEqual(specs("import fs from 'node\\u{3a}fs';"), ['node:fs']);
    assert.deepEqual(specs('const x = require(`node:fs`);'), ['node:fs']);
    assert.deepEqual(specs('const x = `${await import(`node:fs`)}`;'), ['node:fs'], 'шаблон без подстановок внутри подстановки - строка');
    assert.deepEqual(specs('const x = require("a\\\nb");'), ['ab']);
  });

  it('текст в комментариях, строках, шаблонах и регулярных выражениях импортом не считается', () => {
    const text = [
      "// import fs from 'fs';",
      "/* import fs from 'fs';",
      "require('fs') */",
      "const a = \"import fs from 'fs'\";",
      "const b = 'require(\"fs\")';",
      "const c = `import('fs') ${1 + 1}`;",
      "const d = /import\\('fs'\\)/;",
      "const e = /['\"]/.test(a) ? 1 : 2;",
      "const f = x / 2; const g = y / 3; // 'import(',",
    ].join('\n');
    assert.deepEqual(specs(text), []);
  });

  it('код в подстановке шаблона и после регулярного выражения виден', () => {
    assert.deepEqual(specs('const a = `x ${require("fs")} y ${await import("os")}`;'), ['fs', 'os']);
    assert.deepEqual(specs('const a = `x ${ { b: `y ${require("a")}` }.b }`; require("b");'), ['a', 'b']);
    assert.deepEqual(specs("const re = /'/; require('fs');"), ['fs'], 'кавычка в регулярном выражении не открывает строку');
    assert.deepEqual(specs("const re = /[/']/; require('fs');"), ['fs'], 'слэш в классе символов');
    assert.deepEqual(specs("const n = a++ / 2; require('fs');"), ['fs']);
    assert.deepEqual(specs("const q = ok ? 1 : 2\nconst r = (1) / 2 / 3; require('fs')"), ['fs']);
  });

  it('имя import/require как свойство или ключ - не загрузка', () => {
    assert.deepEqual(specs("const a = obj.require('x'); const b = obj?.import('y'); const c = { import: 1, require: 2, export: 3 }; import.meta.url;"), []);
  });

  it('shebang, CRLF и номер строки оператора', () => {
    const text = "#!/usr/bin/env node\r\nimport a from 'a';\r\n\r\nconst x = 1;\r\nimport {\r\n  b,\r\n} from 'b';\r\n";
    assert.deepEqual(usesOf(text).map((u) => u.line), [2, 5]);
  });

  it('import и require внутри выражений находятся на любой глубине', () => {
    assert.deepEqual(specs("function f() { return () => [require('a'), { x: await import('b') }]; }"), ['a', 'b']);
    assert.deepEqual(specs("require(require('a'));"), [COMPUTED, 'a']);
  });
});

describe('пакет объявлений: операторы верхнего уровня', () => {
  const problems = (text: string) => declarationProblems(text, CONTRACTS);

  it('разрешены interface, type, declare module контрактов и import type из них', () => {
    const text = [
      "import type { Subscription } from '@cyborg-harness/contracts';",
      "declare module '@cyborg-harness/contracts' {",
      '  interface Contracts { a: 1 }',
      '}',
      'export interface Clock { now(): number }',
      'export type Mode = "a" | "b";',
      'type Long =',
      '  | { type: "x" }',
      '  | { type: "y" };',
      'declare interface D {}',
      'export type Fn = () =>',
      '  void',
    ].join('\n');
    assert.deepEqual(problems(text), []);
  });

  it('любой код, чужие модули и import не-type - нарушение со строкой оператора', () => {
    const text = [
      'export const x = 1;',
      "import fs from 'node:fs';",
      'export interface Ok { a: 1 }',
      "import type { A } from './other.ts';",
      "import { type B } from '@cyborg-harness/contracts';",
      "declare module 'other' {}",
      'export {};',
      'export function f() {}',
      "export type { C } from 'c';",
      'declare const v: number;',
      'export default 1;',
      "import type X = require('@cyborg-harness/contracts');",
    ].join('\n');
    assert.deepEqual(problems(text), [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('операторы без точки с запятой и в одной строке разделены верно', () => {
    assert.deepEqual(problems('interface A { a: 1 }\nconst x = 1\ninterface B {}'), [2]);
    assert.deepEqual(problems('interface A {} const x = 1;'), [1]);
    assert.deepEqual(problems('interface A {};\ninterface B {}'), []);
    assert.deepEqual(problems('type A = string\nconst x = 1\ntype B = number\nfoo()'), [2, 4]);
  });
});
