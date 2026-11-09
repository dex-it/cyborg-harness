import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { forkHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// T-10: хост грузит точку входа через import() по пути, которого ядро не знает заранее. Плагин лежит не в репозитории, а в каталоге
// пользователя, в поставке или в node_modules; тип модуля и снятие типов Node решает по расширению и ближайшему package.json.
// Ожидание на каждый вариант одно из двух: плагин активен либо в журнале запись `failed` с причиной, по которой автор поймёт, что чинить.
// Итоги записаны таблицей в docs/05-verification/external-plugins.md.

const ESM = 'export default { activate() { return undefined; } };\n';
const CJS = 'module.exports = { activate() { return undefined; } };\n';
const TS = 'interface Options { readonly name: string }\nconst options: Options = { name: "x" };\nexport default { activate(): void { void options; } };\n';
const ENUM = 'enum Level { Low, High }\nexport default { activate() { return Level.High; } };\n';
const PARAMETER_PROPERTY = 'class Box { constructor(readonly size: number) {} }\nexport default { activate() { return new Box(1).size; } };\n';
const MODULE = '{"type":"module"}\n';
const COMMONJS = '{"type":"commonjs"}\n';
const UNTYPED = '{"name":"plugin-package"}\n';

interface Variant {
  readonly name: string;
  /** Файлы относительно корня варианта; манифест кладёт тест сам. */
  readonly files: Readonly<Record<string, string>>;
  /** Каталог плагина внутри корня варианта; по умолчанию сам корень. */
  readonly home?: string;
  readonly entry: string;
  /** Подстрока причины в записи `failed`; без неё плагин обязан стать активным. */
  readonly fails?: string;
}

const variants: readonly Variant[] = [
  { name: 'ts-no-package', files: { 'index.ts': TS }, entry: 'index.ts' },
  { name: 'ts-type-module', files: { 'package.json': MODULE, 'index.ts': TS }, entry: 'index.ts' },
  { name: 'ts-type-module-in-ancestor', files: { 'package.json': MODULE, 'plugin/index.ts': TS }, home: 'plugin', entry: 'index.ts' },
  { name: 'ts-untyped-package', files: { 'package.json': UNTYPED, 'index.ts': TS }, entry: 'index.ts' },
  { name: 'ts-type-commonjs', files: { 'package.json': COMMONJS, 'index.ts': TS }, entry: 'index.ts', fails: '"type":"commonjs"' },
  { name: 'js-type-module', files: { 'package.json': MODULE, 'index.js': ESM }, entry: 'index.js' },
  { name: 'js-type-module-in-ancestor', files: { 'package.json': MODULE, 'plugin/index.js': ESM }, home: 'plugin', entry: 'index.js' },
  { name: 'js-no-package', files: { 'index.js': ESM }, entry: 'index.js' },
  { name: 'js-untyped-package', files: { 'package.json': UNTYPED, 'index.js': ESM }, entry: 'index.js' },
  { name: 'js-type-commonjs', files: { 'package.json': COMMONJS, 'index.js': ESM }, entry: 'index.js', fails: '"type":"commonjs"' },
  { name: 'js-commonjs-syntax', files: { 'package.json': COMMONJS, 'index.js': CJS }, entry: 'index.js' },
  { name: 'mjs', files: { 'index.mjs': ESM }, entry: 'index.mjs' },
  { name: 'mjs-type-commonjs', files: { 'package.json': COMMONJS, 'index.mjs': ESM }, entry: 'index.mjs' },
  { name: 'ts-enum', files: { 'package.json': MODULE, 'index.ts': ENUM }, entry: 'index.ts', fails: 'enum is not supported' },
  { name: 'ts-parameter-property', files: { 'package.json': MODULE, 'index.ts': PARAMETER_PROPERTY }, entry: 'index.ts', fails: 'параметры-свойства' },
  { name: 'ts-in-node-modules', files: { 'node_modules/plugin/index.ts': TS }, home: 'node_modules/plugin', entry: 'index.ts', fails: 'node_modules' },
  { name: 'js-in-node-modules', files: { 'node_modules/plugin/package.json': MODULE, 'node_modules/plugin/index.js': ESM }, home: 'node_modules/plugin', entry: 'index.js' },
  { name: 'js-typeless-in-node-modules', files: { 'node_modules/plugin/index.js': ESM }, home: 'node_modules/plugin', entry: 'index.js' },
  { name: 'mjs-in-node-modules', files: { 'node_modules/plugin/index.mjs': ESM }, home: 'node_modules/plugin', entry: 'index.mjs' },
  { name: 'entry-missing', files: { 'readme.txt': 'нет точки входа' }, entry: 'index.mjs', fails: 'Cannot find module' },
  { name: 'ts-sibling-import', files: { 'package.json': MODULE, 'index.ts': "import { name } from './helper.ts';\nexport default { activate(): string { return name; } };\n", 'helper.ts': 'export const name: string = "helper";\n' }, entry: 'index.ts' },
  { name: 'ts-extensionless-import', files: { 'package.json': MODULE, 'index.ts': "import { name } from './helper';\nexport default { activate(): string { return name; } };\n", 'helper.ts': 'export const name: string = "helper";\n' }, entry: 'index.ts', fails: 'Cannot find module' },
  { name: 'ts-dependency-in-node-modules', files: { 'package.json': MODULE, 'index.ts': "import { name } from './node_modules/dep/index.ts';\nexport default { activate(): string { return name; } };\n", 'node_modules/dep/index.ts': 'export const name: string = "dep";\n' }, entry: 'index.ts', fails: 'node_modules' },
  { name: 'js-no-default-export', files: { 'package.json': MODULE, 'index.js': 'export const activate = 1;\n' }, entry: 'index.js', fails: 'export default' },
];

function manifestOf(id: string): unknown {
  return { id, version: '1.0.0', engines: { cyborg: '^1' } };
}

function failedReason(journal: readonly JournalEntry[], id: string): string | undefined {
  const failed = journal.find((e): e is Extract<JournalEntry, { kind: 'failed' }> => e.kind === 'failed' && e.pluginId === id);
  return failed?.error;
}

async function startVariants(root: string): Promise<Kernel> {
  const entries = new Map<string, string>();
  for (const variant of variants) {
    const base = join(root, variant.name);
    for (const [file, text] of Object.entries(variant.files)) {
      mkdirSync(dirname(join(base, file)), { recursive: true });
      writeFileSync(join(base, file), text);
    }
    const home = join(base, variant.home ?? '');
    writeFileSync(join(home, 'manifest.json'), JSON.stringify(manifestOf(variant.name)));
    entries.set(variant.name, pathToFileURL(join(home, variant.entry)).href);
  }
  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: variants.map((v) => v.name),
    manifests: variants.map((v) => manifestOf(v.name)),
    spawnHost: forkHosts({ silent: true }),
    entry: (m) => entries.get(m.id) ?? m.id,
    watchdog: { interval: 200, timeout: 5000, strikes: 3 },
  });
}

describe('плагин вне репозитория', () => {
  let root = '';
  let kernel: Kernel;
  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'cyborg-external-'));
    kernel = await startVariants(root);
  });
  after(async () => {
    await kernel.unload();
    rmSync(root, { recursive: true, force: true });
  });

  for (const variant of variants) {
    it(variant.fails === undefined ? `${variant.name}: активен` : `${variant.name}: failed с причиной «${variant.fails}»`, () => {
      const reason = failedReason(kernel.journal, variant.name);
      if (variant.fails === undefined) {
        assert.equal(reason, undefined);
        assert.ok(kernel.active.includes(variant.name), 'не активен');
      } else {
        assert.ok(reason?.includes(variant.fails), `причина «${reason ?? 'нет записи failed'}»`);
        assert.ok(reason.includes('точка входа'), 'причина называет точку входа');
        assert.ok(!kernel.active.includes(variant.name), 'активен вопреки отказу');
      }
    });
  }

  it('отказ одних плагинов не трогает остальных: хосты у плагинов свои', () => {
    const failing = variants.filter((v) => v.fails !== undefined).map((v) => v.name);
    assert.deepEqual(kernel.active.toSorted(), variants.map((v) => v.name).filter((n) => !failing.includes(n)).toSorted());
  });
});
