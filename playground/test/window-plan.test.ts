import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutRow, PluginRow, PluginsSnapshot } from '@cyborg-harness/electron/window';
import { windowPlan } from '../src/renderer/window-plan.ts';

// PL-08: модель раскладки окна. Что где стоит, решает снимок ядра (`Kernel.layout`); окно знает только свои места, имён плагинов тут нет.
const row = (id: string, state: PluginRow['state'] = 'active'): PluginRow => ({ id, state, revivable: state === 'stopped', unloaded: false, commands: [], permissions: [] });
const view = (pluginId: string, name: string, area: LayoutRow['area'], order: number, over: Partial<LayoutRow> = {}): LayoutRow => ({
  pluginId,
  kind: 'view',
  name,
  area,
  order,
  url: `cyborg-plugin://${pluginId}/${pluginId}/?view=${name}`,
  ...over,
});
const type = (pluginId: string, name: string, order: number, area: LayoutRow['area'] = 'main'): LayoutRow => ({ pluginId, kind: 'document', name, area, order });
const doc = (id: string, pluginId: string, kind: string, title = id, available = true): PluginsSnapshot['documents'][number] => ({ id, pluginId, type: kind, title, available });

describe('раскладка окна (PL-08): модель областей', () => {
  const plugins = ['a', 'b', 'c', 'd'].map((id) => row(id));

  it('виды раскладываются по областям в порядке ядра: toolbar, main, popup, боковая колонка', () => {
    const plan = windowPlan(
      plugins,
      [
        view('a', 'status', 'toolbar', 100),
        view('b', 'tasks', 'toolbar', 200),
        view('c', 'terminal', 'main', 100),
        view('d', 'strip', 'main', 200),
        view('a', 'panel', 'popup', 100),
        view('b', 'plain', 'sidebar', 300),
      ],
      [],
    );
    assert.deepEqual(plan.toolbar.map((s) => s.key), ['a/status', 'b/tasks']);
    assert.deepEqual(plan.main.map((s) => s.key), ['c/terminal', 'd/strip']);
    assert.deepEqual(plan.popup.map((s) => s.key), ['a/panel']);
    assert.deepEqual(plan.sidebar.map((s) => s.key), ['b/plain']);
    assert.deepEqual(plan.sideTabs, []);
  });

  it('вид боковой колонки с title - своя вкладка, без title - в общей сетке; порядок вкладок - order ядра', () => {
    const plan = windowPlan(
      plugins,
      [view('a', 'tree', 'sidebar', 100, { title: 'Файлы' }), view('c', 'grid', 'sidebar', 150), view('b', 'history', 'sidebar', 200, { title: 'Сессии' })],
      [],
    );
    assert.deepEqual(plan.sideTabs.map((s) => [s.key, s.entry.title]), [['a/tree', 'Файлы'], ['b/history', 'Сессии']]);
    assert.deepEqual(plan.sidebar.map((s) => s.key), ['c/grid']);
  });

  it('изменение order переставляет вид: окно идёт порядком снимка ядра', () => {
    const before = windowPlan(plugins, [view('a', 'one', 'toolbar', 100), view('b', 'two', 'toolbar', 200)], []);
    // Ядро отдаёт снимок уже отсортированным по order; после смены order снимок другой, и план другой.
    const after = windowPlan(plugins, [view('b', 'two', 'toolbar', 200), view('a', 'one', 'toolbar', 300)], []);
    assert.deepEqual(before.toolbar.map((s) => s.key), ['a/one', 'b/two']);
    assert.deepEqual(after.toolbar.map((s) => s.key), ['b/two', 'a/one']);
  });

  it('ST-2003/5: снятый плагин остаётся в своей области заглушкой, не включённый в настройках места не занимает', () => {
    const rows = [row('a'), row('b', 'stopped'), row('c', 'disabled')];
    const plan = windowPlan(
      rows,
      [view('a', 'x', 'toolbar', 100), view('b', 'y', 'toolbar', 200, { mark: 'disabled' }), view('c', 'z', 'toolbar', 300, { mark: 'not-enabled', url: undefined })],
      [],
    );
    assert.deepEqual(plan.toolbar.map((s) => [s.key, s.mode]), [['a/x', 'frame'], ['b/y', 'placeholder']]);
  });

  it('модальный вид места в окне не занимает', () => {
    const plan = windowPlan(plugins, [view('a', 'form', 'modal', 100), view('b', 'bar', 'toolbar', 100)], []);
    assert.deepEqual(plan.toolbar.map((s) => s.key), ['b/bar']);
    assert.deepEqual([...plan.main, ...plan.popup, ...plan.sidebar, ...plan.sideTabs], []);
  });

  it('полоса сессий: документы типов основной области по order типа, затем по порядку открытия; прочие области и чужие типы не в счёт', () => {
    const plan = windowPlan(
      plugins,
      [type('a', 'session', 100), type('b', 'note', 50), type('c', 'aside', 10, 'sidebar')],
      [doc('s1', 'a', 'session', 'Первая'), doc('n1', 'b', 'note'), doc('s2', 'a', 'session', 'Вторая', false), doc('x1', 'c', 'aside'), doc('g1', 'ghost', 'session', 'Прошлая', false)],
    );
    assert.deepEqual(plan.strip.map((t) => t.id), ['n1', 's1', 's2', 'g1']);
    assert.deepEqual(plan.strip.map((t) => t.available), [true, true, false, false]);
    assert.equal(plan.strip[1]?.title, 'Первая');
  });

  it('полоса сессий пуста без документов', () => {
    assert.deepEqual(windowPlan(plugins, [type('a', 'session', 100)], []).strip, []);
  });
});
