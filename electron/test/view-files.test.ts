import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pluginOfOrigin, viewOrigin } from '../src/view-protocol.ts';
import { themeTokens } from '../src/theme.ts';
import { cspOf, resolveStaticFile, resolveViewRequest, VIEW_CSP, type PluginUi } from '../src/view-files.ts';

// Граница каталога считается по настоящим путям: файлы должны существовать, а tmpdir на macOS - симлинк.
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-view-files-')));
after(() => rm(base, { recursive: true, force: true }));
const root = path.join(base, 'alice');
const probe = path.join(base, 'probe');
for (const file of [path.join(root, 'ui', 'ui.js'), path.join(root, 'bob', 'ui', 'ui.js'), path.join(probe, 'index.html'), ...['codicon.ttf', 'codicon.woff2', 'ui.js.map', 'ui.wasm'].map((n) => path.join(root, 'ui', n))]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '');
}
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

test('вид: шрифт значков Monaco (.ttf) отдаётся своим типом, другие расширения шрифтов и карты - нет', () => {
  assert.deepEqual(resolveViewRequest('cyborg-plugin://alice/ui/codicon.ttf', uiOf), { kind: 'file', file: path.join(root, 'ui', 'codicon.ttf'), type: 'font/ttf' });
  for (const name of ['codicon.woff2', 'ui.js.map', 'ui.wasm']) assert.equal(resolveViewRequest(`cyborg-plugin://alice/ui/${name}`, uiOf), undefined, name);
});

test('статика спайка: корень - index.html каталога, выход за каталог закрыт', () => {
  const dirOf = (id: string) => (id === 'probe' ? probe : undefined);
  assert.deepEqual(resolveStaticFile('cyborg-plugin://probe/', dirOf), { kind: 'file', file: path.join(probe, 'index.html'), type: 'text/html; charset=utf-8' });
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

test('CSP ответа: без настройки - строгая по умолчанию, строка - на все виды, функция - по плагину из адреса', () => {
  assert.equal(cspOf(undefined, 'cyborg-plugin://alice/'), VIEW_CSP);
  assert.equal(cspOf("default-src 'none'", 'cyborg-plugin://alice/'), "default-src 'none'");
  const seen: (string | undefined)[] = [];
  const csp = cspOf((id) => (seen.push(id), id === 'alice' ? 'для alice' : 'для остальных'), 'cyborg-plugin://alice/x.js');
  assert.equal(csp, 'для alice');
  assert.equal(cspOf((id) => String(id), 'file:///etc/passwd'), 'undefined', 'не вид плагина - плагина нет');
  assert.deepEqual(seen, ['alice']);
});
