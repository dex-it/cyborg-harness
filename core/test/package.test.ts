import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { runCommand } from './run-command.ts';

// P-02: ядро как пакет @cyborg-harness/core. Тесты про состав и форму пакета; сборка - `npm run build:core` (её гоняют pretest/pretypecheck/prelint/prebuild).
const core = path.resolve(import.meta.dirname, '..');
const root = path.resolve(core, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')) as {
  name?: string;
  version?: string;
  type?: string;
  engines?: { node?: string };
  exports?: Record<string, string | Record<string, string>>;
  bin?: Record<string, string>;
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

describe('ST-6001/1: package.json ядра', () => {
  it('имя, версия и ESM', () => {
    assert.equal(manifest.name, '@cyborg-harness/core');
    assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.type, 'module');
  });

  it('engines.node - мажор Node, который несёт Electron playground: берётся у самого Electron (ELECTRON_RUN_AS_NODE, process.versions.node)', () => {
    const electron = createRequire(path.join(root, 'package.json'))('electron') as string;
    const version = runCommand(electron, ['-p', 'process.versions.node'], { env: { ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }).trim();
    const major = /^(\d+)\./.exec(version)?.[1];
    assert.ok(major, `версия Node в Electron: ${version}`);
    assert.equal(manifest.engines?.node, `>=${major}`, `Node в Electron playground ${version}`);
  });

  it('engines.node совпадает с Node в CI (node-version в ci.yml): пакет проверяется на той версии, которую заявляет', () => {
    const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    const major = /node-version:\s*(\d+)/.exec(ci)?.[1];
    assert.equal(manifest.engines?.node, `>=${major}`);
  });

  it('рантайм-зависимостей нет; единственная связь - peer на контракты', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies']) {
      assert.equal(manifest[field], undefined, field);
    }
    assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}), ['@cyborg-harness/contracts']);
  });

  it('точки входа: главный процесс, хост, вход хоста для fork, pty-хост, клавиши, оболочка вида, слой окна, проверка плагина и элементы окна (имена в них - public-api.test.ts)', () => {
    assert.deepEqual(Object.keys(manifest.exports ?? {}), ['.', './host', './host-entry', './pty-host', './keys', './ui-shell', './window', './plugin-check', './delivery', './elements', './package.json']);
    for (const target of exportTargets()) assert.match(target, /^\.\/dist\/.+\.(js|d\.ts)$/, target);
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
    // Слова from и import в кавычках (разбор импортов плагина сравнивает токены с ними) оператором не считаются.
    const specs = /(?<![\w'"])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
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
    // Имя пакета в строке допустимо (проверка плагина сверяет с ним импорты плагина); связь - только `import` и `require`.
    const link = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]@cyborg-harness\/contracts['"]/;
    for (const file of files.filter((f) => f.endsWith('.js'))) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), link, path.relative(core, file));
    }
  });

  it('командной строки в ядре нет: cyborg-plugin живёт в своём пакете tools/cyborg-plugin (P-06)', () => {
    assert.equal(manifest.bin, undefined);
    assert.ok(!fs.existsSync(path.join(core, 'dist', 'src', 'plugin-cli-bin.js')), 'в сборке ядра остался вход команды');
  });

  it('npm pack: в архиве dist, package.json, README и CHANGELOG, без исходников и тестов', () => {
    const out = runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: core });
    const [pack] = JSON.parse(out) as [{ files: { path: string }[] }];
    const names = pack.files.map((f) => f.path);
    assert.ok(names.includes('package.json') && names.includes('README.md') && names.includes('CHANGELOG.md'), 'нет package.json, README.md или CHANGELOG.md');
    for (const name of names) {
      assert.ok(name === 'package.json' || name === 'README.md' || name === 'CHANGELOG.md' || name.startsWith('dist/'), `лишний файл в архиве: ${name}`);
      assert.ok(!name.endsWith('.ts') || name.endsWith('.d.ts'), `исходный .ts в архиве: ${name}`);
    }
    for (const target of exportTargets()) assert.ok(names.includes(target.slice(2)), `в архиве нет ${target}`);
  });
});
