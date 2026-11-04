import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGraph } from '../src/graph.ts';
import { parseManifest, type PluginManifest } from '../src/manifest.ts';

function m(id: string, fields: Record<string, unknown> = {}): PluginManifest {
  const r = parseManifest({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.manifest;
}

test('порядок: поставщик раньше потребителя, независимые - в порядке входа', () => {
  const g = resolveGraph(
    [
      m('sessions', { requires: { 'cyborg.files': '^1' }, optional: { 'cyborg.projects': '^1' } }),
      m('viewer'),
      m('files', { provides: { 'cyborg.files': '1.2' } }),
      m('projects', { provides: { 'cyborg.projects': '1.0' }, requires: { 'cyborg.files': '^1' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.order, ['viewer', 'files', 'projects', 'sessions']);
  assert.equal(g.bindings.get('sessions')?.get('cyborg.projects'), 'projects');
  assert.equal(g.rejected.size, 0);
});

test('отказ по engines каскадирует на зависимых, optional переживает', () => {
  const g = resolveGraph(
    [
      m('files', { engines: { cyborg: '^2' }, provides: { 'cyborg.files': '1.0' } }),
      m('sessions', { requires: { 'cyborg.files': '^1' } }),
      m('tree', { optional: { 'cyborg.files': '^1' } }),
    ],
    '1.3.0',
  );
  assert.deepEqual(g.order, ['tree']);
  assert.equal(g.rejected.get('files')?.[0]?.kind, 'engines');
  assert.deepEqual(g.rejected.get('sessions'), [{ kind: 'missing', contract: 'cyborg.files', range: '^1' }]);
  assert.equal(g.bindings.get('tree')?.size, 0);
});

test('несовместимая мажорная версия поставщика - как отсутствие', () => {
  const g = resolveGraph([m('files', { provides: { 'cyborg.files': '2.0' } }), m('sessions', { requires: { 'cyborg.files': '^1' } })], '1.0.0');
  assert.equal(g.rejected.get('sessions')?.[0]?.kind, 'missing');
});

test('поставщик с двумя мажорными версиями обслуживает старого и нового потребителя', () => {
  const g = resolveGraph(
    [
      m('files', { provides: { 'cyborg.files': ['1.4', '2.0'] } }),
      m('old', { requires: { 'cyborg.files': '^1' } }),
      m('new', { requires: { 'cyborg.files': '^2' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.order, ['files', 'old', 'new']);
});

test('два поставщика кратности one - отказ потребителю, но не поставщикам', () => {
  const g = resolveGraph(
    [
      m('lock-a', { provides: { 'cyborg.lock': '1.0' } }),
      m('lock-b', { provides: { 'cyborg.lock': '1.0' } }),
      m('menu', { optional: { 'cyborg.lock': '^1' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.rejected.get('menu'), [{ kind: 'ambiguous', contract: 'cyborg.lock', providers: ['lock-a', 'lock-b'] }]);
  assert.deepEqual(g.order, ['lock-a', 'lock-b']);
});

test('цикл отказывает всем участникам и каскадирует на зависящих от цикла', () => {
  const g = resolveGraph(
    [
      m('a', { provides: { 'x.a': '1.0' }, requires: { 'x.b': '^1' } }),
      m('b', { provides: { 'x.b': '1.0' }, optional: { 'x.a': '^1' } }),
      m('c', { requires: { 'x.a': '^1' } }),
      m('d'),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.order, ['d']);
  assert.equal(g.rejected.get('a')?.[0]?.kind, 'cycle');
  assert.equal(g.rejected.get('b')?.[0]?.kind, 'cycle');
  assert.equal(g.rejected.get('c')?.[0]?.kind, 'missing');
});

test('consumes не создаёт ребра: циклические consumes допустимы', () => {
  const g = resolveGraph(
    [
      m('a', { provides: { 'x.tab': '1.0' }, consumes: { 'x.tab': '^1' } }),
      m('b', { provides: { 'x.tab': '1.0' }, consumes: { 'x.tab': '^1' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.order, ['a', 'b']);
});

test('повтор id - отказ второму', () => {
  const g = resolveGraph([m('a'), m('a')], '1.0.0');
  assert.deepEqual(g.rejected.get('a'), [{ kind: 'duplicate' }]);
});
