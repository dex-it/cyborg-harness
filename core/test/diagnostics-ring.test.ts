import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DiagnosticsRing } from '../src/diagnostics-ring.ts';

// K-30 (FR-CH-4011, У-49): кольцо в памяти по числу записей; шумный владелец не вытесняет записи соседа.

const ring = (capacity: number, perOwner = capacity) => new DiagnosticsRing<string>({ capacity, perOwner });

test('кольцо: записей не больше ёмкости, уходят старейшие, порядок добавления сохраняется', () => {
  const r = ring(5);
  for (let i = 0; i < 12; i++) r.add(`r${String(i)}`, 'p', false);
  assert.equal(r.size, 5);
  assert.deepEqual(r.entries(), ['r7', 'r8', 'r9', 'r10', 'r11']);
});

test('ST-4002/5: кольцо: шумный плагин не вытесняет из кольца запись о сбое соседа - ни запись состояния, ни ошибку соседа (У-49)', () => {
  const r = ring(100, 40);
  r.add('сосед: failed', 'quiet', true);
  r.add('сосед: error в строке', 'quiet', false);
  r.add('сосед: операция с ошибкой', 'quiet', false);
  for (let i = 0; i < 20_000; i++) r.add(`шум ${String(i)}`, 'noisy', false);
  const left = r.entries();
  assert.ok(left.includes('сосед: failed'));
  assert.ok(left.includes('сосед: error в строке'));
  assert.ok(left.includes('сосед: операция с ошибкой'));
  assert.equal(r.countOf('noisy'), 40, 'шумный плагин держит не больше своего предела');
  assert.equal(r.size, 43);
});

test('ST-4002/5: кольцо: переполнение уносит старейшую запись самого шумного, а не самого тихого', () => {
  const r = ring(10, 10);
  for (let i = 0; i < 3; i++) r.add(`тихий ${String(i)}`, 'quiet', false);
  for (let i = 0; i < 7; i++) r.add(`громкий ${String(i)}`, 'loud', false);
  r.add('громкий 7', 'loud', false);
  assert.deepEqual(r.entries().filter((e) => e.startsWith('тихий')), ['тихий 0', 'тихий 1', 'тихий 2']);
  assert.equal(r.countOf('loud'), 7);
  assert.equal(r.entries().includes('громкий 0'), false, 'ушла старейшая запись шумного');
});

test('кольцо: при равенстве уходит владелец с более старой записью', () => {
  const r = ring(4);
  r.add('a0', 'a', false);
  r.add('b0', 'b', false);
  r.add('a1', 'a', false);
  r.add('b1', 'b', false);
  r.add('c0', 'c', false);
  assert.deepEqual(r.entries(), ['b0', 'a1', 'b1', 'c0']);
});

test('ST-4002/5: кольцо: записи состояния не уходят, пока есть что вытеснить; остались одни они - уходит старейшая из них, предел ёмкости держится', () => {
  const r = ring(3);
  r.add('жц 0', 'p', true);
  r.add('жц 1', 'p', true);
  r.add('шум', 'p', false);
  r.add('жц 2', 'p', true);
  assert.deepEqual(r.entries(), ['жц 0', 'жц 1', 'жц 2'], 'вытеснена обычная запись, а не состояние');
  r.add('жц 3', 'p', true);
  assert.deepEqual(r.entries(), ['жц 1', 'жц 2', 'жц 3']);
  assert.equal(r.size, 3);
});

test('кольцо: очередь после многих вытеснений не растёт и отдаёт записи по порядку', () => {
  const r = ring(2000, 2000);
  for (let i = 0; i < 50_000; i++) r.add(String(i), 'p', false);
  const all = r.entries();
  assert.equal(all.length, 2000);
  assert.equal(all[0], '48000');
  assert.equal(all.at(-1), '49999');
});
