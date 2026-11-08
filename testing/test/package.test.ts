import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { satisfies } from '@cyborg-harness/core';
import { COMPUTED, usesOf } from '../../core/test/imports.ts';

// P-08: пакет @cyborg-harness/testing. Состав и форма пакета, граница зависимостей (T-04: в пакете нет импортов из playground) и отсутствие копий подделок в тестах репозитория.
const pkg = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pkg, '..');
interface Manifest {
  name?: string;
  version?: string;
  type?: string;
  engines?: { node?: string };
  exports?: Record<string, string | Record<string, string>>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}
const read = (dir: string): Manifest => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest;
const manifest = read(pkg);
const coreManifest = read(path.join(root, 'core'));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function exportTargets(): string[] {
  return Object.values(manifest.exports ?? {})
    .flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)))
    .filter((p) => p !== './package.json');
}

describe('package.json тест-кита', () => {
  it('имя, ESM и Node как у ядра', () => {
    assert.equal(manifest.name, '@cyborg-harness/testing');
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.engines?.node, coreManifest.engines?.node);
  });

  it('версия совпадает с версией ядра, а peer на ядро её допускает', () => {
    assert.equal(manifest.version, coreManifest.version);
    const range = manifest.peerDependencies?.['@cyborg-harness/core'];
    assert.ok(range, 'нет peer на ядро');
    assert.ok(satisfies(coreManifest.version ?? '', range), `${range} не допускает ядро ${coreManifest.version ?? ''}`);
  });

  it('зависимостей нет; связи - peer на ядро и на контракты', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) assert.equal(manifest[field], undefined, field);
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).toSorted(), ['@cyborg-harness/contracts', '@cyborg-harness/core']);
  });

  it('одна точка входа, цели - собранные файлы', () => {
    assert.deepEqual(Object.keys(manifest.exports ?? {}), ['.', './package.json']);
    for (const target of exportTargets()) assert.match(target, /^\.\/dist\/.+\.(js|d\.ts)$/, target);
  });
});

describe('граница пакета', () => {
  const src = path.join(pkg, 'src');
  const sources = walk(src).filter((f) => f.endsWith('.ts'));

  it('src импортирует только node:*, ядро, контракты и свои модули: ни playground, ни core/src', () => {
    assert.ok(sources.length >= 6, `файлов: ${sources.length}`);
    const bad = sources.flatMap((file) =>
      usesOf(file, fs.readFileSync(file, 'utf8')).flatMap((use) => {
        const where = `${path.relative(pkg, file)}:${use.line} '${use.spec}'`;
        // Точка входа каталога плагина вычисляется: startKernel и есть загрузчик кода плагина автора.
        if (use.spec === COMPUTED && path.basename(file) === 'kernel.ts') return [];
        if (use.spec.startsWith('node:') || use.spec === '@cyborg-harness/core' || use.spec === '@cyborg-harness/contracts') return [];
        if (use.spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), use.spec);
          return target.startsWith(src + path.sep) ? [] : [`${where}: модуль вне testing/src`];
        }
        return [`${where}: чужой пакет`];
      }),
    );
    assert.deepEqual(bad, []);
  });

  it('проверка ловит то, что запрещает', () => {
    const text = "import { x } from '../../playground/src/main/plugins.ts';\nimport { y } from '@cyborg-harness/core/host';\nimport z from 'electron';\n";
    const specs = usesOf(path.join(src, 'x.ts'), text).map((u) => u.spec);
    assert.deepEqual(specs, ['../../playground/src/main/plugins.ts', '@cyborg-harness/core/host', 'electron']);
    assert.ok(specs.every((s) => !(s.startsWith('node:') || s === '@cyborg-harness/core' || s === '@cyborg-harness/contracts')));
  });
});

describe('собранный пакет (testing/dist)', () => {
  const dist = path.join(pkg, 'dist');
  const files = fs.existsSync(dist) ? walk(dist) : [];

  it('собран: каждая цель exports существует', () => {
    assert.ok(files.length > 0, 'нет testing/dist - запусти `npm run build:testing`');
    for (const target of exportTargets()) assert.ok(fs.existsSync(path.join(pkg, target)), target);
  });

  it('JS и .d.ts без .ts-расширений в импортах; снаружи только ядро и контракты', () => {
    const code = files.filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'));
    assert.ok(code.length >= 12, `файлов в dist: ${code.length}`);
    const specs = /(?:from|import)\s*\(?\s*'([^']+)'/g;
    for (const file of code) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(specs)) {
        const spec = m[1] ?? '';
        const where = `${path.relative(pkg, file)} '${spec}'`;
        if (spec.startsWith('.')) assert.ok(spec.endsWith('.js'), `${where}: относительный импорт без .js`);
        else assert.ok(spec.startsWith('node:') || spec === '@cyborg-harness/core' || spec === '@cyborg-harness/contracts', `${where}: чужой пакет`);
      }
    }
    assert.ok(!files.some((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')), 'в dist лежит исходный .ts');
  });

  it('npm pack: в архиве dist, package.json и README, без исходников и тестов', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
    const [pack] = JSON.parse(out) as [{ files: { path: string }[] }];
    const names = pack.files.map((f) => f.path);
    assert.ok(names.includes('package.json') && names.includes('README.md'), 'нет package.json или README.md');
    for (const name of names) {
      assert.ok(name === 'package.json' || name === 'README.md' || name.startsWith('dist/'), `лишний файл в архиве: ${name}`);
      assert.ok(!name.endsWith('.ts') || name.endsWith('.d.ts'), `исходный .ts в архиве: ${name}`);
    }
    for (const target of exportTargets()) assert.ok(names.includes(target.slice(2)), `в архиве нет ${target}`);
  });
});
