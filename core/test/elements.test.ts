import assert from 'node:assert/strict';
import test from 'node:test';
import type { TreeItem } from '@cyborg/contracts';
import { checkItems, checkTree, stepIndex, stepTab, treeKey, visibleRows } from '../src/elements-model.ts';

const TREE: TreeItem[] = [
  { id: 'src', label: 'src', children: [{ id: 'a', label: 'a.ts' }, { id: 'lib', label: 'lib', children: [{ id: 'b', label: 'b.ts' }] }] },
  { id: 'readme', label: 'README.md' },
];

test('элементы: пункты от плагина проверяются с местом ошибки', () => {
  assert.deepEqual(checkItems('cy-list', [{ id: 'x', label: 'X' }]), [{ id: 'x', label: 'X' }]);
  assert.throws(() => checkItems('cy-list', 'x'), /cy-list: items - массив/);
  assert.throws(() => checkItems('cy-list', [{ id: '', label: 'X' }]), /\[0\]\.id - непустая строка/);
  assert.throws(() => checkItems('cy-list', [{ id: 'x', label: 1 }]), /\[0\]\.label - строка/);
  assert.throws(() => checkItems('cy-tabs', [{ id: 'x', label: 'a' }, { id: 'x', label: 'b' }]), /cy-tabs: id "x" повторяется/);
  assert.equal(checkTree('cy-tree', TREE), TREE);
  assert.throws(() => checkTree('cy-tree', [{ id: 'a', label: 'A', children: [{ id: 'a', label: 'A' }] }]), /id "a" повторяется/, 'id уникален во всём дереве');
  assert.throws(() => checkTree('cy-tree', [{ id: 'a', label: 'A', children: {} }]), /\[0\]\.children - массив/);
});

test('элементы: дерево показывает детей только раскрытых ветвей', () => {
  assert.deepEqual(visibleRows(TREE, new Set()).map((r) => r.id), ['src', 'readme']);
  const rows = visibleRows(TREE, new Set(['src', 'lib']));
  assert.deepEqual(rows.map((r) => [r.id, r.depth, r.parent, r.branch, r.expanded]), [
    ['src', 0, undefined, true, true],
    ['a', 1, 'src', false, false],
    ['lib', 1, 'src', true, true],
    ['b', 2, 'lib', false, false],
    ['readme', 0, undefined, false, false],
  ]);
  assert.deepEqual(visibleRows(TREE, new Set(['lib'])).map((r) => r.id), ['src', 'readme'], 'раскрытая ветвь внутри свёрнутой не видна');
});

test('элементы: ход по списку и по вкладкам', () => {
  assert.equal(stepIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(stepIndex(-1, 3, 'ArrowUp'), 2);
  assert.equal(stepIndex(2, 3, 'ArrowDown'), 2, 'список не закольцован');
  assert.equal(stepIndex(1, 3, 'Home'), 0);
  assert.equal(stepIndex(1, 3, 'End'), 2);
  assert.equal(stepIndex(1, 3, 'a'), undefined);
  assert.equal(stepIndex(0, 0, 'ArrowDown'), undefined);
  assert.equal(stepTab(2, 3, 'ArrowRight'), 0, 'вкладки закольцованы');
  assert.equal(stepTab(0, 3, 'ArrowLeft'), 2);
  assert.equal(stepTab(-1, 3, 'ArrowLeft'), 2);
  assert.equal(stepTab(1, 3, 'End'), 2);
  assert.equal(stepTab(1, 3, 'ArrowDown'), undefined);
});

test('элементы: клавиши дерева - вправо раскрывает и входит, влево сворачивает и выходит', () => {
  const closed = visibleRows(TREE, new Set());
  assert.deepEqual(treeKey(closed, 'src', 'ArrowRight'), { toggle: 'src', expanded: true });
  const open = visibleRows(TREE, new Set(['src']));
  assert.deepEqual(treeKey(open, 'src', 'ArrowRight'), { select: 'a' });
  assert.deepEqual(treeKey(open, 'a', 'ArrowRight'), undefined, 'у листа вправо - ничего');
  assert.deepEqual(treeKey(open, 'a', 'ArrowLeft'), { select: 'src' });
  assert.deepEqual(treeKey(open, 'src', 'ArrowLeft'), { toggle: 'src', expanded: false });
  assert.deepEqual(treeKey(open, 'readme', 'ArrowLeft'), undefined, 'у корня влево - ничего');
  assert.deepEqual(treeKey(open, 'a', 'ArrowDown'), { select: 'lib' });
  assert.deepEqual(treeKey(open, undefined, 'ArrowDown'), { select: 'src' });
  assert.deepEqual(treeKey(open, 'readme', 'ArrowDown'), undefined, 'с последней строки вниз - ничего');
  assert.deepEqual(treeKey(open, 'a', 'End'), { select: 'readme' });
});
