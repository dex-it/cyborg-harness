import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// P-05: шаблон копируют в чужой репозиторий. Здесь шаблон копируется в пустой проект вне репозитория, переименовывается (как велит руководство, «Первый плагин», шаг 1)
// и проходит свои проверки на пакетах из архивов `npm pack`, без paths и без исходников репозитория: типы (tsc) и собственный тест шаблона (startKernel).
const pkg = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pkg, '..');
const template = path.join(root, 'templates', 'plugin');
const tsc = path.join(root, 'node_modules', 'typescript7', 'bin', 'tsc');

let work = '';
let project = '';
/** Команда с пределом времени; NODE_TEST_CONTEXT убран: внутри `node --test` вложенный `node --test` молчал бы, считая себя дочерним. */
function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_TEST_CONTEXT: undefined }, timeout: 90_000, killSignal: 'SIGKILL' });
  } catch (error) {
    const e = error as { message: string; stdout?: string; stderr?: string };
    throw new Error(`${cmd} ${args.join(' ')} (cwd ${cwd}): ${e.message}\n--- stdout\n${e.stdout ?? ''}\n--- stderr\n${e.stderr ?? ''}`, { cause: error });
  }
}

function pack(dir: string): string {
  const [out] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], dir)) as [{ filename: string }];
  return path.join(work, out.filename);
}

/** Копия каталога с заменой слова во всех текстовых файлах: `example` -> `greeter`. */
function copyRenamed(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const source = path.join(from, entry.name);
    if (entry.isDirectory()) copyRenamed(source, path.join(to, entry.name));
    else fs.writeFileSync(path.join(to, entry.name.replaceAll('example', 'greeter')), fs.readFileSync(source, 'utf8').replaceAll('example', 'greeter'));
  }
}

describe('шаблон плагина у стороннего автора', { timeout: 180_000 }, () => {
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-template-'));
    project = path.join(work, 'greeter');
    copyRenamed(template, project);
    // Зависимости, которых нет без реестра (cyborg-plugin, typescript, @types/node), из package.json убраны: ставятся три архива, tsc и типы Node берутся из репозитория.
    const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ ...manifest, devDependencies: undefined }));
    run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', pack(path.join(root, 'contracts')), pack(path.join(root, 'core')), pack(pkg)], project);
    fs.writeFileSync(path.join(project, 'tsconfig.repo.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { typeRoots: [path.join(root, 'node_modules', '@types')] } }));
  });

  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('после переименования в шаблоне не осталось прежнего имени', () => {
    const left = fs.readdirSync(project, { recursive: true, encoding: 'utf8' }).filter((f) => !f.startsWith('node_modules') && fs.statSync(path.join(project, f)).isFile() && fs.readFileSync(path.join(project, f), 'utf8').includes('example'));
    assert.deepEqual(left, []);
    assert.equal((JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8')) as { id: string }).id, 'greeter');
  });

  it('типы: tsc строгий, по пакетам из архивов (contracts, testing, core/plugin-check), без paths', () => {
    run(process.execPath, [tsc, '-p', 'tsconfig.repo.json'], project);
  });

  it('собственный тест шаблона проходит: плагин активен, команда, вид, config, контракт, checkPlugin', () => {
    const out = run(process.execPath, ['--test', '--test-reporter=tap', 'test/greeter.test.ts'], project);
    assert.match(out, /# pass 6/);
    assert.match(out, /# fail 0/);
  });
});
