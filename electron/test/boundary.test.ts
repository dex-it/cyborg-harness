import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';

// P-03: граница адаптера. В пакете нет импортов из playground и из внутренностей ядра (только публичные точки входа T-09),
// а playground берёт адаптер только через точки входа его `exports`.
const pkg = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pkg, '..');
const CORE = '@cyborg-harness/core';
const ADAPTER = '@cyborg-harness/electron';

const exportsOf = (dir: string): string[] => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };
  return Object.keys(manifest.exports).filter((k) => k !== './package.json');
};
const coreEntries = exportsOf('core');
const adapterEntries = exportsOf('electron');

/** Все строковые адреса модулей файла: import, export from, import('...'), require('...'). */
export function specifiers(file: string, text: string): { spec: string; line: number }[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const found: { spec: string; line: number }[] = [];
  const add = (node: ts.Node, literal: ts.Node | undefined) => {
    if (literal && ts.isStringLiteralLike(literal)) found.push({ spec: literal.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node, node.moduleSpecifier);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node, node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Нарушения границы в файле пакета адаптера. */
export function adapterViolations(file: string, text: string, rel: string): string[] {
  const bad: string[] = [];
  for (const { spec, line } of specifiers(file, text)) {
    const where = `${rel}:${String(line)} '${spec}'`;
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(file), spec);
      if (target !== pkg && !target.startsWith(pkg + path.sep)) bad.push(`${where}: выход за пределы electron/`);
    } else if (/(^|\/)playground(\/|$)/.test(spec)) bad.push(`${where}: импорт из playground`);
    else if (spec === CORE || spec.startsWith(`${CORE}/`)) {
      if (!coreEntries.includes(`.${spec.slice(CORE.length)}`)) bad.push(`${where}: глубже публичных точек входа ядра`);
    }
  }
  return bad;
}

/** Нарушения границы в файле потребителя адаптера (playground). */
export function consumerViolations(file: string, text: string, rel: string): string[] {
  const bad: string[] = [];
  for (const { spec, line } of specifiers(file, text)) {
    const where = `${rel}:${String(line)} '${spec}'`;
    if (/(^|\/)electron\/(src|dist|scripts|test)\//.test(spec)) bad.push(`${where}: путь в пакет мимо точек входа`);
    else if (spec === ADAPTER || spec.startsWith(`${ADAPTER}/`)) {
      if (!adapterEntries.includes(`.${spec.slice(ADAPTER.length)}`)) bad.push(`${where}: нет такой точки входа адаптера`);
    }
  }
  return bad;
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === 'dist') return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full) : /\.(ts|mjs)$/.test(e.name) ? [full] : [];
  });
}

describe('граница адаптера Electron', () => {
  it('в пакете нет импортов из playground, из внутренностей ядра и из-за пределов electron/', () => {
    const all = files(pkg);
    assert.ok(all.length >= 20, `файлов пакета: ${String(all.length)}`);
    const bad = all.flatMap((f) => adapterViolations(f, fs.readFileSync(f, 'utf8'), path.relative(root, f)));
    assert.deepEqual(bad, []);
  });

  it('playground берёт адаптер только через точки входа его exports', () => {
    const all = files(path.join(root, 'playground'));
    assert.ok(all.length > 50, `файлов playground: ${String(all.length)}`);
    const bad = all.flatMap((f) => consumerViolations(f, fs.readFileSync(f, 'utf8'), path.relative(root, f)));
    assert.deepEqual(bad, []);
    assert.ok(all.some((f) => specifiers(f, fs.readFileSync(f, 'utf8')).some((s) => s.spec === ADAPTER)), 'playground не использует адаптер: проверка пуста');
  });

  it('проверка ловит то, что запрещает', () => {
    const file = path.join(pkg, 'src', 'x.ts');
    const text = [
      "import { load } from '@cyborg-harness/core';",
      "import { runHost } from '@cyborg-harness/core/host';",
      "import { Kernel } from '../../core/src/loader.ts';",
      "import { main } from '../../playground/src/main/main.ts';",
      "import { x } from '@cyborg-harness/core/dist/src/index.js';",
      "export { y } from '@cyborg-harness/core/nothing';",
      "const z = await import('../../playground/plugins/echo/index.ts');",
      "import { ok } from './plugins.ts';",
    ].join('\n');
    const found = adapterViolations(file, text, 'x.ts').map((v) => Number(/:(\d+) /.exec(v)?.[1]));
    assert.deepEqual(found, [3, 4, 5, 6, 7]);
    const consumer = ["import { a } from '@cyborg-harness/electron';", "import { b } from '@cyborg-harness/electron/window';", "import { c } from '@cyborg-harness/electron/dist/src/index.js';", "import { d } from '../../electron/src/plugins.ts';", "import { e } from '@cyborg-harness/electron/nothing';"].join('\n');
    const bad = consumerViolations('/p.ts', consumer, 'p.ts').map((v) => Number(/:(\d+) /.exec(v)?.[1]));
    assert.deepEqual(bad, [3, 4, 5]);
  });
});
