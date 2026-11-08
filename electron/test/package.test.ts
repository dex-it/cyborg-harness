import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { before, describe, it } from 'node:test';

// Состав архива пакета: собранный JS, объявления и оболочка вида; исходников, тестов и скриптов сборки в нём нет.
const pkg = path.resolve(import.meta.dirname, '..');

describe('состав архива @cyborg-harness/electron (npm pack --dry-run)', () => {
  let files: string[] = [];

  before(() => {
    // Предел времени с SIGKILL, как в core/test/package.test.ts: зависшая npm не должна держать весь `npm test`.
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 90_000, killSignal: 'SIGKILL' });
    const [packed] = JSON.parse(out) as [{ files: { path: string }[] }];
    files = packed.files.map((f) => f.path);
  });

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
