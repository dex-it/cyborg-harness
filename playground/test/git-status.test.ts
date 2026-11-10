import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markOf, marksOf, parseStatus } from '../plugins/git/status.ts';

const z = (...fields: string[]): string => fields.join('\0') + '\0';

test('parseStatus: ветка, отслеживаемая и расхождение', () => {
  assert.deepEqual(parseStatus(z('## main')), { branch: 'main', ahead: 0, behind: 0, changes: [] });
  assert.deepEqual(parseStatus(z('## main...origin/main')), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] });
  assert.deepEqual(parseStatus(z('## main...origin/main [ahead 2, behind 3]')), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 3, changes: [] });
  assert.deepEqual(parseStatus(z('## feat/x...origin/feat/x [behind 1]')), { branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 1, changes: [] });
  assert.deepEqual(parseStatus(z('## main...origin/main [gone]')), { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: [] });
});

test('parseStatus: голова отсоединена и репозиторий без коммитов', () => {
  assert.equal(parseStatus(z('## HEAD (no branch)')).branch, null);
  assert.equal(parseStatus(z('## No commits yet on master')).branch, 'master');
  assert.equal(parseStatus(z('## Initial commit on main')).branch, 'main');
});

test('parseStatus: изменения, переименование с исходным путём, пути с пробелом и не ASCII без кавычек', () => {
  const status = parseStatus(z('## main', ' M src/a b.ts', 'A  new.ts', '?? тест.txt', 'R  to.ts', 'from.ts', 'UU conflict.ts', 'MD both.ts'));
  assert.deepEqual(status.changes, [
    { path: 'src/a b.ts', index: ' ', worktree: 'M' },
    { path: 'new.ts', index: 'A', worktree: ' ' },
    { path: 'тест.txt', index: '?', worktree: '?' },
    { path: 'to.ts', index: 'R', worktree: ' ', from: 'from.ts' },
    { path: 'conflict.ts', index: 'U', worktree: 'U' },
    { path: 'both.ts', index: 'M', worktree: 'D' },
  ]);
});

test('parseStatus: пустой вывод - чистое дерево без ветки в заголовке; мусор вместо заголовка не принимается за изменение', () => {
  assert.deepEqual(parseStatus(''), { branch: null, ahead: 0, behind: 0, changes: [] });
  assert.deepEqual(parseStatus(z('x')).changes, []);
});

test('markOf: конфликт старше всего, затем неотслеживаемый, добавленный, переименованный, удалённый, изменённый', () => {
  const change = (index: string, worktree: string) => ({ path: 'p', index, worktree }) as Parameters<typeof markOf>[0];
  assert.equal(markOf(change('U', 'U')), 'conflict');
  assert.equal(markOf(change('A', 'A')), 'conflict');
  assert.equal(markOf(change('D', 'D')), 'conflict');
  assert.equal(markOf(change('A', 'U')), 'conflict');
  assert.equal(markOf(change('?', '?')), 'untracked');
  assert.equal(markOf(change('A', 'M')), 'added');
  assert.equal(markOf(change('R', ' ')), 'renamed');
  assert.equal(markOf(change('R', 'M')), 'renamed');
  assert.equal(markOf(change(' ', 'D')), 'deleted');
  assert.equal(markOf(change('D', ' ')), 'deleted');
  assert.equal(markOf(change('M', 'D')), 'deleted');
  assert.equal(markOf(change(' ', 'M')), 'modified');
  assert.equal(markOf(change('T', ' ')), 'modified');
  assert.equal(markOf(change('C', ' ')), 'added');
});

test('marksOf: по отметке на путь, исходный путь переименования не отмечается', () => {
  const status = parseStatus(z('## main', ' M a.ts', 'R  to.ts', 'from.ts', '?? n.ts'));
  assert.deepEqual(marksOf(status), [
    { path: 'a.ts', kind: 'modified' },
    { path: 'to.ts', kind: 'renamed' },
    { path: 'n.ts', kind: 'untracked' },
  ]);
});
