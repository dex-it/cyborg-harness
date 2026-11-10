import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitStatus, TreeMark } from '@cyborg-harness/contracts';
import { waitFor } from '../../core/test/wait-for.ts';
import { git, makeRepo, sandbox, startPilot } from './pilot-kit.ts';

// PL-04: плагин git над настоящим репозиторием, на хосте-процессе (forkHosts). Потребитель - проба с нужными правами; контракт зовёт ядро, права вызывающего сверяет guard.
const reader = (repo: string) => ({ id: 'reader', requires: { 'cyborg.git': '^1' }, consumes: { 'cyborg.tree-decoration': '^1' }, permissions: { 'fs.read': [repo] } });
const FILES = { 'a.txt': 'a\n', 'src/b.ts': 'b\n', 'src/deep/c.ts': 'c\n' };

test('git: status и отметки настоящего репозитория через границу хостов', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, FILES);
  const plain = box.path('plain');
  await mkdir(plain);
  await using p = await startPilot({ box, repo, roots: [repo, plain], ids: ['git'], probes: [{ ...reader(repo), permissions: { 'fs.read': [repo, plain] } }] });
  assert.deepEqual(p.k.active.toSorted(), ['git', 'reader']);
  assert.notEqual(p.k.hostOf('git'), p.k.hostOf('reader'), 'git и потребитель в разных хостах');

  const clean = (await p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo])) as GitStatus;
  assert.deepEqual(clean, { branch: 'main', ahead: 0, behind: 0, changes: [] });

  await appendFile(path.join(repo, 'a.txt'), 'x\n');
  await writeFile(path.join(repo, 'src', 'new.ts'), 'n\n');
  git(repo, 'rm', '-q', 'src/b.ts');
  const dirty = (await p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo])) as GitStatus;
  assert.deepEqual(dirty.changes.map((c) => `${c.index}${c.worktree} ${c.path}`).toSorted(), ['?? src/new.ts', 'D  src/b.ts', ' M a.txt'].toSorted());
  const marks = (await p.k.run('reader.call', 'cyborg.tree-decoration', 'marks', repo)) as TreeMark[];
  assert.deepEqual(marks.toSorted((a, b) => a.path.localeCompare(b.path)), [
    { path: 'a.txt', kind: 'modified' },
    { path: 'src/b.ts', kind: 'deleted' },
    { path: 'src/new.ts', kind: 'untracked' },
  ]);
  assert.equal(await p.k.callAs('reader', 'cyborg.git', 1, 'status', [plain]), null, 'не репозиторий - null, а не ошибка');
});

test('git: вызывающий без права читать репозиторий сведений не получает; право вызывающего не расширяет права git (пересечение)', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, FILES);
  const other = await makeRepo(box, FILES, 'other');
  const consumer = (id: string, permissions?: Record<string, unknown>) => ({ id, requires: { 'cyborg.git': '^1' }, consumes: { 'cyborg.tree-decoration': '^1' }, ...(permissions && { permissions }) });
  // other лежит вне корней воркспейса: у git права на него нет, у `wide` - есть.
  await using p = await startPilot({ box, repo, ids: ['git'], probes: [consumer('nosy'), consumer('wide', { 'fs.read': [other, repo] })] });
  await assert.rejects(p.k.callAs('nosy', 'cyborg.git', 1, 'status', [repo]), { code: 'PermissionDenied' });
  await assert.rejects(p.k.run('nosy.call', 'cyborg.tree-decoration', 'marks', repo), { code: 'PermissionDenied' });
  await assert.rejects(p.k.callAs('nosy', 'cyborg.git', 1, 'status', [123]), { code: 'Invalid' }, 'не строка - отказ, а не пропуск');
  const denied = p.k.journal.flatMap((e) => (e.kind === 'denied' ? [`${e.pluginId}:${e.reason ?? '-'}`] : []));
  assert.deepEqual(denied.slice(0, 2), ['nosy:via-contract', 'nosy:via-contract']);
  await assert.rejects(p.k.callAs('wide', 'cyborg.git', 1, 'status', [other]), { code: 'PermissionDenied' }, 'вызывающий читает, а git - нет');
  assert.equal(((await p.k.callAs('wide', 'cyborg.git', 1, 'status', [repo])) as GitStatus).branch, 'main');
  assert.deepEqual(await p.gitRuns().then((r) => r.length), 1, 'отказанные вызовы git не запускали');
});

test('git: status не запускает команду из .git/config чужого репозитория (core.fsmonitor), правило process закрепляет аргументы', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, FILES);
  const marker = box.path('pwned');
  git(repo, 'config', 'core.fsmonitor', `touch '${marker}'; true`);
  // Контроль: без защиты тот же status в этом git запускает команду - иначе проверка ниже ничего бы не доказывала.
  try {
    execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: 'ignore' });
  } catch {
    // Версия git без поддержки команды в fsmonitor: контроль ниже скажет об этом.
  }
  const controlRan = existsSync(marker);
  await rm(marker, { force: true });
  await using p = await startPilot({ box, repo, ids: ['git'], probes: [reader(repo)] });
  assert.equal(((await p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo])) as GitStatus).branch, 'main');
  assert.equal(existsSync(marker), false, 'команда fsmonitor из конфига репозитория выполнена');
  assert.ok(controlRan, 'контроль: этот git запускает core.fsmonitor без защиты - проверка осмысленна');

  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'git', 'manifest.json'), 'utf8')) as { permissions: { process: { program: string; args: string[] }[] } };
  assert.deepEqual(manifest.permissions.process, [{ program: 'git', args: ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain=v1', '-z', '--branch'] }]);
  assert.deepEqual((await p.gitRuns())[0], '--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null status --porcelain=v1 -z --branch');
});

test('git: параллельные status одного репозитория склеиваются - не больше двух запусков на пачку, и последний видит правку, сделанную во время первого', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, FILES);
  await using p = await startPilot({ box, repo, ids: ['git'], probes: [reader(repo)] });
  const ask = () => p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo]) as Promise<GitStatus>;
  const first = ask();
  await writeFile(path.join(repo, 'late.txt'), 'x');
  const rest = await Promise.all([ask(), ask(), ask(), ask(), ask(), ask()]);
  await first;
  assert.ok((await p.gitRuns()).length <= 2, `запусков: ${String((await p.gitRuns()).length)}`);
  for (const s of rest) assert.ok(s.changes.some((c) => c.path === 'late.txt'), 'вызов, начатый после правки, не вернул ответ старше правки');
});

test('git: onChange срабатывает на add, commit и checkout снаружи, правка файла рабочего дерева его не будит; отписка и выгрузка снимают слежение за .git', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, FILES);
  await using p = await startPilot({ box, repo, ids: ['git'], probes: [reader(repo)] });
  await p.k.run('reader.watch', 'cyborg.git', 'onChange', repo);
  await waitFor('слежение за .git открыто', () => p.watches.opened.includes(path.join(repo, '.git')));
  const events = () => p.k.run('reader.events') as Promise<unknown[]>;

  await appendFile(path.join(repo, 'a.txt'), 'x\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await events(), [], 'правка файла: индекс не менялся, оповещения нет');
  // Имя в .git вне перечня (fetch, редактор сообщения коммита): отметок дерева оно не меняет.
  await writeFile(path.join(repo, '.git', 'FETCH_HEAD'), 'x\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(await events(), [], 'FETCH_HEAD не входит в перечень имён');

  git(repo, 'add', 'a.txt');
  assert.ok((await waitFor('оповещение после add', async () => ((await events()).length > 0 ? true : undefined))));
  git(repo, 'commit', '-q', '-m', 'second');
  await waitFor('оповещение после commit', async () => ((await events()).length > 0 ? true : undefined));
  git(repo, 'checkout', '-q', '-b', 'feat');
  await waitFor('оповещение после checkout', async () => ((await events()).length > 0 ? true : undefined));
  assert.equal(((await p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo])) as GitStatus).branch, 'feat');

  await p.k.disable('reader');
  await waitFor('слежение за .git снято при выгрузке потребителя', () => p.watches.live() === 0);
});

test('git: .git - не каталог (worktree, подмодуль) - status работает, слежения нет, ошибки нет; симлинк в репозитории не мешает', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, FILES);
  git(repo, 'worktree', 'add', '-q', '-b', 'wt', box.path('wt'));
  await symlink(path.join(repo, 'a.txt'), box.path('wt', 'link.txt'));
  await mkdir(box.path('wt', 'extra'));
  await using p = await startPilot({ box, repo: box.path('wt'), ids: ['git'], probes: [reader(box.path('wt'))] });
  await p.k.run('reader.watch', 'cyborg.git', 'onChange', box.path('wt'));
  const status = (await p.k.callAs('reader', 'cyborg.git', 1, 'status', [box.path('wt')])) as GitStatus;
  assert.equal(status.branch, 'wt');
  assert.deepEqual(status.changes.map((c) => c.path), ['link.txt']);
  assert.equal(p.watches.opened.length, 0, 'у .git-файла слежения нет');
});
