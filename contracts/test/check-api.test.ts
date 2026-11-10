import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readSnapshot, renderSnapshot, SNAPSHOT_FILE } from '../scripts/api.ts';
import { main } from '../scripts/check-api.ts';
import { runCommand } from '../../core/test/run-command.ts';

// Команда, которую зовёт CI: `check:contracts [--base <ref>]`. Ветка назначения здесь - временный репозиторий с нужным снимком.
describe('check-api', () => {
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-cli-'));
  const snapshotFile = path.join(work, 'snapshot.txt');
  const repo = path.join(work, 'repo');
  const real = readSnapshot();
  const git = (...args: string[]): string => runCommand('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });

  /** Коммит во временном репозитории со снимком `snapshot` (или без файла) и его хэш. */
  function commit(snapshot: string | undefined): string {
    const file = path.join(repo, 'contracts', 'api-snapshot.txt');
    fs.rmSync(path.join(repo, 'contracts'), { recursive: true, force: true });
    fs.mkdirSync(path.join(repo, 'contracts'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'README'), String(Math.random()));
    if (snapshot !== undefined) fs.writeFileSync(file, snapshot);
    git('add', '-A');
    git('commit', '-q', '-m', 'x');
    return git('rev-parse', 'HEAD').trim();
  }

  before(() => {
    fs.mkdirSync(repo);
    git('init', '-q');
    fs.copyFileSync(SNAPSHOT_FILE, snapshotFile);
  });
  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('снимок совпадает с декларациями: код 0', () => {
    const result = main([], { snapshotFile });
    assert.equal(result.code, 0);
    assert.match(result.out, /совпадают со снимком/);
  });

  it('снимок устарел: код 1, причина в stderr', () => {
    const stale = path.join(work, 'stale.txt');
    fs.writeFileSync(stale, renderSnapshot(real.version, real.body + 'export type Extra = 1;\n'));
    const result = main([], { snapshotFile: stale });
    assert.equal(result.code, 1);
    assert.match(result.err, /декларации пакета изменены/);
  });

  it('--update переписывает снимок', () => {
    const target = path.join(work, 'update.txt');
    fs.writeFileSync(target, renderSnapshot(real.version, 'устарело\n'));
    assert.equal(main(['--update'], { snapshotFile: target }).code, 0);
    assert.deepEqual(readSnapshot(target), real);
  });

  it('--base: ветка назначения с тем же снимком - код 0', () => {
    const base = commit(fs.readFileSync(snapshotFile, 'utf8'));
    const result = main(['--base', base], { snapshotFile, gitDir: repo });
    assert.equal(result.code, 0);
    assert.match(result.out, /согласована/);
  });

  it('--base: в ветке назначения выпущенная версия, у ветки ниже - код 1', () => {
    const base = commit(renderSnapshot('1.0.0', real.body));
    const result = main(['--base', base], { snapshotFile, gitDir: repo });
    assert.equal(result.code, 1);
    assert.match(result.err, /понижена/);
  });

  it('--base: в ветке назначения снимка нет - код 0 с пометкой', () => {
    const base = commit(undefined);
    const result = main(['--base', base], { snapshotFile, gitDir: repo });
    assert.equal(result.code, 0);
    assert.match(result.out, /снимка нет/);
  });

  it('--base без ссылки или с неизвестной ссылкой - исключение, а не молчаливый пропуск', () => {
    assert.throws(() => main(['--base'], { snapshotFile, gitDir: repo }), /требует ссылку/);
    assert.throws(() => main(['--base', 'нет-такой-ветки'], { snapshotFile, gitDir: repo }));
  });
});
