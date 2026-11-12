import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCommand } from './run-command.ts';

// P-02, приёмка 1: пустой проект вне репозитория ставит оба пакета из архивов `npm pack` по номерам версий,
// собирается (tsc) и запускает сценарий из core/examples. Реестр не нужен: ставятся tarball-ы.
const core = path.resolve(import.meta.dirname, '..');
const root = path.resolve(core, '..');
const tsc = path.join(root, 'node_modules', 'typescript7', 'bin', 'tsc');

let work = '';
let project = '';
let corePack = '';
/** Команда с пределом времени: зависшая npm не должна держать весь `npm test`; при отказе в сообщение идёт её вывод (core/test/run-command.ts). */
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string => runCommand(cmd, args, { cwd, env });

/**
 * Упаковывает пакет в `work` и возвращает путь архива. Жизненный цикл пакета (`prepack`) идёт как у настоящей публикации:
 * если контракты собирают `dist` в `prepack` (P-01, #102), без него в архиве не было бы объявлений.
 * `ignoreScripts` - для копии пакета, где собирать нечего (проверка версии).
 */
function pack(dir: string, ignoreScripts = false): string {
  const [out] = JSON.parse(run('npm', ['pack', '--json', ...(ignoreScripts ? ['--ignore-scripts'] : []), '--pack-destination', work], dir)) as [{ filename: string }];
  return path.join(work, out.filename);
}

describe('потребитель вне репозитория', { timeout: 180_000 }, () => {
  before(() => {
    // Каталог не внутри репозитория и не внутри node_modules: иначе Node не снял бы типы с .ts сценариев, а tsc взял бы чужой tsconfig.
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-consumer-'));
    project = path.join(work, 'app');
    fs.mkdirSync(project);
    corePack = pack(core);
    const tarballs = [pack(path.join(root, 'contracts')), corePack];
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs], project);
    fs.cpSync(path.join(core, 'examples'), path.join(project, 'examples'), { recursive: true });
    for (const file of ['run.ts', 'scenarios.ts']) {
      const target = path.join(project, 'examples', file);
      fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replaceAll("'../src/index.ts'", "'@cyborg-harness/core'"));
    }
  });

  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('ST-6001/1: архивы ставятся, ядро не принесло зависимостей, peer на контракты удовлетворён', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    const names = Object.keys(lock.packages).filter((k) => k !== '');
    assert.deepEqual(names.sort(), ['node_modules/@cyborg-harness/contracts', 'node_modules/@cyborg-harness/core']);
    const own = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')) as { version: string };
    // Версия в lock - из того же package.json, поэтому «по номерам версий» здесь не проверяется (это даст реестр, P-10); проверяется другое:
    // npm не нашёл неудовлетворённого peer (`npm ls` падает на invalid) и контракты встали в той версии, что лежит в репозитории.
    assert.equal(lock.packages['node_modules/@cyborg-harness/core']?.version, own.version);
    const contractsOwn = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'package.json'), 'utf8')) as { version: string };
    assert.equal(lock.packages['node_modules/@cyborg-harness/contracts']?.version, contractsOwn.version);
    run('npm', ['ls', '--all', '--offline'], project);
  });

  it('ST-6001/8: peer на контракты принимает предрелиз: 1.0.0-dev из P-01 (#102) ставится рядом с ядром без реестра', () => {
    const copy = path.join(work, 'contracts-prerelease');
    fs.cpSync(path.join(root, 'contracts'), copy, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' && path.basename(src) !== 'dist' });
    const file = path.join(copy, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ ...(JSON.parse(fs.readFileSync(file, 'utf8')) as object), version: '1.0.0-dev' }));
    const other = path.join(work, 'app-prerelease');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'consumer-prerelease', private: true, type: 'module' }));
    run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', pack(copy, true), corePack], other);
    run('npm', ['ls', '--all', '--offline'], other);
  });

  it('ST-7002/1: ST-6001/1: import { load } из пакета собирается tsc: типы читаются из .d.ts', () => {
    fs.writeFileSync(
      path.join(project, 'check.ts'),
      "import { load, forkHosts, PLUGIN_API_VERSION, type Kernel } from '@cyborg-harness/core';\nimport { runHost } from '@cyborg-harness/core/host';\nconst k: Promise<Kernel> = load({ apiVersion: PLUGIN_API_VERSION, enabled: [], manifests: [], spawnHost: forkHosts() });\nexport { k, runHost };\n",
    );
    fs.writeFileSync(
      path.join(project, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: false, types: ['node'], typeRoots: [path.join(root, 'node_modules', '@types')] }, files: ['check.ts'] }),
    );
    run(process.execPath, [tsc, '-p', project], project);
  });

  it('ST-6001/1: пример из README пакета запускается как написан', () => {
    const blocks = [...fs.readFileSync(path.join(core, 'README.md'), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const main = blocks.find((b) => b.includes('await load('));
    const plugin = blocks.find((b) => b.includes('export default plugin'));
    assert.ok(main && plugin, 'в README нет примера или модуля плагина');
    fs.mkdirSync(path.join(project, 'plugins'));
    fs.writeFileSync(path.join(project, 'plugins', 'hello.ts'), plugin);
    fs.writeFileSync(path.join(project, 'readme-example.ts'), main);
    assert.equal(run(process.execPath, ['readme-example.ts'], project).trim(), 'hello');
  });

  it('checkPlugin из @cyborg-harness/core/plugin-check: чистый плагин без нарушений, запрещённый импорт с файлом и строкой (P-09)', () => {
    const make = (name: string, code: string) => {
      const dir = path.join(project, 'checked', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'acme.hello', version: '1.0.0', engines: { cyborg: '^1' } }));
      fs.writeFileSync(path.join(dir, 'index.js'), code);
      return dir;
    };
    // Командная строка cyborg-plugin живёт в своём пакете (P-06, tools/cyborg-plugin); здесь проверяется программный вход ядра.
    fs.writeFileSync(
      path.join(project, 'check.mjs'),
      "import { checkPlugin, formatProblem } from '@cyborg-harness/core/plugin-check';\nconst r = await checkPlugin(process.argv[2]);\nconsole.log(JSON.stringify({ ok: r.ok, problems: r.problems.map(formatProblem) }));\n",
    );
    const check = (dir: string) => JSON.parse(run(process.execPath, ['check.mjs', dir], project)) as { ok: boolean; problems: string[] };
    assert.deepEqual(check(make('good', 'export default {};\n')), { ok: true, problems: [] });
    assert.deepEqual(check(make('bad', "import fs from 'node:fs';\nexport default {};\n")), {
      ok: false,
      problems: ["index.js:1: 'node:fs': только @cyborg-harness/contracts и свои модули"],
    });
  });

  it('сценарий core/examples идёт на пакете: хосты в дочерних процессах из dist/host-entry.js', () => {
    const out = run(process.execPath, ['examples/run.ts', 'basic'], project, { NO_COLOR: '1' });
    assert.match(out, /Шаг 1\./);
    assert.match(out, /активен/);
    assert.doesNotMatch(out, /✖/);
  });
});
