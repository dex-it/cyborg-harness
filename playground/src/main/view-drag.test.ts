import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDragFile, ViewDrags } from './view-drag.ts';

test('перетаскивание: путь получает только вид под курсором, один раз', async () => {
  const drags = new ViewDrags();
  const drag = drags.start('alice', 'notes.md');
  const thief = drags.take('eve');
  const owner = drags.take('bob');
  drags.landed(drag, 'bob');
  assert.equal(await thief, undefined);
  assert.deepEqual(await owner, { from: 'alice', path: 'notes.md' });
  assert.equal(await drags.take('bob'), undefined);
});

test('перетаскивание: без перетаскивания и при сбросе мимо видов пути нет', async () => {
  const drags = new ViewDrags();
  assert.equal(await drags.take('bob'), undefined);
  const drag = drags.start('alice', 'notes.md');
  drags.landed(drag, undefined);
  assert.equal(await drags.take('bob'), undefined);
});

test('перетаскивание: конец ждущего приёмника отпускает, новое перетаскивание не трогается концом старого', async () => {
  const drags = new ViewDrags();
  const first = drags.start('alice', 'a.md');
  const waiting = drags.take('bob');
  drags.end(first);
  assert.equal(await waiting, undefined);
  const old = drags.start('alice', 'a.md');
  const next = drags.start('bob', 'b.md');
  drags.end(old);
  drags.landed(old, 'bob');
  drags.landed(next, 'alice');
  assert.deepEqual(await drags.take('alice'), { from: 'bob', path: 'b.md' });
});

test('перетаскивание: только существующий файл внутри корня, ссылка наружу не выводит', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drag-'));
  const root = path.join(tmp, 'workspace');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'x');
  fs.writeFileSync(path.join(tmp, 'secret'), 'x');
  fs.symlinkSync(path.join(tmp, 'secret'), path.join(root, 'link'));
  try {
    assert.equal(resolveDragFile(root, 'docs/notes.md'), path.join(fs.realpathSync(root), 'docs', 'notes.md'));
    for (const bad of ['../secret', 'link', 'docs', 'missing.md', path.join(tmp, 'secret'), '', 'a\0b', 42, undefined, 'a'.repeat(5000)]) {
      assert.equal(resolveDragFile(root, bad), undefined, String(bad).slice(0, 40));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
