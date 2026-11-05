import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewDrags } from './view-drag.ts';

test('перетаскивание: приёмник забирает путь и источник один раз', () => {
  const drags = new ViewDrags();
  assert.deepEqual(drags.start('alice', '/demo/notes.md'), { from: 'alice', path: '/demo/notes.md' });
  assert.deepEqual(drags.take(), { from: 'alice', path: '/demo/notes.md' });
  assert.equal(drags.take(), undefined);
});

test('перетаскивание: новое заменяет прежнее, конец старого не трогает новое', () => {
  const drags = new ViewDrags();
  const first = drags.start('alice', '/a.md');
  assert.ok(first);
  drags.start('bob', '/b.md');
  drags.end(first);
  assert.deepEqual(drags.take(), { from: 'bob', path: '/b.md' });
});

test('перетаскивание: сброс мимо видов не оставляет путь следующему сбросу', () => {
  const drags = new ViewDrags();
  const drag = drags.start('alice', '/demo/notes.md');
  assert.ok(drag);
  drags.end(drag);
  assert.equal(drags.take(), undefined);
});

test('перетаскивание: не абсолютный, ненормальный и не строковый путь не принимается', () => {
  const drags = new ViewDrags();
  for (const bad of ['demo/notes.md', '/demo/../etc/passwd', '/demo//notes.md', '', '/a\0b', 42, undefined, '/' + 'a'.repeat(5000)]) {
    assert.equal(drags.start('alice', bad), undefined, String(bad).slice(0, 40));
  }
  assert.equal(drags.take(), undefined);
});
