import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// P-02: ядро как пакет @cyborg-harness/core. Тесты про состав и форму пакета; сборка - `npm run build:core` (её гоняют pretest/pretypecheck/prelint/prebuild).
const dbg = (m: string) => process.stderr.write(`DBG package ${Date.now()} ${m}\n`);
dbg('start');
const core = path.resolve(import.meta.dirname, '..');
const root = path.resolve(core, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')) as {
  name?: string;
  version?: string;
  type?: string;
  engines?: { node?: string };
  exports?: Record<string, string | Record<string, string>>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  [key: string]: unknown;
};

/** Все пути-цели `exports`, кроме package.json. */
function exportTargets(): string[] {
  return Object.values(manifest.exports ?? {})
    .flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)))
    .filter((p) => p !== './package.json');
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('package.json ядра', () => {
  it('имя, версия и ESM', () => {
    assert.equal(manifest.name, '@cyborg-harness/core');
    assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.type, 'module');
  });

  it('engines.node - мажор Node, на котором идёт CI и который несёт Electron playground (Node 24)', () => {
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const major = /node-version:\s*(\d+)/.exec(ci)?.[1];
    assert.equal(manifest.engines?.node, `>=${major}`);
    assert.equal(major, '24');
  });

  it('рантайм-зависимостей нет; единственная связь - peer на контракты', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
      assert.equal(manifest[field], undefined, field);
    }
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), ['@cyborg-harness/contracts']);
  });

  it('точки входа: главный процесс, хост, вход хоста для fork, оболочка вида и элементы окна', () => {
    assert.deepEqual(Object.keys(manifest.exports ?? {}), ['.', './host', './host-entry', './keys', './ui-shell', './elements', './package.json']);
    for (const target of exportTargets()) assert.match(target, /^\.\/dist\/.+\.(js|d\.ts)$/, target);
  });
});

describe('потребители в репозитории', () => {
  it('playground берёт ядро через пакет, а не относительными путями в core/src и core/elements', () => {
    dbg('walk begin');
    const playground = path.join(root, 'playground');
    const files = walk(playground).filter((f) => /\.(ts|mjs)$/.test(f) && !f.includes(`${path.sep}dist${path.sep}`) && !f.includes(`${path.sep}node_modules${path.sep}`));
    dbg('walk end');
    assert.ok(files.length > 50, `файлов playground: ${files.length}`);
    const bad = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/(?:from|import\()\s*'[^']*core\/(?:src|elements)\//.test(line) ? [`${path.relative(root, f)}:${i + 1}: ${line.trim()}`] : [])),
    );
    assert.deepEqual(bad, []);
  });
});

describe('собранный пакет (core/dist)', () => {
  const dist = path.join(core, 'dist');
  const built = fs.existsSync(dist);
  const files = built ? walk(dist) : [];

  it('собран: каждая цель exports существует', () => {
    assert.ok(built, 'нет core/dist - запусти `npm run build:core`');
    for (const target of exportTargets()) assert.ok(fs.existsSync(path.join(core, target)), target);
  });

  it('JS и .d.ts без .ts-расширений в импортах и без чужих зависимостей', () => {
    const code = files.filter((f) => f.endsWith('.js') || f.endsWith('.d.ts'));
    assert.ok(code.length > 30, `файлов в dist: ${code.length}`);
    const specs = /(?:from|import)\s*\(?\s*'([^']+)'/g;
    for (const file of code) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(specs)) {
        const spec = m[1] ?? '';
        const where = `${path.relative(core, file)} '${spec}'`;
        assert.ok(!spec.endsWith('.ts') || spec.endsWith('.d.ts'), `${where}: расширение .ts`);
        if (spec.startsWith('.')) assert.ok(spec.endsWith('.js'), `${where}: относительный импорт без .js`);
        else assert.ok(spec.startsWith('node:') || spec === '@cyborg-harness/contracts', `${where}: чужой пакет`);
      }
    }
    assert.ok(!files.some((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')), 'в dist лежит исходный .ts');
  });

  it('импорты контрактов в собранном JS только типовые: рантайм-связи с пакетом контрактов нет', () => {
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      assert.ok(!fs.readFileSync(file, 'utf8').includes('@cyborg-harness/contracts'), path.relative(core, file));
    }
  });

  it('npm pack: в архиве dist, package.json и README, без исходников и тестов', () => {
    dbg('pack begin');
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: core, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
    dbg('pack end');
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
