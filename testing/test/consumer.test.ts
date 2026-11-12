import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCommand } from '../../core/test/run-command.ts';

// P-08, приёмка 2: пустой проект вне репозитория ставит тест-кит из архивов `npm pack` по номерам версий (вместе с ядром и контрактами)
// и проходит свой тест на startKernel. Реестр не нужен: ставятся tarball-ы.
const pkg = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pkg, '..');
const tsc = path.join(root, 'node_modules', 'typescript7', 'bin', 'tsc');

let work = '';
let project = '';
/** Команда с пределом времени; при отказе в сообщение идёт её вывод (core/test/run-command.ts). NODE_TEST_CONTEXT убран: внутри `node --test` вложенный `node --test` молчал бы, считая себя дочерним. */
const run = (cmd: string, args: string[], cwd: string): string => runCommand(cmd, args, { cwd, env: { NODE_TEST_CONTEXT: undefined } });

function pack(dir: string): string {
  const [out] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], dir)) as [{ filename: string }];
  return path.join(work, out.filename);
}

describe('потребитель вне репозитория', { timeout: 180_000 }, () => {
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-testing-consumer-'));
    project = path.join(work, 'plugin');
    fs.mkdirSync(project);
    const tarballs = [pack(path.join(root, 'contracts')), pack(path.join(root, 'core')), pack(pkg)];
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'author-plugin', private: true, type: 'module' }));
    run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', ...tarballs], project);
  });

  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('три пакета стоят по номерам версий, чужих зависимостей нет', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
    assert.deepEqual(
      Object.keys(lock.packages).filter((k) => k !== '').toSorted(),
      ['node_modules/@cyborg-harness/contracts', 'node_modules/@cyborg-harness/core', 'node_modules/@cyborg-harness/testing'],
    );
    const own = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { version: string };
    assert.equal(lock.packages['node_modules/@cyborg-harness/testing']?.version, own.version);
  });

  it('npm ls --all --offline: неудовлетворённых peer нет', () => {
    // npm ls завершается ошибкой (ELSPROBLEMS) на неудовлетворённом peer; run() покажет вывод.
    const out = run('npm', ['ls', '--all', '--offline'], project);
    assert.match(out, /@cyborg-harness\/testing@/);
    assert.doesNotMatch(out, /invalid|UNMET|missing/i);
  });

  it('типы читаются из .d.ts: startKernel, наборы и подделки собираются tsc', () => {
    fs.writeFileSync(
      path.join(project, 'check.ts'),
      [
        "import { agentContractSuite, fakePty, memorySecrets, memoryStore, sandbox, startKernel, type TestKernel } from '@cyborg-harness/testing';",
        'const k: Promise<TestKernel> = startKernel({ plugins: [], os: { pty: fakePty(), secrets: memorySecrets() }, config: memoryStore().store });',
        'export { agentContractSuite, k, sandbox };',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(project, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: false, types: ['node'], typeRoots: [path.join(root, 'node_modules', '@types')] }, files: ['check.ts'] }),
    );
    run(process.execPath, [tsc, '-p', project], project);
  });

  it('пример из README пакета проходит как тест', () => {
    const blocks = [...fs.readFileSync(path.join(pkg, 'README.md'), 'utf8').matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const example = blocks.find((b) => b.includes('await using kernel = await startKernel('));
    assert.ok(example, 'в README нет примера теста');
    fs.writeFileSync(path.join(project, 'hello.test.ts'), example);
    const out = run(process.execPath, ['--test', '--test-reporter=tap', 'hello.test.ts'], project);
    assert.match(out, /# pass 1/);
    assert.match(out, /# fail 0/);
  });

  it('общий набор поставщика из пакета идёт у стороннего автора: его плагин проходит agentContractSuite', () => {
    fs.mkdirSync(path.join(project, 'my-agent'));
    fs.writeFileSync(
      path.join(project, 'my-agent', 'manifest.json'),
      JSON.stringify({ id: 'my-agent', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.agent': '1.0' }, permissions: { launch: ['/bin/sh'] } }),
    );
    fs.writeFileSync(
      path.join(project, 'my-agent', 'index.ts'),
      [
        "import type { Agent, PluginModule } from '@cyborg-harness/contracts';",
        'const agent: Agent = {',
        "  facts: async () => ({ id: 'mine', title: 'Мой агент', found: true, capabilities: { resume: false, history: false, events: false } }),",
        "  launch: async (request) => ({ program: '/bin/sh', args: [], cwd: request.cwd, env: {} }),",
        '  watch: () => ({ dispose: () => undefined }),',
        "  ended: async (_id, exit) => (exit.code === 127 ? { kind: 'notFound', message: 'нет программы' } : null),",
        '  history: async () => [],',
        '};',
        "const plugin: PluginModule = { activate: (ctx) => void ctx.contracts.provide('cyborg.agent', '1.0', agent) };",
        'export default plugin;',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(project, 'agent.test.ts'), "import { agentContractSuite } from '@cyborg-harness/testing';\nagentContractSuite(new URL('./my-agent', import.meta.url).pathname);\n");
    const out = run(process.execPath, ['--test', '--test-reporter=tap', 'agent.test.ts'], project);
    assert.match(out, /# pass 6/);
    assert.match(out, /# fail 0/);
  });
});
