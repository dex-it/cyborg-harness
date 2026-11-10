import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runCommand, tryCommand } from '../../../core/test/run-command.ts';

// Форма пакета cyborg-plugin: bin, exports и files отвечают за обещания README. Раньше это держали core/test/package.test.ts и consumer.test.ts
// (пока команда жила в ядре). Пакет собирает `npm run build:tools` (его гоняют pretest/pretypecheck/prelint/prebuild).
const pkg = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>;
  main?: string;
  types?: string;
  exports?: Record<string, string | Record<string, string>>;
};

const exportTargets = (): string[] =>
  Object.values(manifest.exports ?? {})
    .flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)))
    .filter((p) => p !== './package.json');

const binTarget = (): string => path.join(pkg, manifest.bin?.['cyborg-plugin'] ?? 'bin-не-объявлен');

describe('package.json cyborg-plugin: bin, exports, состав пакета', () => {
  it('после сборки пакета ссылка node_modules/.bin/cyborg-plugin стоит: скрипты check и build копии шаблона в клоне её зовут (P-05, ревью)', () => {
    // `npm ci` ставит ссылки bin до того, как пакет собран, и для отсутствующей цели не создаёт её; ссылку возвращает `npm rebuild` в build:tools.
    const link = path.join(pkg, '..', '..', 'node_modules', '.bin', 'cyborg-plugin');
    assert.ok(fs.existsSync(link), `${link}: ссылки нет (npm run build:tools)`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(binTarget()));
  });

  it('bin ведёт на существующий файл, первая строка - shebang node, файл исполняемый', () => {
    assert.deepEqual(Object.keys(manifest.bin ?? {}), ['cyborg-plugin']);
    assert.ok(fs.existsSync(binTarget()), `${binTarget()}: цели bin нет (npm run build:tools)`);
    assert.equal(fs.readFileSync(binTarget(), 'utf8').split('\n')[0], '#!/usr/bin/env node');
    assert.ok((fs.statSync(binTarget()).mode & 0o111) !== 0, 'у цели bin нет права на запуск');
  });

  it('bin запускается как программа: без команды код 2 и справка, check несуществующего каталога - код 1', () => {
    const run = (args: string[]): { status: number; stderr: string } => {
      const { code, out } = tryCommand(binTarget(), args);
      return { status: code, stderr: out };
    };
    const none = run([]);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /Использование:/);
    assert.equal(run(['check', path.join(pkg, 'нет-такого-каталога')]).status, 1);
  });

  it('main, types и все цели exports существуют и лежат в dist', () => {
    for (const rel of [manifest.main, manifest.types, ...exportTargets()]) {
      assert.ok(rel !== undefined && fs.existsSync(path.join(pkg, rel)), `${String(rel)}: файла нет (npm run build:tools)`);
    }
    for (const target of exportTargets()) assert.match(target, /^\.\/dist\/.+\.(js|d\.ts)$/, target);
  });

  it('npm pack --dry-run кладёт в пакет только dist, README и package.json', () => {
    const out = runCommand('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg });
    const [packed] = JSON.parse(out) as [{ files: { path: string }[] }];
    const names = packed.files.map((f) => f.path);
    assert.deepEqual(names.filter((n) => n !== 'package.json' && n !== 'README.md' && !n.startsWith('dist/')), []);
    for (const needed of ['README.md', 'dist/src/cli-bin.js', 'dist/src/index.js']) assert.ok(names.includes(needed), `${needed} нет в пакете: ${names.join(',')}`);
  });
});
