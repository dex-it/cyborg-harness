import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import { framesOfPlugin, pluginOfFrame, senderPlugin, type FrameLike, type ViewGroups } from '../src/view-frames.ts';

// K-04: мост узнаёт плагин по пути адреса кадра внутри группы из его origin. Граница доверия - группа: плагины одной группы подменяют друг друга,
// плагин вне группы кадра - нет. Адрес берётся из главного процесса (последний принятый адрес кадра), а не из слов вида.
const groups: ViewGroups = { groupOf: (id) => ({ alice: 'panels', bob: 'panels', carol: 'carol' })[id] };
const at = (url: string, origin = 'cyborg-plugin://panels'): FrameLike => ({ url, origin });

test('мост: плагин кадра - первый сегмент пути в группе из origin', () => {
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/alice/?view=main'), groups), 'alice');
  assert.equal(pluginOfFrame(at('cyborg-plugin://carol/carol/', 'cyborg-plugin://carol'), groups), 'carol');
  assert.equal(pluginOfFrame(at('cyborg-plugin://panels/bob/ui/page.html#x'), groups), 'bob');
});

test('мост: доверие только внутри группы - адрес вне группы, чужой плагин, расхождение origin и адреса не дают плагина', () => {
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

test('мост: senderPlugin берёт плагин из кадра-отправителя, без кадра - undefined', () => {
  const event = (senderFrame: FrameLike | null) => ({ senderFrame }) as unknown as Parameters<typeof senderPlugin>[0];
  assert.equal(senderPlugin(event(at('cyborg-plugin://panels/alice/?view=main')), groups), 'alice');
  assert.equal(senderPlugin(event(at('cyborg-plugin://panels/carol/')), groups), undefined);
  assert.equal(senderPlugin(event(null), groups), undefined);
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
