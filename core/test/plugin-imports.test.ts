import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { typeKeyword, usesOf } from './imports.ts';

// SAD §6.1, дисциплина: плагин импортирует только @cyborg-harness/contracts и свои модули. Без Compartment хост не мешает обойти шлюз, поэтому правило держит статика.
const repo = path.resolve(import.meta.dirname, '..', '..');
/** Каталог плагинов -> пакет объявлений рядом с ним, как `@acme/contracts` у стороннего автора: только типы и дополнение карты Contracts. */
const PLUGIN_ROOTS: Readonly<Record<string, string>> = {
  'core/examples/plugins': 'core/examples/contracts.ts',
  'playground/plugins': 'playground/plugins/contracts.ts',
};
const CONTRACTS = '@cyborg-harness/contracts';

const inside = (dir: string, target: string) => target === dir || target.startsWith(dir + path.sep);

/** Нарушения в файле плагина `file` из каталога `home`. */
export function violations(file: string, text: string, home: string, declarations: string): string[] {
  const found: string[] = [];
  // Вид - браузерный бандл во фрейме без Node (SAD §3.8): пакеты вроде xterm шлюз не обходят, а встроенные модули и electron - да.
  const view = inside(path.join(home, 'ui'), file);
  for (const use of usesOf(file, text)) {
    const where = `${path.relative(repo, file)}:${use.line} '${use.spec}'`;
    if (use.spec === CONTRACTS) continue;
    if (view && !use.spec.startsWith('.') && !isBuiltin(use.spec) && use.spec !== 'electron' && !use.spec.startsWith('electron/')) continue;
    if (!use.spec.startsWith('.')) {
      found.push(`${where}: только ${CONTRACTS} и свои модули`);
      continue;
    }
    const target = path.resolve(path.dirname(file), use.spec);
    if (inside(home, target)) continue;
    if (target === declarations && use.typeOnly) continue;
    found.push(`${where}: ${target === declarations ? 'пакет объявлений - только import type' : 'модуль вне каталога плагина'}`);
  }
  return found;
}

/** В пакете объявлений нет кода: иначе через него плагин получил бы общий модуль под видом типов. */
export function declarationProblems(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  for (const statement of source.statements) {
    const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const where = `${path.relative(repo, file)}:${line}`;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name) && statement.name.text === CONTRACTS) continue;
    if (ts.isImportDeclaration(statement) && statement.importClause && typeKeyword(statement.importClause) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === CONTRACTS) continue;
    found.push(`${where}: в пакете объявлений только типы и declare module '${CONTRACTS}'`);
  }
  return found;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(m|c)?[tj]s$/.test(f) && !f.endsWith('.d.ts')).map((f) => path.join(dir, f));
}

describe('импорты плагинов', () => {
  for (const [relRoot, relDeclarations] of Object.entries(PLUGIN_ROOTS)) {
    const root = path.join(repo, relRoot);
    const declarations = path.join(repo, relDeclarations);

    it(`${relRoot}: только ${CONTRACTS}, свои модули и типы пакета объявлений`, () => {
      const homes = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
      assert.ok(homes.length > 0, `в ${relRoot} нет плагинов`);
      const found = homes.flatMap((home) => sources(home).flatMap((file) => violations(file, fs.readFileSync(file, 'utf8'), home, declarations)));
      assert.deepEqual(found, []);
    });

    it(`${path.relative(repo, declarations)}: только типы`, () => {
      assert.deepEqual(declarationProblems(declarations, fs.readFileSync(declarations, 'utf8')), []);
    });
  }

  it('проверка ловит то, что запрещает', () => {
    const home = path.join(repo, 'playground/plugins/x');
    const declarations = path.join(repo, 'playground/plugins/contracts.ts');
    const file = path.join(home, 'index.ts');
    const text = [
      "import fs from 'node:fs';",
      "import { app } from 'electron';",
      "import type { PluginModule } from '../../../core/src/index.ts';",
      "import { helper } from '../other/index.ts';",
      "import { Echo } from '../contracts.ts';",
      "export * from '../other/util.ts';",
      "const m = await import('node:child_process');",
      "const n = require('node:fs');",
      'const o = await import(name);',
      "type T = import('../other/types.ts').T;",
      "import type { Chat } from '../contracts.ts';",
      "import type { PluginModule as P } from '@cyborg-harness/contracts';",
      "import { own } from './own.ts';",
      "import { deep } from './view/deep.ts';",
    ].join('\n');
    const found = violations(file, text, home, declarations).map((v) => Number(/:(\d+) /.exec(v)?.[1]));
    assert.deepEqual(found, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const viewText = ["import { Terminal } from '@xterm/xterm';", "import fs from 'fs';", "import { ipcRenderer } from 'electron';", "import { helper } from '../../other/index.ts';"].join('\n');
    const viewFound = violations(path.join(home, 'ui', 'ui.ts'), viewText, home, declarations).map((v) => Number(/:(\d+) /.exec(v)?.[1]));
    assert.deepEqual(viewFound, [2, 3, 4]);
    assert.equal(violations(file, viewText, home, declarations).length, 4, 'пакет вида разрешён только в ui/');
    assert.equal(declarationProblems(declarations, "export const x = 1;\nimport fs from 'node:fs';\nexport interface Ok { a: 1 }\n").length, 2);
  });
});
