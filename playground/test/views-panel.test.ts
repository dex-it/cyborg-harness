import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PluginRow } from '@cyborg-harness/electron/window';
import { viewList, viewMode, viewNames } from '../src/renderer/views-panel.ts';

const row = (over: Partial<PluginRow> = {}): PluginRow => ({ id: 'duo', state: 'active', revivable: false, unloaded: false, commands: [], permissions: [], ...over });

describe('окно: виды плагина', () => {
  it('плагин с двумя видами даёт фрейм на каждый, по порядку манифеста', () => {
    const duo = row({ view: 'cyborg-plugin://duo/', views: [{ name: 'main', url: 'cyborg-plugin://duo/' }, { name: 'tree', url: 'cyborg-plugin://duo/?view=tree' }] });
    assert.deepEqual(viewList(duo).map((v) => v.url), ['cyborg-plugin://duo/', 'cyborg-plugin://duo/?view=tree']);
    assert.equal(viewNames(duo), 'main tree');
  });

  it('состав видов меняется - ключ меняется: фрейм соберётся заново', () => {
    const one = row({ view: 'cyborg-plugin://duo/', views: [{ name: 'main', url: 'cyborg-plugin://duo/' }] });
    const two = row({ view: 'cyborg-plugin://duo/', views: [{ name: 'main', url: 'cyborg-plugin://duo/' }, { name: 'tree', url: 'cyborg-plugin://duo/?view=tree' }] });
    assert.notEqual(viewNames(one), viewNames(two));
  });

  it('строка без views, но с view - один безымянный вид; без обоих - видов нет', () => {
    assert.deepEqual(viewList(row({ view: 'cyborg-plugin://duo/' })), [{ name: '', url: 'cyborg-plugin://duo/' }]);
    assert.deepEqual(viewList(row()), []);
    assert.equal(viewMode(row()), undefined);
  });
});
