import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebFrameMain } from 'electron';
import { navigationAllowed } from '../src/navigation.ts';

const frame = (origin: string) => ({ origin }) as WebFrameMain;
const page = 'file:///app/renderer/index.html';
const main = frame('file://');
// Origin кадра - группа рендера (K-04): echo и chat в разных группах, alice и bob делят группу panels.
const echo = frame('cyborg-plugin://echo');
const chat = frame('cyborg-plugin://chat');
const panels = frame('cyborg-plugin://panels');
const sub = (url: string, at: WebFrameMain | null, initiator: WebFrameMain | null) => navigationAllowed({ url, isMainFrame: false, frame: at, initiator }, page, main);
const top = (url: string, initiator: WebFrameMain | null) => navigationAllowed({ url, isMainFrame: true, frame: main, initiator }, page, main);

test('навигация: окно остаётся на своей странице, якорь не в счёт', () => {
  assert.equal(top(`${page}#views`, main), true);
  assert.equal(top('https://github.com/login', main), false);
  assert.equal(top('https://github.com/login', echo), false);
  assert.equal(top('file:///etc/passwd', null), false);
});

test('навигация: документ окна ставит во фрейм любой вид, вид уводит только свой фрейм и только на свой origin', () => {
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
