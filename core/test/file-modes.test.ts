// TR-05 (docs/research/trust-and-isolation/06-work-plan.md): файлы данных приложения в userData создаются 0600, свои каталоги 0700 независимо от umask.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RecentWorkspaces } from '../src/recent.ts';
import { openWorkspace } from '../src/workspace.ts';

const posix = process.platform !== 'win32';
const mode = async (file: string): Promise<string> => ((await stat(file)).mode & 0o777).toString(8);

/** Процесс под umask: теста с `umask 022` недостаточно, если права случайно сошлись с умолчанием, поэтому прогоняется и `000` (файлы по умолчанию были бы 0666). */
async function withUmask<T>(mask: number, run: () => Promise<T>): Promise<T> {
  const before = process.umask(mask);
  try {
    return await run();
  } finally {
    process.umask(before);
  }
}

for (const mask of [0o022, 0o000]) {
  test(`ST-3004/6: cyborg.json, state и «Недавние» создаются 0600, каталог state 0700 при umask ${mask.toString(8).padStart(3, '0')}`, { skip: !posix }, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-modes-')));
    try {
      await withUmask(mask, async () => {
        const file = path.join(root, 'team.cyborg.json');
        const userFile = path.join(root, 'user', 'cyborg.json');
        const stateDir = path.join(root, 'state');
        await mkdir(path.dirname(userFile), { recursive: true });
        const opened = await openWorkspace({ file, userFile, stateDir });
        assert.ok(opened.ok);
        await opened.workspace.config.write('user', 'plugin-a', 1, { a: 1 });
        await opened.workspace.state.write('workspace', 'plugin-a', 1, { b: 2 });
        opened.workspace.close();
        new RecentWorkspaces(path.join(root, 'recent.json')).add(file);

        assert.equal(await mode(userFile), '600', 'cyborg.json (слой пользователя)');
        assert.equal(await mode(opened.workspace.stateFile), '600', 'state воркспейса');
        assert.equal(await mode(stateDir), '700', 'каталог state');
        assert.equal(await mode(path.join(root, 'recent.json')), '600', '«Недавние»');
        // Файл воркспейса лежит там, где его выбрал человек (репозиторий команды): права ему не меняются.
        assert.notEqual(await mode(file), '600');
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('ST-3004/6: каталог state, созданный раньше с открытыми правами, сужается при первой записи, прежний открытый cyborg.json заменяется закрытым', { skip: !posix }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-modes-')));
  try {
    await withUmask(0o022, async () => {
      const userFile = path.join(root, 'cyborg.json');
      const stateDir = path.join(root, 'state');
      await mkdir(stateDir, { mode: 0o755 });
      await writeFile(userFile, '{"cyborg":2,"settings":{}}', { mode: 0o644 });
      assert.equal(await mode(stateDir), '755');
      const opened = await openWorkspace({ file: path.join(root, 'w.cyborg.json'), userFile, stateDir });
      assert.ok(opened.ok);
      await opened.workspace.state.write('workspace', 'plugin-a', 1, { b: 2 });
      await opened.workspace.config.write('user', 'plugin-a', 1, { a: 1 });
      opened.workspace.close();
      assert.equal(await mode(stateDir), '700');
      assert.equal(await mode(userFile), '600');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
