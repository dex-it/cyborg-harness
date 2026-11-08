import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// P-02, приёмка 1: пустой проект вне репозитория ставит оба пакета из архивов `npm pack` по номерам версий,
// собирается (tsc) и запускает сценарий из core/examples. Реестр не нужен: ставятся tarball-ы.
const core = path.resolve(import.meta.dirname, '..');
const root = path.resolve(core, '..');
const tsc = path.join(root, 'node_modules', 'typescript7', 'bin', 'tsc');

let work = '';
let project = '';
/** Команда с пределом времени: зависшая npm не должна держать весь `npm test`; при отказе в сообщение идёт её вывод. */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 90_000, killSignal: 'SIGKILL' });
  } catch (error) {
    const e = error as { message: string; stdout?: string; stderr?: string };
    throw new Error(`${cmd} ${args.join(' ')} (cwd ${cwd}): ${e.message}\n--- stdout\n${e.stdout ?? ''}\n--- stderr\n${e.stderr ?? ''}`, { cause: error });
  }
}

/** Упаковывает пакет в `work` и возвращает путь архива. */
function pack(dir: string): string {
  const [out] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], dir)) as [{ filename: string }];
  return path.join(work, out.filename);
}

describe('потребитель вне репозитория', { timeout: 180_000 }, () => {
  before(() => {
    // Каталог не внутри репозитория и не внутри node_modules: иначе Node не снял бы типы с .ts сценариев, а tsc взял бы чужой tsconfig.
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-consumer-'));
    project = path.join(work, 'app');
    fs.mkdirSync(project);
    const tarballs = [pack(path.join(root, 'contracts')), pack(core)];
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

  it('пакеты стоят по номерам версий, ядро не принесло зависимостей', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    const names = Object.keys(lock.packages).filter((k) => k !== '');
    assert.deepEqual(names.sort(), ['node_modules/@cyborg-harness/contracts', 'node_modules/@cyborg-harness/core']);
    const own = JSON.parse(fs.readFileSync(path.join(core, 'package.json'), 'utf8')) as { version: string };
    assert.equal(lock.packages['node_modules/@cyborg-harness/core']?.version, own.version);
  });

  it('import { load } из пакета собирается tsc: типы читаются из .d.ts', () => {
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

  it('пример из README пакета запускается как написан', () => {
    const blocks = [...fs.readFileSync(path.join(core, 'README.md'), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const main = blocks.find((b) => b.includes('await load('));
    const plugin = blocks.find((b) => b.includes('export default plugin'));
    assert.ok(main && plugin, 'в README нет примера или модуля плагина');
    fs.mkdirSync(path.join(project, 'plugins'));
    fs.writeFileSync(path.join(project, 'plugins', 'hello.ts'), plugin);
    fs.writeFileSync(path.join(project, 'readme-example.ts'), main);
    assert.equal(run(process.execPath, ['readme-example.ts'], project).trim(), 'hello');
  });

  it('сценарий core/examples идёт на пакете: хосты в дочерних процессах из dist/host-entry.js', () => {
    const out = run(process.execPath, ['examples/run.ts', 'basic'], project, { NO_COLOR: '1' });
    assert.match(out, /Шаг 1\./);
    assert.match(out, /активен/);
    assert.doesNotMatch(out, /✖/);
  });
});
