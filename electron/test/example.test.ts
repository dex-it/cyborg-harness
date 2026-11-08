import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { build } from 'esbuild';

// P-03, приёмка: пример «окно + ядро» из README адаптера собирается. Блоки ```ts с первой строкой `// file: <имя>` пишутся
// в каталог вне репозитория, проверяются компилятором (типы пакета читаются из его .d.ts) и собираются esbuild так, как их собирает приложение.
const pkg = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pkg, '..');
const tsc = path.join(root, 'node_modules', 'typescript7', 'bin', 'tsc');

let work = '';

const blocks = (): Map<string, string> => {
  const found = new Map<string, string>();
  for (const m of fs.readFileSync(path.join(pkg, 'README.md'), 'utf8').matchAll(/```ts\n\/\/ file: (\S+)\n([\s\S]*?)```/g)) found.set(m[1] ?? '', m[2] ?? '');
  return found;
};

describe('пример из README адаптера', { timeout: 120_000 }, () => {
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-electron-example-'));
    // Пакеты берутся из workspace репозитория, как их видит приложение внутри него.
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'), 'dir');
    for (const [name, text] of blocks()) fs.writeFileSync(path.join(work, name), text);
    fs.writeFileSync(
      path.join(work, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2023', 'DOM'], strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
        files: ['main.ts', 'preload.ts', 'renderer.ts'],
      }),
    );
  });

  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('в README есть главный процесс, preload и окно', () => {
    assert.deepEqual([...blocks().keys()].sort(), ['main.ts', 'preload.ts', 'renderer.ts']);
  });

  it('компилятор принимает пример: имена и типы пакета на месте', () => {
    try {
      execFileSync(process.execPath, [tsc, '-p', work], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      assert.fail(`tsc отказал:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
  });

  it('esbuild собирает главный процесс, preload, файл хоста и окно; окно без node:*', async () => {
    const common = { absWorkingDir: work, bundle: true, logLevel: 'silent' as const, write: false as const };
    const main = await build({ ...common, entryPoints: ['main.ts'], platform: 'node', format: 'cjs', external: ['electron', 'node-pty'] });
    assert.match(main.outputFiles[0]?.text ?? '', /utilityProcess/, 'главный процесс собран вместе с адаптером');
    const preload = await build({ ...common, entryPoints: ['preload.ts'], platform: 'node', format: 'cjs', external: ['electron'] });
    assert.match(preload.outputFiles[0]?.text ?? '', /plugins:snapshot/);
    const host = await build({ ...common, stdin: { contents: "import '@cyborg-harness/electron/host-entry';", resolveDir: work }, platform: 'node', format: 'esm' });
    assert.match(host.outputFiles[0]?.text ?? '', /parentPort/);
    const renderer = await build({ ...common, entryPoints: ['renderer.ts'], platform: 'browser', format: 'iife' });
    assert.doesNotMatch(renderer.outputFiles[0]?.text ?? '', /node:/, 'окно тянет node:*');
  });

  it('оболочка вида лежит в пакете готовым скриптом и стилем', () => {
    for (const file of ['shell.js', 'shell.css']) assert.ok(fs.statSync(path.join(pkg, 'dist', 'shell', file)).size > 100, file);
  });
});
