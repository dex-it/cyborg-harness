import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { usesOf } from './imports.ts';

// T-08: загрузчик разбит на части, чтобы правки K-задач не сходились в одном файле. Разбиение держится двумя правилами,
// которые без теста держало бы только ревью: модули не импортируют друг друга по кругу и части загрузчика не растут за предел.
const src = path.resolve(import.meta.dirname, '..', 'src');

/** Модули core/src -> модули core/src, которые они импортируют (в том числе `import type`). */
export function importGraph(dir: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const file = path.join(dir, name);
    const deps = usesOf(file, fs.readFileSync(file, 'utf8'))
      .filter((u) => u.spec.startsWith('./'))
      .map((u) => path.basename(u.spec));
    graph.set(name, [...new Set(deps)]);
  }
  return graph;
}

/** Первый найденный круг в виде `a.ts -> b.ts -> a.ts` для каждого входа в круг; пусто - кругов нет. */
export function cyclesOf(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  const found: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 'open');
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === 'open') found.push([...stack.slice(stack.indexOf(dep)), dep].join(' -> '));
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return found;
}

/** Части `load()`: каждая отвечает за своё состояние или шов, который правят разные задачи (раскладка - в SAD, раздел 3.2). */
const LOADER_PARTS = [
  'activation.ts', 'call-check.ts', 'commands.ts', 'context-build.ts', 'contract-calls.ts', 'host-bridge.ts', 'host-pool.ts', 'idle-watch.ts',
  'kernel-api.ts', 'kernel-context.ts', 'kernel-types.ts', 'keybindings.ts', 'layout.ts', 'lifecycle.ts', 'loader.ts', 'manifest-fields.ts', 'manifest-layout.ts',
  'manifest-provides.ts', 'manifest-ui.ts', 'manifest.ts', 'menus.ts', 'os-requests.ts', 'plugin-log.ts', 'plugin-mark.ts', 'sections.ts', 'views-state.ts',
];

/** Модули, которые импортируют общий контекст, но не названы в списке: предел длины на них не распространился бы. */
export function unlistedParts(graph: ReadonlyMap<string, readonly string[]>, listed: readonly string[]): string[] {
  return [...graph].filter(([name, deps]) => deps.includes('kernel-context.ts') && !listed.includes(name)).map(([name]) => name);
}

const MAX_PART_LINES = 400;
const MAX_LOAD_LINES = 150;

describe('устройство загрузчика', () => {
  it('модули core/src не импортируют друг друга по кругу', () => {
    assert.deepEqual(cyclesOf(importGraph(src)), []);
  });

  it('проверка кругов ловит круг, цепочку и самоимпорт', () => {
    const graph = new Map([
      ['a.ts', ['b.ts']],
      ['b.ts', ['c.ts']],
      ['c.ts', ['a.ts']],
      ['d.ts', ['d.ts']],
      ['e.ts', ['a.ts']],
    ]);
    assert.deepEqual(cyclesOf(graph), ['a.ts -> b.ts -> c.ts -> a.ts', 'd.ts -> d.ts']);
    assert.deepEqual(cyclesOf(new Map([['a.ts', ['b.ts']], ['b.ts', []]])), []);
  });

  it('каждый модуль, который импортирует kernel-context.ts, назван в LOADER_PARTS, и все названные есть на диске', () => {
    const graph = importGraph(src);
    assert.deepEqual(unlistedParts(graph, LOADER_PARTS), [], 'новая часть загрузчика: допишите её в LOADER_PARTS, на неё распространяется предел длины');
    assert.deepEqual(LOADER_PARTS.filter((name) => !graph.has(name)), [], 'в LOADER_PARTS названы файлы, которых нет в core/src');
  });

  it('проверка списка частей ловит модуль с общим контекстом вне списка', () => {
    const graph = new Map([['a.ts', ['kernel-context.ts']], ['b.ts', ['a.ts']], ['c.ts', ['kernel-context.ts', 'a.ts']]]);
    assert.deepEqual(unlistedParts(graph, ['a.ts']), ['c.ts']);
    assert.deepEqual(unlistedParts(graph, ['a.ts', 'c.ts']), []);
  });

  it(`часть загрузчика не длиннее ${String(MAX_PART_LINES)} строк, а load() - ${String(MAX_LOAD_LINES)}`, () => {
    for (const name of LOADER_PARTS) {
      const lines = fs.readFileSync(path.join(src, name), 'utf8').split('\n').length;
      assert.ok(lines <= MAX_PART_LINES, `${name}: ${String(lines)} строк, предел ${String(MAX_PART_LINES)}`);
    }
    const loader = fs.readFileSync(path.join(src, 'loader.ts'), 'utf8').split('\n');
    const from = loader.findIndex((l) => l.startsWith('export async function load('));
    const to = loader.findIndex((l, i) => i > from && l === '}');
    assert.ok(from >= 0 && to > from, 'load() в loader.ts не найдена');
    assert.ok(to - from + 1 <= MAX_LOAD_LINES, `load(): ${String(to - from + 1)} строк, предел ${String(MAX_LOAD_LINES)}`);
  });
});
