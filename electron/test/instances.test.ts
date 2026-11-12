import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceKey, type Claim } from '@cyborg-harness/core';
import { claimWorkspace, instanceKey, newWindowArgs, NO_WORKSPACE_KEY, sessionDataDir } from '../src/instances.ts';

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
  // K-33: флаг записи аргументов в трассу - выбор человека за машиной, новое окно его сохраняет (как --user-plugins).
  assert.deepEqual(newWindowArgs(['/app', '--trace-args', '--workspace=/old.json'], '/new.json', FLAGS), ['/app', '--trace-args', '--workspace=/new.json']);
  assert.deepEqual(newWindowArgs(['/app', '--no-workspace'], '/new.json', FLAGS), ['/app', '--workspace=/new.json']);
  assert.deepEqual(newWindowArgs(['/app', '--inspect-brk=9229', '--remote-debugging-pipe'], '/new.json', FLAGS), ['/app', '--workspace=/new.json']);
});

// Адрес сокета ограничен ~104 байтами: каталог короткий, а `tmpdir()` macOS для `userData` + `/run/<ключ>.sock` длинноват.
async function shortSandbox() {
  const root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ci-')));
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

async function withoutRuntimeDir<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.XDG_RUNTIME_DIR;
  Reflect.deleteProperty(process.env, 'XDG_RUNTIME_DIR');
  try {
    return await run();
  } finally {
    if (saved !== undefined) process.env.XDG_RUNTIME_DIR = saved;
  }
}

const posix = process.platform !== 'win32';

/** Закрывает адрес владельца; через параметр, потому что `assert.equal(kind)` сужает тип. */
const release = (claim: Claim) => {
  if (claim.kind === 'owner') claim.close();
};

test('claimWorkspace: адреса лежат в личном каталоге userData, второй запуск передаёт данные и уходит', { skip: !posix }, async () => {
  await using box = await shortSandbox();
  await withoutRuntimeDir(async () => {
    const file = path.join(box.root, 'w.cyborg.json');
    await writeFile(file, '{}');
    const asked: unknown[] = [];
    const first = await claimWorkspace(box.root, file, { safeMode: false }, (data) => asked.push(data));
    assert.equal(first.kind, 'owner');
    assert.ok(existsSync(path.join(box.root, 'run', `${workspaceKey(file)}.sock`)), 'адрес не в userData/run');
    const second = await claimWorkspace(box.root, file, { safeMode: true }, () => assert.fail('второй стал владельцем'));
    assert.equal(second.kind, 'handed');
    assert.deepEqual(asked, [{ safeMode: true }]);
    release(first);
  });
});

test('ST-1007/2: claimWorkspace: контроль экземпляров недоступен - процесс остаётся владельцем без адреса и называет причину, а не остаётся без окна', { skip: !posix }, async () => {
  await using box = await shortSandbox();
  await withoutRuntimeDir(async () => {
    // Каталог адресов занят обычным файлом: так выглядит чужой или недоступный каталог (EEXIST/ENOTDIR при создании).
    await writeFile(path.join(box.root, 'run'), 'не каталог');
    const reasons: Error[] = [];
    const claim = await claimWorkspace(box.root, path.join(box.root, 'w.cyborg.json'), {}, () => undefined, (error) => reasons.push(error));
    assert.equal(claim.kind, 'owner', 'отказ контроля экземпляров оставил процесс без окна');
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]?.message ?? '', /run/);
    assert.doesNotThrow(() => release(claim));
  });
});
