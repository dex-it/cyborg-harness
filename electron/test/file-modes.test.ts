// TR-05: диагностика в userData - файлы 0600, каталоги 0700 независимо от umask; прежние открытые права сужаются.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { nodeDiagnosticsFs } from '../src/diagnostics-file.ts';

const posix = process.platform !== 'win32';
const mode = async (target: string): Promise<string> => ((await stat(target)).mode & 0o777).toString(8);

for (const mask of [0o022, 0o000]) {
  test(`ST-3004/6: diagnostics/<воркспейс>/*: файл 0600, каталоги 0700 при umask ${mask.toString(8).padStart(3, '0')}`, { skip: !posix }, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-diag-modes-')));
    const before = process.umask(mask);
    try {
      const dir = path.join(root, 'diagnostics', 'key');
      const fs = nodeDiagnosticsFs(dir);
      fs.append('journal.log', 'строка\n');
      fs.append('journal.log', 'ещё\n');
      assert.equal(await mode(path.join(dir, 'journal.log')), '600');
      assert.equal(await mode(dir), '700');
      assert.equal(await mode(path.dirname(dir)), '700');
    } finally {
      process.umask(before);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('ST-3004/6: каталоги и файлы диагностики, созданные раньше с открытыми правами, сужаются при первой записи', { skip: !posix }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-diag-modes-')));
  try {
    const dir = path.join(root, 'diagnostics', 'key');
    await mkdir(dir, { recursive: true });
    await chmod(path.dirname(dir), 0o755);
    await chmod(dir, 0o755);
    await writeFile(path.join(dir, 'old.log'), 'прошлый запуск\n', { mode: 0o644 });
    await chmod(path.join(dir, 'old.log'), 0o644);
    nodeDiagnosticsFs(dir).append('new.log', 'x\n');
    assert.deepEqual([await mode(path.dirname(dir)), await mode(dir), await mode(path.join(dir, 'old.log')), await mode(path.join(dir, 'new.log'))], ['700', '700', '600', '600']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
