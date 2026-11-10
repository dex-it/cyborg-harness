import assert from 'node:assert/strict';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { runCommand } from './run-command.ts';

// Состав архива пакета: собранный JS, объявления и оболочка вида; исходников, тестов и скриптов сборки в нём нет.
const pkg = path.resolve(import.meta.dirname, '..');

describe('состав архива @cyborg-harness/electron (npm pack --dry-run)', () => {
  let files: string[] = [];

  before(() => {
    // Предел времени с SIGKILL и вывод при отказе: зависшая npm не должна держать весь `npm test`.
    const out = runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg });
    const [packed] = JSON.parse(out) as [{ files: { path: string }[] }];
    files = packed.files.map((f) => f.path);
  });

  it('есть сборка, объявления, оболочка вида, README, CHANGELOG и package.json', () => {
    for (const expected of ['package.json', 'README.md', 'CHANGELOG.md', 'dist/src/index.js', 'dist/src/index.d.ts', 'dist/src/host-entry.js', 'dist/src/index-preload.js', 'dist/src/index-window.js', 'dist/shell/shell.js', 'dist/shell/shell.css']) {
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
