import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pluginOfOrigin, viewOrigin } from '../shared/views.ts';
import { themeTokens } from './theme.ts';
import { resolveStaticFile, resolveViewRequest, type PluginUi } from './view-files.ts';

const root = path.resolve('/plugins/alice');
const uiOf = (id: string): PluginUi | undefined => (id === 'alice' ? { dir: root, views: { main: './ui/ui.js', tree: './ui/tree.js' } } : undefined);

test('вид: origin называет плагин, чужая схема и мусор - не вид', () => {
  assert.equal(viewOrigin('cyborg.files'), 'cyborg-plugin://cyborg.files');
  assert.equal(pluginOfOrigin('cyborg-plugin://cyborg.files'), 'cyborg.files');
  assert.equal(pluginOfOrigin('file://'), undefined);
  assert.equal(pluginOfOrigin('cyborg-plugin://Alice:80'), undefined);
});

test('вид: корень - оболочка с модулем из манифеста, /.cyborg/ - файлы ядра, прочее - только из каталога своего плагина', () => {
  const shell = resolveViewRequest('cyborg-plugin://alice/', uiOf);
  assert.ok(shell?.kind === 'shell');
  assert.match(shell.html, /<script src="\/\.cyborg\/shell\.js" data-plugin="alice" data-view="main" data-entry="\.\/ui\/ui\.js"><\/script>/);
  const tree = resolveViewRequest('cyborg-plugin://alice/?view=tree', uiOf);
  assert.match(tree?.kind === 'shell' ? tree.html : '', /data-view="tree" data-entry="\.\/ui\/tree\.js"/);
  assert.equal(resolveViewRequest('cyborg-plugin://alice/?view=constructor', uiOf), undefined, 'вид из прототипа объекта');
  assert.equal(resolveViewRequest('cyborg-plugin://alice/?view=nope', uiOf), undefined);

  assert.deepEqual(resolveViewRequest('cyborg-plugin://alice/.cyborg/shell.js', uiOf), { kind: 'core', name: 'shell.js', type: 'text/javascript; charset=utf-8' });
  assert.equal(resolveViewRequest('cyborg-plugin://alice/.cyborg/../manifest.json', uiOf), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://alice/.cyborg/toString', uiOf), undefined);

  assert.deepEqual(resolveViewRequest('cyborg-plugin://alice/ui/ui.js?x=1', uiOf), { kind: 'file', file: path.join(root, 'ui', 'ui.js'), type: 'text/javascript; charset=utf-8' });
  assert.deepEqual(resolveViewRequest('cyborg-plugin://alice/%2e%2e/bob/ui/ui.js', uiOf), { kind: 'file', file: path.join(root, 'bob', 'ui', 'ui.js'), type: 'text/javascript; charset=utf-8' }, 'закодированные точки парсер URL сворачивает внутри каталога');
  assert.equal(resolveViewRequest('cyborg-plugin://alice/..%2fbob%2fui.js', uiOf), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://bob/', uiOf), undefined, 'у плагина нет ui');
  assert.equal(resolveViewRequest('cyborg-plugin://alice/manifest.json', uiOf), undefined, 'неизвестный тип не отдаётся');
  assert.equal(resolveViewRequest('cyborg-plugin://alice/%E0%A4%A', uiOf), undefined);
});

test('статика спайка: корень - index.html каталога, выход за каталог закрыт', () => {
  const dirOf = (id: string) => (id === 'probe' ? path.resolve('/r/probe') : undefined);
  assert.deepEqual(resolveStaticFile('cyborg-plugin://probe/', dirOf), { kind: 'file', file: path.resolve('/r/probe/index.html'), type: 'text/html; charset=utf-8' });
  assert.equal(resolveStaticFile('cyborg-plugin://probe/..%2f..%2fetc%2fpasswd.js', dirOf), undefined);
  assert.equal(resolveStaticFile('cyborg-plugin://alice/', dirOf), undefined);
});

test('тема: одинаковый набор токенов у светлой и тёмной схемы, значения цветов разные', () => {
  const light = themeTokens(false);
  const dark = themeTokens(true);
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
  assert.ok(Object.keys(light).every((k) => k.startsWith('--cy-')));
  assert.deepEqual([light['--cy-scheme'], dark['--cy-scheme']], ['light', 'dark']);
  assert.notEqual(light['--cy-bg'], dark['--cy-bg']);
});
