import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frameAddress, groupOfOrigin, viewOfUrl, viewOrigin, viewUrl } from '../src/view-protocol.ts';
import { themeTokens } from '../src/theme.ts';
import { cspOf, resolveStaticFile, resolveViewRequest, viewCsp, VIEW_CSP, viewHeaders, type PluginUi } from '../src/view-files.ts';

// Граница каталога считается по настоящим путям: файлы должны существовать, а tmpdir на macOS - симлинк.
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-view-files-')));
after(() => rm(base, { recursive: true, force: true }));
const root = path.join(base, 'alice');
const bobDir = path.join(base, 'bob');
const carolDir = path.join(base, 'carol');
const probe = path.join(base, 'probe');
for (const file of [path.join(root, 'ui', 'ui.js'), path.join(root, 'bob', 'ui', 'ui.js'), path.join(bobDir, 'ui', 'ui.js'), path.join(carolDir, 'ui', 'ui.js'), path.join(probe, 'index.html'), ...['codicon.ttf', 'codicon.woff2', 'ui.js.map', 'ui.wasm'].map((n) => path.join(root, 'ui', n))]) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '');
}
// alice и bob в группе panels, carol одна в своей (K-04): адрес вида - cyborg-plugin://<группа>/<плагин>/...
const uiOf = (id: string): PluginUi | undefined => {
  if (id === 'alice') return { dir: root, group: 'panels', views: { main: './ui/ui.js', tree: './ui/tree.js' } };
  if (id === 'bob') return { dir: bobDir, group: 'panels', views: { main: './ui/ui.js' } };
  return id === 'carol' ? { dir: carolDir, group: 'carol', views: { main: './ui/ui.js' }, inlineStyles: true } : undefined;
};

test('вид: origin называет группу, адрес - плагин внутри неё, чужая схема и мусор - не вид', () => {
  assert.equal(viewOrigin('cyborg.panels'), 'cyborg-plugin://cyborg.panels');
  assert.equal(groupOfOrigin('cyborg-plugin://cyborg.panels'), 'cyborg.panels');
  assert.equal(groupOfOrigin('file://'), undefined);
  assert.equal(groupOfOrigin('cyborg-plugin://Alice:80'), undefined);
  assert.equal(groupOfOrigin('cyborg-plugin://solo_guest'), 'solo_guest', 'сторонний одиночка: своё пространство имён');
  assert.equal(groupOfOrigin('cyborg-plugin://solo_'), undefined);
  assert.equal(groupOfOrigin('cyborg-plugin://a_b'), undefined, 'подчёркивание только после solo');
  assert.deepEqual(frameAddress('cyborg-plugin://solo_guest/guest/?view=side'), { group: 'solo_guest', plugin: 'guest', view: 'side' });
  assert.equal(frameAddress('cyborg-plugin://solo_guest/solo_guest/'), undefined, 'плагин в пути - id, без подчёркивания');
  assert.equal(viewUrl('panels', 'alice', 'tree'), 'cyborg-plugin://panels/alice/?view=tree');
  assert.equal(viewUrl('panels', 'alice'), 'cyborg-plugin://panels/alice/');
  assert.deepEqual(frameAddress('cyborg-plugin://panels/alice/?view=tree'), { group: 'panels', plugin: 'alice', view: 'tree' });
  assert.deepEqual(frameAddress('cyborg-plugin://panels/cyborg.files/ui/x.html#a'), { group: 'panels', plugin: 'cyborg.files' });
  for (const bad of ['cyborg-plugin://panels/', 'cyborg-plugin://panels', 'cyborg-plugin://panels/Alice/', 'cyborg-plugin://panels/a b/', 'cyborg-plugin://Panels:80/alice/', 'https://panels/alice/', 'about:blank', 'не адрес'])
    assert.equal(frameAddress(bad), undefined, bad);
  assert.equal(viewOfUrl('cyborg-plugin://panels/alice/?view=tree'), 'tree');
  assert.equal(viewOfUrl('cyborg-plugin://panels/alice/'), undefined);
  assert.equal(viewOfUrl('не адрес'), undefined);
});

test('вид: корень плагина - оболочка с модулем из манифеста, .cyborg/ - файлы ядра, прочее - только из каталога своего плагина', () => {
  const shell = resolveViewRequest('cyborg-plugin://panels/alice/', uiOf);
  assert.ok(shell?.kind === 'shell');
  assert.match(shell.html, /<script src="\/alice\/\.cyborg\/shell\.js" data-plugin="alice" data-view="main" data-entry="\.\/ui\/ui\.js"><\/script>/);
  assert.match(shell.html, /<link rel="stylesheet" href="\/alice\/\.cyborg\/shell\.css"/);
  const tree = resolveViewRequest('cyborg-plugin://panels/alice/?view=tree', uiOf);
  assert.match(tree?.kind === 'shell' ? tree.html : '', /data-view="tree" data-entry="\.\/ui\/tree\.js"/);
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/?view=constructor', uiOf), undefined, 'вид из прототипа объекта');
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/?view=nope', uiOf), undefined);

  assert.deepEqual(resolveViewRequest('cyborg-plugin://panels/alice/.cyborg/shell.js', uiOf), { kind: 'core', name: 'shell.js', type: 'text/javascript; charset=utf-8' });
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/.cyborg/../manifest.json', uiOf), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/.cyborg/toString', uiOf), undefined);

  assert.deepEqual(resolveViewRequest('cyborg-plugin://panels/alice/ui/ui.js?x=1', uiOf), { kind: 'file', file: path.join(root, 'ui', 'ui.js'), type: 'text/javascript; charset=utf-8' });
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/..%2fbob%2fui.js', uiOf), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/manifest.json', uiOf), undefined, 'неизвестный тип не отдаётся');
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/%E0%A4%A', uiOf), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://panels/nobody/', uiOf), undefined, 'у плагина нет ui');
});

test('вид: адрес обслуживается, только если плагин состоит в группе из хоста адреса', () => {
  // Плагин группы адресуется по своему пути: файлы берутся из его каталога, а не из каталога соседа по группе.
  assert.deepEqual(resolveViewRequest('cyborg-plugin://panels/bob/ui/ui.js', uiOf), { kind: 'file', file: path.join(bobDir, 'ui', 'ui.js'), type: 'text/javascript; charset=utf-8' });
  const bob = resolveViewRequest('cyborg-plugin://panels/bob/', uiOf);
  assert.match(bob?.kind === 'shell' ? bob.html : '', /data-plugin="bob"/);
  // Сегмент `..` парсер URL сворачивает до сравнения: переход к соседу по группе - это адрес соседа, а не файл из каталога alice.
  assert.deepEqual(resolveViewRequest('cyborg-plugin://panels/alice/%2e%2e/bob/ui/ui.js', uiOf), { kind: 'file', file: path.join(bobDir, 'ui', 'ui.js'), type: 'text/javascript; charset=utf-8' });
  // Вне группы - 404: ни подставленным плагином, ни чужим хостом, ни старой формой адреса без плагина.
  assert.equal(resolveViewRequest('cyborg-plugin://panels/carol/', uiOf), undefined, 'плагин другой группы под хостом панелей');
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/%2e%2e/carol/ui/ui.js', uiOf), undefined, 'переход к плагину вне группы подменой пути');
  assert.equal(resolveViewRequest('cyborg-plugin://carol/alice/', uiOf), undefined, 'плагин группы под хостом чужой группы');
  assert.equal(resolveViewRequest('cyborg-plugin://carol/alice/ui/ui.js', uiOf), undefined);
  assert.ok(resolveViewRequest('cyborg-plugin://carol/carol/', uiOf)?.kind === 'shell', 'своя группа carol');
  assert.equal(resolveViewRequest('cyborg-plugin://panels/', uiOf), undefined, 'без плагина в пути адрес не вид');
  assert.equal(resolveViewRequest('cyborg-plugin://alice/', uiOf), undefined, 'прежняя форма адреса, где хост - плагин, не действует');
  assert.equal(resolveViewRequest('cyborg-plugin://panels/Alice/', uiOf), undefined);
});

test('вид: ленивый плагин просыпается от запроса своей группы, а не от адреса чужого вида', () => {
  const woken: string[] = [];
  const wake = (id: string) => woken.push(id);
  // Вид carol просит адрес соседней группы: ответа нет, и плагин panels, который человек держит ленивым, не активируется.
  assert.equal(resolveViewRequest('cyborg-plugin://carol/alice/', uiOf, wake), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://carol/bob/ui/ui.js', uiOf, wake), undefined);
  assert.equal(resolveViewRequest('cyborg-plugin://panels/nobody/', uiOf, wake), undefined);
  assert.deepEqual(woken, []);
  assert.ok(resolveViewRequest('cyborg-plugin://panels/bob/', uiOf, wake));
  assert.deepEqual(woken, ['bob'], 'будится плагин из адреса, группа которого сошлась с хостом');
});

test('вид: шрифт значков Monaco (.ttf) отдаётся своим типом, другие расширения шрифтов и карты - нет', () => {
  assert.deepEqual(resolveViewRequest('cyborg-plugin://panels/alice/ui/codicon.ttf', uiOf), { kind: 'file', file: path.join(root, 'ui', 'codicon.ttf'), type: 'font/ttf' });
  for (const name of ['codicon.woff2', 'ui.js.map', 'ui.wasm']) assert.equal(resolveViewRequest(`cyborg-plugin://panels/alice/ui/${name}`, uiOf), undefined, name);
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

/** Заголовок CSP по директивам: имя -> источники. */
const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => { const [name = '', ...sources] = d.split(' '); return [name, sources]; }));

// K-05: SAD 3.8 и ADR-CH-0007 п. 2 - закрытая CSP с явными источниками; инлайн-стили только по флагу манифеста.
test('CSP вида: начинается с default-src \'none\' и несёт только перечисленные источники', () => {
  const csp = viewCsp(false);
  assert.ok(csp.startsWith("default-src 'none'; "), csp);
  assert.deepEqual(directives(csp), {
    'default-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'connect-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  });
  assert.equal(VIEW_CSP, csp, 'VIEW_CSP - политика без флага');
  for (const bad of ['*', 'http:', 'https:', 'blob:', "'unsafe-eval'", "'unsafe-inline'", 'ws:']) assert.ok(!csp.includes(bad), `в строгой CSP есть ${bad}`);
});

test('CSP вида зависит от флага: \'unsafe-inline\' только в style-src и только при inlineStyles, остальное то же', () => {
  const off = directives(viewCsp(false));
  const on = directives(viewCsp(true));
  assert.deepEqual(off['style-src'], ["'self'"]);
  assert.deepEqual(on['style-src'], ["'self'", "'unsafe-inline'"]);
  assert.deepEqual({ ...on, 'style-src': off['style-src'] }, off, 'флаг меняет одну директиву');
  assert.ok(!viewCsp(true).replace("style-src 'self' 'unsafe-inline'", '').includes('unsafe-inline'), "'unsafe-inline' не попал в другую директиву");
  assert.equal(viewCsp(true).split("'unsafe-inline'").length, 2, "'unsafe-inline' один раз");
});

// #161: default-src не покрывает base-uri и form-action: <base href> менял бы разрешение относительных адресов вида, <form action> отправлял бы данные.
test('CSP вида: base-uri и form-action закрыты в обоих вариантах флага', () => {
  for (const inlineStyles of [false, true]) {
    const d = directives(viewCsp(inlineStyles));
    assert.deepEqual(d['base-uri'], ["'none'"], `inlineStyles=${inlineStyles}`);
    assert.deepEqual(d['form-action'], ["'none'"], `inlineStyles=${inlineStyles}`);
  }
});

test('CSP вида: фреймы закрыты (frame-src берётся из default-src \'none\'), сосед по группе в <iframe> не встраивается', () => {
  const d = directives(viewCsp(true));
  for (const name of ['frame-src', 'child-src', 'object-src', 'worker-src']) assert.equal(d[name], undefined, `${name} не задана: берётся из default-src или script-src`);
  assert.deepEqual(d['default-src'], ["'none'"]);
});

test('заголовки ответа считаются на ответ: флаг плагина из PluginUi доходит до CSP оболочки, файла вида и файла ядра', () => {
  const header = (url: string, csp?: Parameters<typeof viewHeaders>[2]) => {
    const found = resolveViewRequest(url, uiOf);
    assert.ok(found, url);
    return viewHeaders(found, url, csp)['content-security-policy'];
  };
  for (const url of ['cyborg-plugin://carol/carol/', 'cyborg-plugin://carol/carol/ui/ui.js', 'cyborg-plugin://carol/carol/.cyborg/shell.js'])
    assert.equal(header(url), viewCsp(true), `${url}: у carol флаг`);
  for (const url of ['cyborg-plugin://panels/alice/', 'cyborg-plugin://panels/alice/ui/ui.js', 'cyborg-plugin://panels/bob/.cyborg/shell.css'])
    assert.equal(header(url), viewCsp(false), `${url}: у соседей по группе без флага CSP строгая, флаг соседа её не смягчает`);
  assert.equal(viewHeaders({ kind: 'file', file: '/x/index.html', type: 'text/html; charset=utf-8' }, 'cyborg-plugin://probe/')['content-security-policy'], viewCsp(false), 'статика спайка: без флага');
  assert.equal(viewHeaders({ kind: 'shell', html: '' }, 'cyborg-plugin://panels/alice/')['content-type'], 'text/html; charset=utf-8');
  assert.equal(viewHeaders({ kind: 'core', name: 'shell.js', type: 'text/javascript; charset=utf-8' }, 'cyborg-plugin://panels/alice/.cyborg/shell.js')['content-type'], 'text/javascript; charset=utf-8');
  // Настройка приложения (в playground - --view-csp= спайка PL-05) старше флага; функция получает флаг третьим параметром.
  assert.equal(header('cyborg-plugin://carol/carol/', "default-src 'none'"), "default-src 'none'");
  assert.equal(header('cyborg-plugin://carol/carol/', (id, group, inline) => `${String(id)} ${String(group)} ${String(inline)}`), 'carol carol true');
  assert.equal(header('cyborg-plugin://panels/alice/', (id, group, inline) => `${String(id)} ${String(group)} ${String(inline)}`), 'alice panels false');
});

test('флаг inlineStyles доходит в PluginUi только как true: без него в ответе resolveViewRequest нет поля', () => {
  assert.equal(resolveViewRequest('cyborg-plugin://carol/carol/', uiOf)?.inlineStyles, true);
  assert.equal(resolveViewRequest('cyborg-plugin://panels/alice/', uiOf)?.inlineStyles, undefined);
  assert.ok(!('inlineStyles' in (resolveViewRequest('cyborg-plugin://panels/alice/', uiOf) ?? {})));
});

test('CSP ответа: без настройки - строгая по умолчанию, строка - на все виды, функция - по плагину и группе из адреса', () => {
  assert.equal(cspOf(undefined, 'cyborg-plugin://panels/alice/', false), VIEW_CSP);
  assert.equal(cspOf(undefined, 'cyborg-plugin://carol/carol/', true), viewCsp(true));
  assert.equal(cspOf("default-src 'none'", 'cyborg-plugin://panels/alice/', false), "default-src 'none'");
  const seen: (string | undefined)[] = [];
  const csp = cspOf((id, group) => (seen.push(id, group), id === 'alice' ? 'для alice' : 'для остальных'), 'cyborg-plugin://panels/alice/x.js', false);
  assert.equal(csp, 'для alice');
  assert.equal(cspOf((id) => String(id), 'file:///etc/passwd', false), 'undefined', 'не вид плагина - плагина нет');
  assert.deepEqual(seen, ['alice', 'panels']);
});
