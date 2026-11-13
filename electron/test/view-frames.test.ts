import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { framesOfPlugin, pluginOfFrame, senderPlugin, trackViewFrames, type FrameLike, type ViewGroups } from '../src/view-frames.ts';

// K-04: мост узнаёт плагин по пути адреса кадра внутри группы из его origin. Граница доверия - группа: плагины одной группы подменяют друг друга,
// плагин вне группы кадра - нет. Адрес берётся из главного процесса (последний принятый адрес кадра), а не из слов вида.
const groups: ViewGroups = { groupOf: (id) => ({ alice: 'panels', bob: 'panels', carol: 'carol' })[id] };
const at = (url: string, origin = 'cyborg-plugin://panels'): FrameLike => ({ url, origin });

test('мост: плагин кадра - первый сегмент пути в группе из origin', () => {
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/alice/?view=main'), groups), 'alice');
  assert.equal(pluginOfFrame(at('cyborg-plugin://carol/carol/', 'cyborg-plugin://carol'), groups), 'carol');
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/bob/ui/page.html#x'), groups), 'bob');
});

test('ST-2003/3: мост: доверие только внутри группы - адрес вне группы, чужой плагин, расхождение origin и адреса не дают плагина', () => {
  // pushState внутри origin меняет адрес кадра без загрузки: alice может назваться bob (одна группа), но не carol.
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/bob/'), groups), 'bob', 'сосед по группе: граница доверия - группа');
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/carol/'), groups), undefined, 'плагин другой группы под origin группы');
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/nobody/'), groups), undefined, 'плагина нет');
  assert.equal(pluginOfFrame(at('cyborg-plugin://carol/carol/', 'cyborg-plugin://panels'), groups), undefined, 'адрес и origin назвали разные группы');
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/', 'cyborg-plugin://panels'), groups), undefined, 'без плагина в пути');
  assert.equal(pluginOfFrame(at('about:blank', 'cyborg-plugin://panels'), groups), undefined, 'srcdoc или blank внутри вида: адреса плагина нет');
  assert.equal(pluginOfFrame(at('file:///app/index.html', 'file://'), groups), undefined, 'документ окна');
  assert.equal(pluginOfFrame(at('https://panels/alice/', 'https://panels'), groups), undefined, 'чужая схема');
});

test('ST-2003/3: мост: senderPlugin берёт плагин из кадра-отправителя, без кадра - undefined', () => {
  const event = (senderFrame: FrameLike | null) => ({ senderFrame }) as unknown as Parameters<typeof senderPlugin>[0];
  assert.equal(senderPlugin(event(at('cyborg-plugin://panels/alice/?view=main')), groups), 'alice');
  assert.equal(senderPlugin(event(at('cyborg-plugin://panels/carol/')), groups), undefined);
  assert.equal(senderPlugin(event(null), groups), undefined);
});

test('ST-3005/2: каналы окна: fromWindow принимает только главный фрейм окна - дочерний кадр вида, чужое окно и отправитель без кадра отклонены', async () => {
  // views.ts берёт protocol из electron, которого в Node нет: на время импорта подставляем пустой модуль.
  const hooks = registerHooks({
    resolve: (specifier, context, next) => (specifier === 'electron' ? { url: 'data:text/javascript,export const protocol = {};', shortCircuit: true } : next(specifier, context)),
  });
  const { fromWindow } = await import('../src/views.ts').finally(() => {
    hooks.deregister();
  });
  const windowFrame = at('file:///app/renderer/index.html', 'file://');
  const viewFrame = at('cyborg-plugin://panels/alice/?view=main');
  const other = at('file:///app/renderer/index.html', 'file://');
  const sender = { mainFrame: windowFrame };
  const event = (senderFrame: FrameLike | null, from: { mainFrame: FrameLike } = sender) => ({ senderFrame, sender: from }) as unknown as IpcMainInvokeEvent;
  assert.equal(fromWindow(event(windowFrame)), true, 'документ окна');
  assert.equal(fromWindow(event(viewFrame)), false, 'дочерний кадр вида');
  assert.equal(fromWindow(event(other)), false, 'кадр, равный окну по адресу, но не главный фрейм');
  assert.equal(fromWindow(event(windowFrame, { mainFrame: other })), false, 'главный фрейм другого окна');
  assert.equal(fromWindow(event(null)), false, 'кадр уже уничтожен');
});

test('кадры плагина: лог и видимость идут кадрам одного плагина, а не всей группы', () => {
  const frames = [at('cyborg-plugin://panels/alice/?view=main'), at('cyborg-plugin://panels/bob/?view=main'), at('cyborg-plugin://panels/alice/?view=tree'), at('cyborg-plugin://carol/carol/', 'cyborg-plugin://carol'), at('about:blank', 'cyborg-plugin://panels')];
  const contents = { mainFrame: { framesInSubtree: frames } } as unknown as WebContents;
  assert.deepEqual(framesOfPlugin(contents, 'panels', 'alice'), [frames[0], frames[2]]);
  assert.deepEqual(framesOfPlugin(contents, 'panels', 'bob'), [frames[1]]);
  assert.deepEqual(framesOfPlugin(contents, 'carol', 'carol'), [frames[3]]);
  assert.deepEqual(framesOfPlugin(contents, 'panels', 'carol'), [], 'плагин не в этой группе');
  assert.deepEqual(framesOfPlugin(contents, undefined, 'alice'), [], 'у плагина нет группы - у него нет видов');
});

// TR-31 (docs/research/trust-and-isolation, 5.8): плагин привязывается к кадру при создании его документа по `frameTreeNodeId` (Electron: «фиксирован при создании кадра,
// не используется повторно») и больше не перечитывается из текущего `frame.url`, который вид меняет сам через `history.pushState`.
interface TestFrame extends FrameLike {
  readonly frameTreeNodeId: number;
  readonly processId: number;
  readonly routingId: number;
  readonly parent: { frameTreeNodeId: number } | null;
}
const MAIN = { frameTreeNodeId: 1 };
const child = (id: number, url: string, origin = 'cyborg-plugin://panels', parent: { frameTreeNodeId: number } | null = MAIN): TestFrame => ({ frameTreeNodeId: id, processId: 100 + id, routingId: 200 + id, parent, url, origin });
/** WebContents с деревом кадров и событием фиксации навигации, как его шлёт Electron. */
function windowOf(frames: TestFrame[]) {
  const emitter = new EventEmitter();
  const contents = Object.assign(emitter, { mainFrame: { ...MAIN, framesInSubtree: [MAIN, ...frames] } });
  const commit = (frame: TestFrame, url = frame.url, isMainFrame = false) => emitter.emit('did-frame-navigate', {}, url, 200, 'OK', isMainFrame, frame.processId, frame.routingId);
  return { contents: contents as unknown as Parameters<typeof trackViewFrames>[0], emitter, commit, frames };
}
const mutable = (frame: TestFrame, url: string): TestFrame => Object.assign(frame, { url });

test('TR-31: привязка к кадру: pushState на путь соседа, на чужую группу и на корень личность не меняет', () => {
  const alice = child(11, 'cyborg-plugin://panels/alice/?view=main');
  const { contents, commit, emitter } = windowOf([alice]);
  trackViewFrames(contents, groups);
  assert.equal(pluginOfFrame(alice, groups), undefined, 'кадр без привязки: до фиксации документа он не вид');
  commit(alice);
  assert.equal(pluginOfFrame(alice, groups), 'alice');
  for (const url of ['cyborg-plugin://panels/bob/', 'cyborg-plugin://panels/carol/', 'cyborg-plugin://panels/', 'cyborg-plugin://panels/nobody/x']) {
    mutable(alice, url);
    assert.equal(pluginOfFrame(alice, groups), 'alice', `после pushState на ${url} кадр всё ещё alice`);
  }
  emitter.emit('destroyed');
});

test('TR-31: привязка: другой кадр с адресом alice не alice; origin другой группы привязку не продолжает; фиксация нового документа перевязывает кадр', () => {
  const first = child(21, 'cyborg-plugin://panels/alice/?view=main');
  const forged = child(22, 'cyborg-plugin://panels/alice/?view=main');
  const { contents, commit, emitter } = windowOf([first, forged]);
  trackViewFrames(contents, groups);
  commit(first);
  assert.equal(pluginOfFrame(first, groups), 'alice');
  assert.equal(pluginOfFrame(forged, groups), undefined, 'адрес alice без фиксации документа плагином не делает');
  assert.equal(pluginOfFrame({ ...first, origin: 'cyborg-plugin://carol' }, groups), undefined, 'origin другой группы: привязка не действует');
  // Окно (оболочка) перенаправило кадр на другой вид: новый документ - новая привязка.
  mutable(first, 'cyborg-plugin://panels/bob/?view=main');
  commit(first);
  assert.equal(pluginOfFrame(first, groups), 'bob');
  emitter.emit('destroyed');
});

test('TR-31: привязка берёт только прямые кадры окна и только адрес вида своей группы; ушедший с адреса вида кадр отвязывается', () => {
  const direct = child(31, 'cyborg-plugin://panels/alice/?view=main');
  const nested = child(32, 'cyborg-plugin://panels/bob/?view=main', 'cyborg-plugin://panels', direct);
  const other = child(33, 'cyborg-plugin://carol/alice/', 'cyborg-plugin://carol');
  const foreign = child(34, 'https://example.org/', 'https://example.org');
  const { contents, commit, emitter } = windowOf([direct, nested, other, foreign]);
  trackViewFrames(contents, groups);
  for (const frame of [direct, nested, other, foreign]) commit(frame);
  assert.equal(pluginOfFrame(direct, groups), 'alice');
  assert.equal(pluginOfFrame(nested, groups), undefined, 'вложенный в вид кадр - не вид, даже с адресом соседа');
  assert.equal(pluginOfFrame(other, groups), undefined, 'плагин alice не состоит в группе carol');
  assert.equal(pluginOfFrame(foreign, groups), undefined, 'чужая страница');
  // Главный фрейм окна привязки не получает, кадр ушёл на about:blank - отвязан.
  commit(direct, 'about:blank', true);
  assert.equal(pluginOfFrame(direct, groups), 'alice', 'навигация главного фрейма кадров видов не трогает');
  commit(mutable(direct, 'about:blank'), 'about:blank');
  assert.equal(pluginOfFrame(direct, groups), undefined);
  emitter.emit('destroyed');
});

test('TR-31: привязка: исчезнувшие кадры забываются, окно закрыто - забываются все; senderPlugin идёт по привязке', () => {
  const alice = child(41, 'cyborg-plugin://panels/alice/?view=main');
  const bob = child(42, 'cyborg-plugin://panels/bob/?view=main');
  const { contents, commit, emitter } = windowOf([alice, bob]);
  trackViewFrames(contents, groups);
  commit(alice);
  commit(bob);
  const event = (senderFrame: FrameLike) => ({ senderFrame }) as unknown as Parameters<typeof senderPlugin>[0];
  mutable(alice, 'cyborg-plugin://panels/bob/');
  assert.equal(senderPlugin(event(alice), groups), 'alice', 'IPC кадра alice после pushState на bob - от alice');
  // bob убрали из окна; кадр с тем же номером не возвращается, но запись не должна копиться: следующая фиксация её вычищает.
  (contents.mainFrame as unknown as { framesInSubtree: unknown[] }).framesInSubtree = [MAIN, alice];
  commit(alice);
  assert.equal(pluginOfFrame(bob, groups), undefined, 'запись исчезнувшего кадра вычищена');
  emitter.emit('destroyed');
  assert.equal(pluginOfFrame(alice, groups), undefined, 'окно закрыто: привязки сняты');
});
