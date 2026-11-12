import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents, WebFrameMain } from 'electron';
import { guardNavigation, navigationAllowed, navigationPlugin } from '../src/navigation.ts';

const frame = (origin: string) => ({ origin }) as WebFrameMain;
const page = 'file:///app/renderer/index.html';
const main = frame('file://');
// Origin кадра - группа рендера (K-04): echo и chat в разных группах, alice и bob делят группу panels.
const echo = frame('cyborg-plugin://echo');
const chat = frame('cyborg-plugin://chat');
const panels = frame('cyborg-plugin://panels');
const sub = (url: string, at: WebFrameMain | null, initiator: WebFrameMain | null) => navigationAllowed({ url, isMainFrame: false, frame: at, initiator }, page, main);
const top = (url: string, initiator: WebFrameMain | null) => navigationAllowed({ url, isMainFrame: true, frame: main, initiator }, page, main);

test('ST-3005/6: навигация: окно остаётся на своей странице, якорь не в счёт', () => {
  assert.equal(top(`${page}#views`, main), true);
  assert.equal(top('https://github.com/login', main), false);
  assert.equal(top('https://github.com/login', echo), false);
  assert.equal(top('file:///etc/passwd', null), false);
});

test('ST-3005/6: навигация: документ окна ставит во фрейм любой вид, вид уводит только свой фрейм и только на свой origin', () => {
  assert.equal(sub('cyborg-plugin://echo/echo/?view=main', null, main), true);
  assert.equal(sub('cyborg-plugin://chat/chat/', echo, main), true);
  assert.equal(sub('cyborg-plugin://echo/echo/other.html', echo, echo), true);
  assert.equal(sub('cyborg-plugin://chat/chat/', echo, echo), false, 'вид подставил в свой фрейм вид чужой группы');
  assert.equal(sub('cyborg-plugin://echo/echo/', chat, echo), false, 'вид увёл фрейм соседа');
  assert.equal(sub('https://evil.example/', echo, echo), false);
  assert.equal(sub('https://evil.example/', echo, main), false);
  assert.equal(sub('data:text/html,<b>x</b>', echo, echo), false);
  assert.equal(sub('file:///app/renderer/index.html', echo, echo), false);
});

test('навигация: без инициатора фрейм остаётся на своём виде - перезагрузка да, подмена вида нет', () => {
  assert.equal(sub('cyborg-plugin://echo/echo/', echo, null), true);
  assert.equal(sub('cyborg-plugin://chat/chat/', echo, null), false, 'удалённый инициатор подставил чужой вид');
  assert.equal(sub('cyborg-plugin://echo/echo/', frame('null'), null), false);
  assert.equal(sub('cyborg-plugin://echo/echo/', null, null), false);
});

test('навигация: внутри группы вид переходит между плагинами группы (граница доверия - группа), в чужую группу - нет', () => {
  assert.equal(sub('cyborg-plugin://panels/bob/?view=main', panels, panels), true, 'сосед по группе: тот же origin');
  assert.equal(sub('cyborg-plugin://echo/echo/', panels, panels), false, 'вид группы увёл свой фрейм в другую группу');
  assert.equal(sub('cyborg-plugin://panels/alice/', echo, panels), false, 'вид другой группы увёл фрейм группы');
  assert.equal(sub('cyborg-plugin://panels/alice/', panels, null), true, 'перезагрузка кадра группы');
  assert.equal(sub('cyborg-plugin://panels/alice/', echo, null), false, 'удалённый инициатор подставил вид группы в чужой кадр');
});

test('навигация: отказ записывается на плагин инициатора, а если инициатор не кадр вида - на плагин навигируемого кадра', () => {
  const groups = { groupOf: (id: string) => ({ alice: 'panels', bob: 'panels' })[id] };
  const view = (url: string) => ({ url, origin: 'cyborg-plugin://panels' }) as WebFrameMain;
  const alice = view('cyborg-plugin://panels/alice/?view=main');
  const bob = view('cyborg-plugin://panels/bob/');
  // Инициатор - кадр вида: отвечает он, а не навигируемый.
  assert.equal(navigationPlugin({ url: 'https://evil.example/', isMainFrame: false, frame: bob, initiator: alice }, groups), 'alice');
  // Дочерний srcdoc или about:blank внутри вида, кадр после pushState: адреса вида у инициатора нет - запись идёт на плагин кадра.
  const srcdoc = { url: 'about:srcdoc', origin: 'cyborg-plugin://panels' } as WebFrameMain;
  assert.equal(navigationPlugin({ url: 'https://evil.example/', isMainFrame: false, frame: alice, initiator: srcdoc }, groups), 'alice');
  const moved = view('cyborg-plugin://panels/nobody/');
  assert.equal(navigationPlugin({ url: 'https://evil.example/', isMainFrame: false, frame: bob, initiator: moved }, groups), 'bob');
  // Без инициатора (перезагрузка, удалённый инициатор) - плагин кадра.
  assert.equal(navigationPlugin({ url: 'https://evil.example/', isMainFrame: false, frame: bob, initiator: null }, groups), 'bob');
  // Ни там ни там вида нет (кадр окна): плагина нет, записи не будет.
  assert.equal(navigationPlugin({ url: 'https://evil.example/', isMainFrame: false, frame: main, initiator: main }, groups), undefined);
});

test('ST-3005/6: window.open отклонён, переход фрейма вида на внешний адрес отменён и записан на плагин', () => {
  let openHandler: ((details: unknown) => { action: string }) | undefined;
  let onNavigate: ((event: { url: string; isMainFrame: boolean; frame: WebFrameMain | null; initiator: WebFrameMain | null; preventDefault: () => void }) => void) | undefined;
  const contents = {
    mainFrame: main,
    setWindowOpenHandler: (handler: typeof openHandler) => void (openHandler = handler),
    on: (name: string, listener: typeof onNavigate) => {
      if (name === 'will-frame-navigate') onNavigate = listener;
    },
  } as unknown as WebContents;
  const denied: string[] = [];
  const view = { url: 'cyborg-plugin://panels/alice/?view=main', origin: 'cyborg-plugin://panels' } as WebFrameMain;
  guardNavigation(contents, page, (pluginId, url) => void denied.push(`${pluginId} ${url}`), { groupOf: () => 'panels' });
  assert.deepEqual(openHandler?.({ url: 'https://evil.example/' }), { action: 'deny' }, 'window.open из вида открыл окно');
  const go = (url: string): boolean => {
    let prevented = false;
    onNavigate?.({ url, isMainFrame: false, frame: view, initiator: view, preventDefault: () => void (prevented = true) });
    return prevented;
  };
  assert.equal(go('https://evil.example/'), true, 'вид увёл свой фрейм в интернет');
  assert.equal(go('cyborg-plugin://panels/alice/?view=other'), false, 'переход на свой origin отменён зря');
  assert.deepEqual(denied, ['alice https://evil.example/']);
});
