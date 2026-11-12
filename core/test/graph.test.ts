import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGraph } from '../src/graph.ts';
import { parseManifest, type PluginManifest } from '../src/manifest.ts';

function m(id: string, fields: Record<string, unknown> = {}): PluginManifest {
  const r = parseManifest({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.manifest;
}

test('ST-1002/7: порядок: поставщик раньше потребителя, независимые - в порядке входа', () => {
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

test('ST-1002/4: несовместимая мажорная версия поставщика - как отсутствие', () => {
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

test('ST-1002/2: два поставщика кратности one - отказ потребителю, но не поставщикам', () => {
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

test('ST-1002/3: цикл отказывает всем участникам и каскадирует на зависящих от цикла', () => {
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

test('ST-1002/5: consumes не создаёт ребра: циклические consumes допустимы', () => {
  const g = resolveGraph(
    [
      m('a', { provides: { 'x.tab': '1.0' }, consumes: { 'x.tab': '^1' } }),
      m('b', { provides: { 'x.tab': '1.0' }, consumes: { 'x.tab': '^1' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.order, ['a', 'b']);
});

// Ядро отвергает id целиком: оба плагина не загружаются. Чтобы встроенный пережил одноимённый пользовательский, приложение
// не передаёт ядру второй манифест (electron/test/plugins.test.ts, «поиск: …» и «старт с флагом: …»).
test('ST-1001/5: повтор id в манифестах - отказ id, ни один из двух не загружается', () => {
  const g = resolveGraph([m('a'), m('a'), m('b')], '1.0.0');
  assert.deepEqual(g.rejected.get('a'), [{ kind: 'duplicate' }]);
  assert.deepEqual(g.order, ['b']);
});

// ADR-CH-0002 п. 6: без закрепления один сторонний манифест с provides cyborg.agent делал встроенного потребителя ambiguous.
const reserved = (...bundled: string[]) => ({ prefixes: ['cyborg.'], bundled: new Set(bundled) });

test('ST-3003/5: ST-1002/6: пространство поставки: сторонний поставщик cyborg.* отвергнут, встроенный и его потребитель работают', () => {
  const plugins = [
    m('claude', { provides: { 'cyborg.agent': '1.0' } }),
    m('rogue', { provides: { 'cyborg.agent': '1.0', 'acme.x': '1.0' } }),
    m('sessions', { requires: { 'cyborg.agent': '^1' } }),
  ];
  assert.deepEqual(resolveGraph(plugins, '1.0.0').rejected.get('sessions'), [{ kind: 'ambiguous', contract: 'cyborg.agent', providers: ['claude', 'rogue'] }], 'угроза без проверки');
  const g = resolveGraph(plugins, '1.0.0', reserved('claude', 'sessions'));
  assert.deepEqual([...g.rejected], [['rogue', [{ kind: 'reserved', what: 'provides', name: 'cyborg.agent', prefix: 'cyborg.' }]]]);
  assert.equal(g.bindings.get('sessions')?.get('cyborg.agent'), 'claude');
  assert.deepEqual(g.order, ['claude', 'sessions']);
});

test('ST-3003/5: ST-1002/6: пространство поставки: встроенный с тем же provides принят, id cyborg.* у стороннего - отказ, потребление cyborg.* открыто', () => {
  const g = resolveGraph(
    [
      m('rogue', { provides: { 'cyborg.agent': '1.0' } }),
      m('cyborg.x'),
      m('cyborg.y'),
      m('reader', { requires: { 'cyborg.agent': '^1' }, optional: { 'cyborg.tab': '^1' }, consumes: { 'cyborg.tree-decoration': '^1' } }),
    ],
    '1.0.0',
    reserved('rogue', 'cyborg.y'),
  );
  assert.deepEqual([...g.rejected], [['cyborg.x', [{ kind: 'reserved', what: 'id', name: 'cyborg.x', prefix: 'cyborg.' }]]]);
  assert.equal(g.bindings.get('reader')?.get('cyborg.agent'), 'rogue');
});

test('ST-1002/6: пространство поставки: префикс закрывает и id без точки (app для app.), и id внутри; соседнее имя не задето', () => {
  const g = resolveGraph([m('app'), m('app.x'), m('apple')], '1.0.0', { prefixes: ['app.'], bundled: new Set() });
  assert.deepEqual(
    [...g.rejected],
    [
      ['app', [{ kind: 'reserved', what: 'id', name: 'app', prefix: 'app.' }]],
      ['app.x', [{ kind: 'reserved', what: 'id', name: 'app.x', prefix: 'app.' }]],
    ],
  );
  assert.deepEqual(g.order, ['apple']);
});

// Ревью K-22: плагины `a` и `a.b` оба проходят проверку пространства имён для `a.b.run`; кто первым зарегистрирует, тот владелец.
test('ST-2002/2: команда в двух манифестах - отказ обоим; встроенному уступает только сторонний', () => {
  const clash = [m('a', { commands: ['a.b.run', 'a.own'] }), m('a.b', { commands: ['a.b.run'] }), m('c', { commands: ['c.go'] })];
  const g = resolveGraph(clash, '1.0.0');
  assert.deepEqual(g.rejected.get('a'), [{ kind: 'command', command: 'a.b.run', with: ['a.b'] }]);
  assert.deepEqual(g.rejected.get('a.b'), [{ kind: 'command', command: 'a.b.run', with: ['a'] }]);
  assert.deepEqual(g.order, ['c']);

  const withBundled = resolveGraph(clash, '1.0.0', { prefixes: ['cyborg.'], bundled: new Set(['a', 'c']) });
  assert.deepEqual([...withBundled.rejected.keys()], ['a.b'], 'встроенный остаётся, сторонний отвергнут');
  assert.deepEqual(withBundled.order, ['a', 'c']);

  const both = resolveGraph(clash, '1.0.0', { prefixes: ['cyborg.'], bundled: new Set(['a', 'a.b']) });
  assert.deepEqual([...both.rejected.keys()].sort(), ['a', 'a.b'], 'оба встроенные - неоднозначность, отказ обоим');
});

// ST-1002/4 (FR-CH-1004): отказ в конце цепочки requires каскадирует по всей цепочке, а не на одно звено; ядро стартует.
test('ST-1002/4: цепочка A -> B -> C с ошибкой у C - отказ каскадирует на B и A, optional и независимые живы', () => {
  const g = resolveGraph(
    [
      m('a', { requires: { 'x.b': '^1' } }),
      m('b', { provides: { 'x.b': '1.0' }, requires: { 'x.c': '^1' } }),
      m('c', { engines: { cyborg: '^2' }, provides: { 'x.c': '1.0' } }),
      m('viewer', { optional: { 'x.b': '^1', 'x.c': '^1' } }),
      m('solo'),
    ],
    '1.0.0',
  );
  assert.equal(g.rejected.get('c')?.[0]?.kind, 'engines');
  assert.deepEqual(g.rejected.get('b'), [{ kind: 'missing', contract: 'x.c', range: '^1' }]);
  assert.deepEqual(g.rejected.get('a'), [{ kind: 'missing', contract: 'x.b', range: '^1' }]);
  assert.deepEqual([...g.rejected.keys()].sort(), ['a', 'b', 'c']);
  assert.deepEqual(g.order, ['viewer', 'solo']);
  assert.equal(g.bindings.get('viewer')?.size, 0, 'привязок к отвергнутым нет');
  assert.equal(g.bindings.has('a'), false);
});

test('каскад не зависит от порядка входа: все перестановки цепочки A -> B -> C дают один исход', () => {
  const chain = [
    m('a', { requires: { 'x.b': '^1' } }),
    m('b', { provides: { 'x.b': '1.0' }, requires: { 'x.c': '^1' } }),
    m('c', { engines: { cyborg: '^2' }, provides: { 'x.c': '1.0' } }),
    m('d'),
  ];
  const perms = (xs: PluginManifest[]): PluginManifest[][] => (xs.length < 2 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  for (const input of perms(chain)) {
    const g = resolveGraph(input, '1.0.0');
    const label = input.map((p) => p.id).join(',');
    assert.deepEqual([...g.rejected.keys()].sort(), ['a', 'b', 'c'], label);
    assert.deepEqual(g.order, ['d'], label);
  }
});

test('каскад по цепочке из пяти звеньев: отказ у хвоста доходит до головы, отвергнутый в проходе не остаётся поставщиком', () => {
  // Хвост отвергнут не до разбора связей (engines), а внутри него: у e нет поставщика x.none.
  const g = resolveGraph(
    [
      m('a', { requires: { 'x.b': '^1' } }),
      m('b', { provides: { 'x.b': '1.0' }, requires: { 'x.c': '^1' } }),
      m('c', { provides: { 'x.c': '1.0' }, requires: { 'x.d': '^1' } }),
      m('d', { provides: { 'x.d': '1.0' }, requires: { 'x.e': '^1' } }),
      m('e', { provides: { 'x.e': '1.0' }, requires: { 'x.none': '^1' } }),
      m('free'),
    ],
    '1.0.0',
  );
  assert.deepEqual([...g.rejected.keys()].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(g.rejected.get('e'), [{ kind: 'missing', contract: 'x.none', range: '^1' }]);
  for (const [id, contract] of [['d', 'x.e'], ['c', 'x.d'], ['b', 'x.c'], ['a', 'x.b']] as const) {
    assert.deepEqual(g.rejected.get(id), [{ kind: 'missing', contract, range: '^1' }], id);
  }
  assert.deepEqual(g.order, ['free']);
});

test('ветвление: отказ одной ветки requires снимает потребителя, соседняя ветка и её поставщики живут', () => {
  const g = resolveGraph(
    [
      m('top', { requires: { 'x.left': '^1', 'x.right': '^1' } }),
      m('left', { provides: { 'x.left': '1.0' }, requires: { 'x.leaf': '^1' } }),
      m('right', { provides: { 'x.right': '1.0' } }),
      m('leaf', { engines: { cyborg: '^9' }, provides: { 'x.leaf': '1.0' } }),
      m('other', { requires: { 'x.right': '^1' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual([...g.rejected.keys()].sort(), ['leaf', 'left', 'top']);
  assert.deepEqual(g.rejected.get('top'), [{ kind: 'missing', contract: 'x.left', range: '^1' }]);
  assert.deepEqual(g.order, ['right', 'other']);
  assert.equal(g.bindings.get('other')?.get('x.right'), 'right');
});

test('optional на плагин, отвергнутый при разборе связей, снимается; сам потребитель жив и порядок строится', () => {
  const g = resolveGraph(
    [m('ui', { optional: { 'x.b': '^1' } }), m('b', { provides: { 'x.b': '1.0' }, requires: { 'x.none': '^1' } })],
    '1.0.0',
  );
  assert.deepEqual([...g.rejected.keys()], ['b']);
  assert.deepEqual(g.order, ['ui']);
  assert.equal(g.bindings.get('ui')?.size, 0);
});

test('optional-звено в середине цепочки не держит отвергнутого: A requires B, B optional C, C requires пустоту - живы A и B', () => {
  const g = resolveGraph(
    [
      m('a', { requires: { 'x.b': '^1' } }),
      m('b', { provides: { 'x.b': '1.0' }, optional: { 'x.c': '^1' } }),
      m('c', { provides: { 'x.c': '1.0' }, requires: { 'x.none': '^1' } }),
    ],
    '1.0.0',
  );
  assert.deepEqual([...g.rejected.keys()], ['c']);
  assert.deepEqual(g.order, ['b', 'a']);
  assert.equal(g.bindings.get('b')?.size, 0);
});

test('отказ по неоднозначности поставщика каскадирует на зависящих через requires', () => {
  const g = resolveGraph(
    [
      m('a', { requires: { 'x.b': '^1' } }),
      m('b', { provides: { 'x.b': '1.0' }, requires: { 'x.lock': '^1' } }),
      m('lock-1', { provides: { 'x.lock': '1.0' } }),
      m('lock-2', { provides: { 'x.lock': '1.0' } }),
    ],
    '1.0.0',
  );
  assert.equal(g.rejected.get('b')?.[0]?.kind, 'ambiguous');
  assert.deepEqual(g.rejected.get('a'), [{ kind: 'missing', contract: 'x.b', range: '^1' }]);
  assert.deepEqual(g.order, ['lock-1', 'lock-2']);
});

test('цикл и каскад вместе: зависящие от цикла отвергаются по цепочке, независимая ветка и её отказ не мешают', () => {
  const g = resolveGraph(
    [
      m('a', { provides: { 'x.a': '1.0' }, requires: { 'x.b': '^1' } }),
      m('b', { provides: { 'x.b': '1.0' }, requires: { 'x.a': '^1' } }),
      m('c', { provides: { 'x.c': '1.0' }, requires: { 'x.a': '^1' } }),
      m('d', { requires: { 'x.c': '^1' } }),
      m('p', { provides: { 'x.p': '1.0' }, requires: { 'x.none': '^1' } }),
      m('q', { requires: { 'x.p': '^1' } }),
      m('ok'),
    ],
    '1.0.0',
  );
  assert.deepEqual(g.rejected.get('a')?.[0], { kind: 'cycle', members: ['a', 'b'] });
  assert.equal(g.rejected.get('b')?.[0]?.kind, 'cycle');
  assert.deepEqual([...g.rejected.keys()].sort(), ['a', 'b', 'c', 'd', 'p', 'q']);
  assert.deepEqual(g.order, ['ok']);
});
