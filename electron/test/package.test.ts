import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

// Состав архива пакета: собранный JS, объявления и оболочка вида; исходников, тестов и скриптов сборки в нём нет.
const pkg = path.resolve(import.meta.dirname, '..');

describe('состав архива @cyborg-harness/electron (npm pack --dry-run)', () => {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 })) as [{ files: { path: string }[] }];
  const files = packed.files.map((f) => f.path);

  it('есть сборка, объявления, оболочка вида, README и package.json', () => {
    for (const expected of ['package.json', 'README.md', 'dist/src/index.js', 'dist/src/index.d.ts', 'dist/src/host-entry.js', 'dist/src/index-preload.js', 'dist/src/index-window.js', 'dist/shell/shell.js', 'dist/shell/shell.css']) {
      assert.ok(files.includes(expected), `нет ${expected}`);
    }
  });

  it('нет исходников .ts (кроме объявлений), тестов и скриптов сборки', () => {
    assert.deepEqual(
      files.filter((f) => (f.endsWith('.ts') && !f.endsWith('.d.ts')) || f.startsWith('test/') || f.startsWith('scripts/') || f.startsWith('src/')),
      [],
    );
  });
});
