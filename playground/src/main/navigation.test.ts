import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebFrameMain } from 'electron';
import { navigationAllowed } from './navigation.ts';

const frame = (origin: string) => ({ origin }) as WebFrameMain;
const page = 'file:///app/renderer/index.html';
const main = frame('file://');
const echo = frame('cyborg-plugin://echo');
const chat = frame('cyborg-plugin://chat');
const sub = (url: string, at: WebFrameMain | null, initiator: WebFrameMain | null) => navigationAllowed({ url, isMainFrame: false, frame: at, initiator }, page, main);
const top = (url: string, initiator: WebFrameMain | null) => navigationAllowed({ url, isMainFrame: true, frame: main, initiator }, page, main);

test('навигация: окно остаётся на своей странице, якорь не в счёт', () => {
  assert.equal(top(`${page}#views`, main), true);
  assert.equal(top('https://github.com/login', main), false);
  assert.equal(top('https://github.com/login', echo), false);
  assert.equal(top('file:///etc/passwd', null), false);
});

test('навигация: документ окна ставит во фрейм любой вид, вид уводит только свой фрейм и только на свой origin', () => {
  assert.equal(sub('cyborg-plugin://echo/?view=main', null, main), true);
  assert.equal(sub('cyborg-plugin://chat/', echo, main), true);
  assert.equal(sub('cyborg-plugin://echo/other.html', echo, echo), true);
  assert.equal(sub('cyborg-plugin://chat/', echo, echo), false, 'вид подставил в свой фрейм чужой вид');
  assert.equal(sub('cyborg-plugin://echo/', chat, echo), false, 'вид увёл фрейм соседа');
  assert.equal(sub('https://evil.example/', echo, echo), false);
  assert.equal(sub('https://evil.example/', echo, main), false);
  assert.equal(sub('data:text/html,<b>x</b>', echo, echo), false);
  assert.equal(sub('file:///app/renderer/index.html', echo, echo), false);
});

test('навигация: без инициатора фрейм остаётся на своём виде - перезагрузка да, подмена вида нет', () => {
  assert.equal(sub('cyborg-plugin://echo/', echo, null), true);
  assert.equal(sub('cyborg-plugin://chat/', echo, null), false, 'удалённый инициатор подставил чужой вид');
  assert.equal(sub('cyborg-plugin://echo/', frame('null'), null), false);
  assert.equal(sub('cyborg-plugin://echo/', null, null), false);
});
