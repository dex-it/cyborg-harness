import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceKey } from '@cyborg-harness/core';
import { instanceKey, newWindowArgs, NO_WORKSPACE_KEY, sessionDataDir } from '../src/instances.ts';

// K-20: несколько процессов с общим userData. Ключ экземпляра и каталог сессии Chromium - по воркспейсу; новое окно - процесс с теми же флагами.

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-inst-')));
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

const FLAGS = { workspace: '--workspace=', noWorkspace: '--no-workspace', safeMode: '--safe-mode' };

test('ключ экземпляра - ключ воркспейса: тот же файл через симлинк - тот же экземпляр; окно без воркспейса - свой ключ', async () => {
  await using box = await sandbox();
  const file = path.join(box.root, 'a.cyborg.json');
  await writeFile(file, '{}');
  await symlink(file, path.join(box.root, 'link.json'));
  const data = path.join(box.root, 'user-data');
  assert.equal(instanceKey(file, data), workspaceKey(file));
  assert.equal(instanceKey(path.join(box.root, 'link.json'), data), instanceKey(file, data));
  assert.equal(instanceKey(file, data), instanceKey(file, path.join(box.root, 'other-data')), 'воркспейс один и тот же - userData значения не имеет');
  assert.notEqual(instanceKey(path.join(box.root, 'b.cyborg.json'), data), instanceKey(file, data));
  assert.ok(instanceKey(undefined, data).startsWith(NO_WORKSPACE_KEY));
  assert.notEqual(instanceKey(undefined, data), instanceKey(undefined, path.join(box.root, 'other-data')), 'окна без воркспейса двух userData совпали');
  assert.notEqual(instanceKey(undefined, data), instanceKey(file, data), 'ключ окна без воркспейса совпал с ключом воркспейса');
});

test('сессия Chromium по воркспейсу: у каждого свой каталог внутри userData, localStorage и кэш не смешиваются', async () => {
  await using box = await sandbox();
  const a = sessionDataDir(box.root, path.join(box.root, 'a.cyborg.json'));
  const b = sessionDataDir(box.root, path.join(box.root, 'b.cyborg.json'));
  const bare = sessionDataDir(box.root, undefined);
  assert.equal(new Set([a, b, bare]).size, 3);
  for (const dir of [a, b, bare]) assert.equal(path.dirname(dir), path.join(box.root, 'workspaces'));
  assert.equal(path.basename(a), workspaceKey(path.join(box.root, 'a.cyborg.json')));
  assert.equal(path.basename(bare), NO_WORKSPACE_KEY);
});

test('новое окно: аргументы текущего процесса, воркспейс заменён, отладочные порты не наследуются', () => {
  const argv = ['/app', '--inspect=0', '--user-data-dir=/u', '--remote-debugging-port=9222', '--workspace=/old.json', '--safe-mode', '--user-plugins'];
  assert.deepEqual(newWindowArgs(argv, '/new.json', FLAGS), ['/app', '--user-data-dir=/u', '--safe-mode', '--user-plugins', '--workspace=/new.json']);
  assert.deepEqual(newWindowArgs(['/app', '--no-workspace'], '/new.json', FLAGS), ['/app', '--workspace=/new.json']);
  assert.deepEqual(newWindowArgs(['/app', '--inspect-brk=9229', '--remote-debugging-pipe'], '/new.json', FLAGS), ['/app', '--workspace=/new.json']);
});
