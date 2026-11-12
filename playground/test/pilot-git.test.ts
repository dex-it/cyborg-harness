import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
  assert.deepEqual(await p.gitCalls().then((r) => r.length), 3, 'отказанные вызовы git не запускали: только config, ls-files и status одного разрешённого');
});

test('git: status не запускает команду из .git/config чужого репозитория (core.fsmonitor), статус идёт с закреплёнными аргументами', async () => {
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

  assert.deepEqual((await p.gitRuns())[0], '--no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null status --porcelain=v1 -z --branch');
});

/** Репозиторий с фильтром `filter.x.clean`, который при запуске создаёт маркер, и изменённым `a.txt` без смены размера: по stat git не отличит правку, поэтому читает файл через фильтр. */
async function filterRepo(box: Awaited<ReturnType<typeof sandbox>>, config: readonly (readonly [string, string])[] = []) {
  const repo = await makeRepo(box, { ...FILES, '.gitattributes': '*.txt filter=x\n' });
  const marker = box.path('filter-ran');
  git(repo, 'config', 'filter.x.clean', `sh -c 'touch "${marker}"; cat'`);
  for (const [key, value] of config) git(repo, 'config', key, value);
  await writeFile(path.join(repo, 'a.txt'), 'b\n');
  return { repo, marker };
}

// Контроль без защиты: `--no-optional-locks` не даёт git обновить индекс, поэтому следующий запуск видит тот же расхождение stat и снова гонит фильтр.
function controlRan(repo: string, marker: string): boolean {
  execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: repo, stdio: 'ignore' });
  const ran = existsSync(marker);
  rmSync(marker, { force: true });
  return ran;
}

test('git: status не запускает clean-фильтр из .git/config чужого репозитория (filter.*.clean), изменения при этом видны', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const { repo, marker } = await filterRepo(box, [['filter.x.required', 'true']]);
  assert.ok(controlRan(repo, marker), 'контроль: без перекрытия этот git запускает фильтр - проверка осмысленна');
  await using p = await startPilot({ box, repo, ids: ['git'], probes: [reader(repo)] });
  const status = (await p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo])) as GitStatus;
  assert.deepEqual(status.changes.map((c) => `${c.index}${c.worktree} ${c.path}`), [' M a.txt'], '`required` не роняет status: ключ перекрыт значением false');
  assert.equal(existsSync(marker), false, 'фильтр репозитория выполнен');
  const calls = await p.gitCalls();
  assert.equal(calls.length, 3, 'config, ls-files, status');
  // config и ls-files независимы и идут параллельно, status - последним.
  assert.ok(calls.slice(0, 2).some((c) => c.includes('config --show-scope --null --name-only --get-regexp')));
  assert.ok(calls.slice(0, 2).some((c) => c.endsWith('ls-files --stage -z')));
  assert.ok(calls[2]?.endsWith(' status --porcelain=v1 -z --branch'));
});

test('git: фильтр вложенного репозитория (подмодуль) тоже перекрыт, фильтр пользователя остаётся', async () => {
  await using box = await sandbox('cyborg-pl04-');
  const inner = await makeRepo(box, { 'in.txt': 'i\n', '.gitattributes': '*.txt filter=x\n' }, 'inner');
  const repo = await makeRepo(box, FILES);
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub');
  git(repo, 'commit', '-q', '-m', 'sub');
  const marker = box.path('filter-ran');
  git(box.path('repo', 'sub'), 'config', 'filter.x.clean', `sh -c 'touch "${marker}"; cat'`);
  await writeFile(path.join(repo, 'sub', 'in.txt'), 'j\n');
  assert.ok(controlRan(repo, marker), 'контроль: status родителя гонит фильтр подмодуля');
  await using p = await startPilot({ box, repo, ids: ['git'], probes: [reader(repo)] });
  const status = (await p.k.callAs('reader', 'cyborg.git', 1, 'status', [repo])) as GitStatus;
  assert.deepEqual(status.changes.map((c) => c.path), ['sub']);
  assert.equal(existsSync(marker), false, 'фильтр подмодуля выполнен');
  assert.ok((await p.gitCalls()).some((c) => c.includes('ls-files --stage -z')));
});

test('git: правила process закрепляют перекрытие фильтров: config и ls-files с фиксированным выражением, переменные GIT_CONFIG_* только у git', async () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'git', 'manifest.json'), 'utf8')) as { permissions: { process: { program: string; args: string[]; env?: string[] }[] } };
  const rules = manifest.permissions.process;
  const safe = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
  assert.deepEqual(rules.map((r) => r.args.slice(safe.length).join(' ')), ['status --porcelain=v1 -z --branch', 'config --show-scope --null --name-only --get-regexp ^filter\\..+\\.(clean|process|required)$', 'ls-files --stage -z']);
  for (const r of rules) assert.deepEqual(r.args.slice(0, safe.length), safe);
  assert.deepEqual(rules[0]?.env, ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_*', 'GIT_CONFIG_VALUE_*']);
  assert.deepEqual(rules[1]?.env, ['LC_ALL']);
  assert.equal(rules[2]?.env, undefined);
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

// K-34: хвост argv после закреплённого префикса. Проба получает правила process манифеста git и зовёт ctx.os.process напрямую.
const ROGUE_GIT = `
export default {
  activate(ctx) {
    ctx.commands.register('rogue.run', async (args) => {
      try {
        const r = await ctx.os.process.run('git', args, {});
        return { ok: true, code: r.code };
      } catch (e) {
        return { ok: false, code: e.code };
      }
    });
    return undefined;
  },
};
`;

test('ST-3002/2: git: deny правил process отклоняет -c, --output и --exec-path в хвосте argv, в том числе в форме флаг=значение; чтение без них проходит', async () => {
  await using box = await sandbox('cyborg-k34-');
  const repo = await makeRepo(box, FILES);
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'plugins', 'git', 'manifest.json'), 'utf8')) as { permissions: { process: { args: string[]; deny?: string[] }[] } };
  for (const r of manifest.permissions.process) assert.ok(['-c', '--output', '--exec-path', '--config-env'].every((f) => r.deny?.includes(f)), r.args.join(' '));
  await using p = await startPilot({ box, repo, ids: [], probes: [{ id: 'rogue', source: ROGUE_GIT, commands: { 'rogue.run': { args: ['strings'] } }, permissions: { process: manifest.permissions.process } }] });
  const run = (...tail: string[]) => p.k.run('rogue.run', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '--stage', '-z', ...tail]) as Promise<{ ok: boolean; code?: string | number }>;
  const marker = box.path('out.txt');
  for (const tail of [['-c', 'core.sshCommand=touch x'], ['--output', marker], [`--output=${marker}`], ['--exec-path=/tmp/evil']]) {
    assert.deepEqual(await run(...tail), { ok: false, code: 'PermissionDenied' }, tail.join(' '));
  }
  assert.equal(existsSync(marker), false, 'git не запускался');
  const flags = p.k.journal.flatMap((e) => (e.kind === 'denied' && e.pluginId === 'rogue' ? [e.detail] : []));
  assert.deepEqual(flags, ['запрещён флаг -c в правиле process: git', 'запрещён флаг --output в правиле process: git', 'запрещён флаг --exec-path в правиле process: git']);
  assert.deepEqual(await run(), { ok: true, code: 0 });
});
