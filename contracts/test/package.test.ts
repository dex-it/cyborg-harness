import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { buildDeclarations, rewriteSpecifiers } from '../scripts/build.ts';
import { runCommand } from '../../core/test/run-command.ts';

// P-01: пакет ставится по номеру версии, а не через paths. Тесты собирают пакет, как `npm publish`, и ставят его в пустой проект вне репозитория.
const contracts = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(contracts, '..');
const tsc = path.join(repo, 'node_modules', 'typescript7', 'bin', 'tsc');
const SOURCES = ['agent', 'elements', 'git', 'index', 'os', 'plugin', 'sessions', 'tree', 'view'];

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  type?: string;
  types?: string;
  exports?: Record<string, unknown>;
  files?: string[];
  repository?: { type?: string; url?: string; directory?: string };
  publishConfig?: { registry?: string; access?: string };
  scripts?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync(path.join(contracts, 'package.json'), 'utf8')) as PackageJson;

function tmp(name: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `cyborg-contracts-${name}-`));
}

/** Относительные спецификаторы всех import/export и `import('...')` файла. */
function specifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('package.json пакета контрактов', () => {
  it('ST-5002/5: готов к публикации: не private, exports и types на собранные декларации', () => {
    assert.equal(pkg.name, '@cyborg-harness/contracts');
    assert.notEqual(pkg.private, true, 'private: true запрещает npm publish');
    assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.types, './dist/index.d.ts');
    // Только условие types: рантайма в пакете нет, импорт значения должен падать при разрешении, а не отдавать пустой модуль.
    assert.deepEqual(pkg.exports, { '.': { types: './dist/index.d.ts' }, './manifest.schema.json': './manifest.schema.json', './package.json': './package.json' });
    assert.deepEqual(pkg.files, ['dist', 'manifest.schema.json', 'README.md', 'CHANGELOG.md']);
    assert.equal(pkg.repository?.type, 'git');
    assert.equal(pkg.repository.url, 'git+https://github.com/dex-it/cyborg-harness.git');
    assert.equal(pkg.repository.directory, 'contracts');
    assert.equal(pkg.publishConfig?.registry, 'https://registry.npmjs.org/');
    assert.equal(pkg.publishConfig.access, 'restricted', 'public выставляет релиз P-10 по решению владельца, не эта задача');
    assert.equal(pkg.scripts?.prepack, 'node scripts/build.ts', 'tarball всегда собирается свежим');
  });
});

describe('сборка деклараций', () => {
  it('rewriteSpecifiers меняет .ts на .js только у относительных путей', () => {
    const text = [
      "import type { A } from './a.ts';",
      'export type * from "../b/c.ts";',
      "type T = import('./d.ts').D;",
      "import type { E } from '@scope/pkg/e.ts';",
      "import type { F } from './f.js';",
      "import type { G } from './g';",
    ].join('\n');
    assert.equal(
      rewriteSpecifiers(text),
      [
        "import type { A } from './a.js';",
        'export type * from "../b/c.js";',
        "type T = import('./d.js').D;",
        "import type { E } from '@scope/pkg/e.ts';",
        "import type { F } from './f.js';",
        "import type { G } from './g';",
      ].join('\n'),
    );
  });

  it('ST-5002/5: в dist только .d.ts, импортов с расширением .ts нет, каждый относительный путь ведёт к файлу', () => {
    const out = tmp('build');
    buildDeclarations(out);
    const files = fs.readdirSync(out, { recursive: true, encoding: 'utf8' }).sort();
    assert.deepEqual(files, SOURCES.map((s) => `${s}.d.ts`));
    for (const file of files) {
      const text = fs.readFileSync(path.join(out, file), 'utf8');
      for (const spec of specifiers(file, text)) {
        assert.ok(spec.startsWith('./'), `${file}: неожиданный путь ${spec}`);
        assert.match(spec, /\.js$/, `${file}: ${spec}`);
        assert.ok(fs.existsSync(path.join(out, spec.replace(/\.js$/, '.d.ts'))), `${file}: ${spec} не ведёт к декларации`);
      }
    }
    fs.rmSync(out, { recursive: true });
  });
});

describe('npm pack и пустой потребитель', () => {
  const work = tmp('pack');
  const packed = path.join(work, 'pack');
  let report: { filename: string; files: { path: string }[] }[] = [];
  let tarball = '';
  const npm = (args: string[], cwd: string): string => runCommand('npm', args, { cwd });

  // Одна сборка и одна упаковка на все проверки: prepack пишет в contracts/dist, параллельные упаковки мешали бы друг другу.
  before(() => {
    fs.mkdirSync(packed);
    report = JSON.parse(npm(['pack', '--json', '--pack-destination', packed], contracts)) as typeof report;
    tarball = path.join(packed, report[0]!.filename);
  });
  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('ST-5002/5: в tarball: package.json, README, CHANGELOG, схема манифеста и декларации; исходных .ts нет', () => {
    const names = report[0]!.files.map((f) => f.path).sort();
    assert.deepEqual(names, ['CHANGELOG.md', 'README.md', 'dist/agent.d.ts', 'dist/elements.d.ts', 'dist/git.d.ts', 'dist/index.d.ts', 'dist/os.d.ts', 'dist/plugin.d.ts', 'dist/sessions.d.ts', 'dist/tree.d.ts', 'dist/view.d.ts', 'manifest.schema.json', 'package.json']);
    assert.deepEqual(names.filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts')), []);
  });

  const consumerSource = `
import type { PluginModule, Remote, Subscription, UiModule } from '@cyborg-harness/contracts';

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'acme.clock': { 1: Clock };
  }
}

export interface Clock {
  now(): Promise<number>;
  onTick(listener: (tick: number) => void): Subscription;
}

export const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('acme.clock', '1.2', { now: async () => 1, onTick: () => ({ dispose() {} }) });
    const clock: Remote<Clock> | undefined = ctx.contracts.get('acme.clock', 1);
    void clock?.now();
    const agent = ctx.contracts.get('cyborg.agent', 1);
    void agent;
    // @ts-expect-error мажорной версии 2 в карте нет
    ctx.contracts.get('acme.clock', 2);
    // @ts-expect-error контракта нет в карте
    ctx.contracts.get('acme.nothing', 1);
    // @ts-expect-error 3.0 не объявлена
    ctx.contracts.provide('acme.clock', '3.0', { now: async () => 1, onTick: () => ({ dispose() {} }) });
  },
};

// Вид: корень - параметр типа, DOM у потребителя не нужен.
export const view: UiModule<{ innerHTML: string }> = {
  mount(root) {
    root.innerHTML = '';
    return undefined;
  },
};
`;

  for (const [name, module, resolution] of [['NodeNext', 'NodeNext', 'NodeNext'], ['Bundler', 'ESNext', 'Bundler']] as const) {
    it(`ST-7002/1: пустой проект (${name}) ставит tarball и собирает плагин на PluginModule и declare module`, () => {
      const project = path.join(work, `consumer-${name}`);
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
      fs.writeFileSync(path.join(project, 'plugin.ts'), consumerSource);
      fs.writeFileSync(
        path.join(project, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022', module, moduleResolution: resolution, lib: ['ES2023'], types: [],
            strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: false, verbatimModuleSyntax: true,
          },
          include: ['plugin.ts'],
        }),
      );
      npm(['install', tarball, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], project);
      assert.ok(fs.existsSync(path.join(project, 'node_modules', '@cyborg-harness', 'contracts', 'dist', 'index.d.ts')));
      runCommand(process.execPath, [tsc, '-p', project]);
      // Путь из `$schema` манифеста автора (P-04): схема лежит в установленном пакете и совпадает с исходной.
      const installed = path.join(project, 'node_modules', '@cyborg-harness', 'contracts', 'manifest.schema.json');
      assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(contracts, 'manifest.schema.json'), 'utf8'));
    });
  }
});
