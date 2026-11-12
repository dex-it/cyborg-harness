import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkDeclarations, importProblems, isTestPath } from '../src/plugin-check.ts';

// SAD §6.1, дисциплина: плагин импортирует только @cyborg-harness/contracts и свои модули. Без Compartment хост не мешает обойти шлюз, поэтому правило держит статика.
// Правило живёт в core/src/plugin-check.ts (P-09), чтобы его мог запустить автор вне репозитория; здесь - проверка плагинов репозитория и отрицательный тест правила.
const repo = path.resolve(import.meta.dirname, '..', '..');
/** Каталог плагинов -> пакет объявлений рядом с ним, как `@acme/contracts` у стороннего автора: только типы и дополнение карты Contracts. */
const PLUGIN_ROOTS: Readonly<Record<string, string>> = {
  'core/examples/plugins': 'core/examples/contracts.ts',
  'playground/plugins': 'playground/plugins/contracts.ts',
  // Шаблон автора (P-05): пакет объявлений лежит в самом плагине, как у автора, который не выносит один контракт в отдельный пакет.
  templates: 'templates/plugin/contracts.ts',
};
const CONTRACTS = '@cyborg-harness/contracts';

/** Исходники плагина без тестов (`test/`, `*.test.ts`: им нужны `node:test` и тест-кит, в поставку они не входят), `node_modules` и результата сборки. */
function sources(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(m|c)?[tj]s$/.test(f) && !f.endsWith('.d.ts') && !isTestPath(f) && !/(^|\/)(node_modules|dist)\//.test(f))
    .map((f) => path.join(dir, f));
}

const lines = (found: readonly { readonly line?: number | undefined }[]) => found.map((p) => p.line);

describe('импорты плагинов', () => {
  for (const [relRoot, relDeclarations] of Object.entries(PLUGIN_ROOTS)) {
    const root = path.join(repo, relRoot);
    const declarations = path.join(repo, relDeclarations);

    it(`ST-2007/2: ${relRoot}: только ${CONTRACTS}, свои модули и типы пакета объявлений`, () => {
      const homes = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
      assert.ok(homes.length > 0, `в ${relRoot} нет плагинов`);
      const found = homes.flatMap((home) => sources(home).flatMap((file) => importProblems(file, fs.readFileSync(file, 'utf8'), { home, declarations: [declarations], packages: [] }).map((p) => `${path.relative(repo, file)}:${p.line} ${p.message}`)));
      assert.deepEqual(found, []);
    });

    it(`${path.relative(repo, declarations)}: только типы`, () => {
      assert.deepEqual(checkDeclarations(declarations, fs.readFileSync(declarations, 'utf8')), []);
    });
  }

  it('ST-2007/2: проверка ловит то, что запрещает', () => {
    const home = path.join(repo, 'playground/plugins/x');
    const declarations = path.join(repo, 'playground/plugins/contracts.ts');
    const rules = { home, declarations: [declarations], packages: [] };
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
    assert.deepEqual(lines(importProblems(file, text, rules)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const viewText = ["import { Terminal } from '@xterm/xterm';", "import fs from 'fs';", "import { ipcRenderer } from 'electron';", "import { helper } from '../../other/index.ts';"].join('\n');
    assert.deepEqual(lines(importProblems(path.join(home, 'ui', 'ui.ts'), viewText, rules)), [2, 3, 4]);
    assert.equal(importProblems(file, viewText, rules).length, 4, 'пакет вида разрешён только в ui/');
    assert.equal(checkDeclarations(declarations, "export const x = 1;\nimport fs from 'node:fs';\nexport interface Ok { a: 1 }\n").length, 2);
  });
});
