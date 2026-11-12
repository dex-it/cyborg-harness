import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ShownModal, WindowSnapshot } from '@cyborg-harness/core/window';
import type { Reply } from '@cyborg-harness/contracts';
import type { LayoutRow, PluginRow } from '../src/snapshot.ts';
import { WindowLayerView, type WindowPort } from '../src/window-layer.ts';
import { installFakeDom, type FakeDocument, type FakeElement } from './fake-dom.ts';

// Слой окна (SAD 3.8) без Electron: подделка DOM из fake-dom.ts. Что показывать, решает ядро (core/test/window.test.ts), здесь - что слой рисует и кому отвечает.

const ok: Reply = {};
interface Calls {
  readonly answered: [number, string | undefined][];
  readonly cancelled: number[];
}

function setup(): { readonly document: FakeDocument; readonly main: FakeElement; readonly lockLayer: FakeElement; readonly view: WindowLayerView; readonly calls: Calls; readonly restore: () => void } {
  const { document, restore } = installFakeDom();
  const calls: Calls = { answered: [], cancelled: [] };
  const port: WindowPort = {
    answerDialog: async (id, choice) => {
      calls.answered.push([id, choice]);
      return ok;
    },
    cancelModal: async (id) => {
      calls.cancelled.push(id);
      return ok;
    },
  };
  const main = document.createElement('main');
  const lockLayer = document.createElement('div');
  document.body.append(main, lockLayer);
  const view = new WindowLayerView(port, main as unknown as HTMLElement, lockLayer as unknown as HTMLElement);
  return { document, main, lockLayer, view, calls, restore };
}

const snapshot = (fields: Partial<WindowSnapshot> = {}): WindowSnapshot => ({ title: 'Cyborg', queued: 0, locks: [], ...fields });
const modal = (fields: Partial<ShownModal> = {}): ShownModal => ({ id: 1, pluginId: 'panels', view: 'form', title: 'Новый проект', ...fields });
const layout: LayoutRow[] = [{ kind: 'view', pluginId: 'panels', name: 'form', area: 'modal', order: 0, url: 'cyborg-plugin://panels/ui/form.html?view=form' } as unknown as LayoutRow];
const dialogsOf = (document: FakeDocument, cls: string): FakeElement[] => document.body.all('dialog').filter((d) => d.className.split(' ').includes(cls));
/** Единственный диалог с классом; нет его - тест красный здесь, а не на разыменовании undefined. */
const only = (document: FakeDocument, cls: string): FakeElement => {
  const found = dialogsOf(document, cls);
  assert.equal(found.length, 1, `диалогов ${cls} на экране: ${String(found.length)}`);
  return found[0]!;
};
const child = (parent: FakeElement, cls: string, index = 0): FakeElement => {
  const found = parent.withClass(cls)[index];
  assert.ok(found, `в ${parent.tagName} нет .${cls} №${String(index)}`);
  return found;
};

test('слой окна: модальное окно - диалог с названием, владельцем и фреймом вида; остальное окно inert; умолчания размера слою не принадлежат', () => {
  const { document, main, view, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal() }), [], layout);
    const dialog = only(document, 'layer-modal');
    assert.equal(dialog.open, true);
    assert.equal(dialog.showModalCalls, 1);
    assert.equal(dialog.getAttribute('aria-label'), 'Новый проект');
    assert.deepEqual({ ...dialog.dataset }, { plugin: 'panels', view: 'form', modal: '1' });
    assert.ok(dialog.withClass('layer-from').some((e) => e.textContent === 'panels'), 'окно не подписано плагином-владельцем');
    const frame = dialog.all('iframe')[0];
    assert.ok(frame, 'во фрейме окна нет вида');
    assert.equal(frame.src, 'cyborg-plugin://panels/ui/form.html?view=form');
    assert.equal(frame.title, 'panels/form');
    assert.equal(document.activeElement, frame, 'фокус не во фрейме вида');
    assert.equal(main.inert, true);
    assert.deepEqual({ ...dialog.style }, {}, 'без просьбы автора слой не задаёт размер: он у стиля приложения');
    assert.equal(dialog.dataset.escape, undefined);

    view.sync(snapshot(), [], layout);
    assert.equal(dialogsOf(document, 'layer-modal').length, 0, 'снятое ядром окно осталось на экране');
    assert.equal(main.inert, false);
  } finally {
    restore();
  }
});

test('слой окна: размер от автора ложится на диалог, не выходя за экран; сторона без значения остаётся умолчанием', () => {
  const { document, view, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal({ size: { width: 720, height: 480 } }) }), [], layout);
    assert.deepEqual({ ...only(document, 'layer-modal').style }, { width: 'min(720px, 90vw)', height: 'min(480px, 80vh)' });

    view.sync(snapshot({ modal: modal({ id: 2, size: { height: 200 } }) }), [], layout);
    assert.deepEqual({ ...only(document, 'layer-modal').style }, { height: 'min(200px, 80vh)' }, 'старое окно не снято при смене или ширину слой выдумал');
  } finally {
    restore();
  }
});

test('слой окна: высота области вида, о которой просит вид, меняет фрейм того же окна, а не пересоздаёт его; окно не выше 80vh и не выше экрана', () => {
  const { document, view, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal({ size: { width: 700, height: 300 } }) }), [], layout);
    const dialog = only(document, 'layer-modal');
    const frame = dialog.all('iframe')[0];
    assert.ok(frame, 'во фрейме окна нет вида');
    assert.equal(frame.style.height, undefined, 'пока вид не просил, высота фрейма у стиля приложения');

    view.sync(snapshot({ modal: modal({ size: { width: 700, height: 300 }, contentHeight: 420 }) }), [], layout);
    assert.equal(only(document, 'layer-modal'), dialog, 'то же окно: вид остался смонтированным, а не перезагружен');
    assert.equal(dialog.showModalCalls, 1);
    assert.equal(dialog.all('iframe')[0], frame);
    assert.equal(frame.style.height, '420px', 'высота области вида - высота фрейма');
    assert.equal(dialog.style.height, 'fit-content', 'окно по содержимому: шапка + область вида, а не размер автора');
    assert.equal(dialog.style.maxHeight, '80vh', 'выше 80% высоты экрана окно не растёт');
    assert.equal(frame.style.flex, '0 1 auto', 'фрейм уступает, когда окно упёрлось в потолок');
    assert.equal(frame.style.minHeight, '0');
    assert.equal(dialog.style.width, 'min(700px, 90vw)', 'ширина автора на месте');

    view.sync(snapshot({ modal: modal({ size: { width: 700, height: 300 }, contentHeight: 150 }) }), [], layout);
    assert.equal(frame.style.height, '150px', 'вторая просьба заменяет первую');

    view.sync(snapshot({ modal: modal({ id: 2 }) }), [], layout);
    const next = only(document, 'layer-modal');
    assert.notEqual(next, dialog);
    assert.equal(next.all('iframe')[0]?.style.height, undefined, 'следующему окну высота прошлого не достаётся');
    assert.equal(next.style.height, undefined);
  } finally {
    restore();
  }
});

test('слой окна: окно уже с высотой вида показывается с ней сразу (отложенное замком окно вернулось); заглушка без фрейма просьбу переносит без ошибки', () => {
  const { document, view, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal({ contentHeight: 260 }) }), [], layout);
    const dialog = only(document, 'layer-modal');
    assert.equal(dialog.all('iframe')[0]?.style.height, '260px');
    assert.equal(dialog.style.height, 'fit-content');
    view.sync(snapshot(), [], layout);

    view.sync(snapshot({ modal: modal({ id: 5 }) }), [], []);
    view.sync(snapshot({ modal: modal({ id: 5, contentHeight: 300 }) }), [], []);
    const stub = only(document, 'layer-modal');
    assert.equal(stub.all('iframe').length, 0);
    assert.ok(stub.withClass('layer-modal-missing').length > 0);
  } finally {
    restore();
  }
});

test('слой окна: Escape вида - диалог не закрывается сам по cancel, по умолчанию закрывается как обычно', () => {
  const { document, view, calls, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal({ escape: 'view' }) }), [], layout);
    const own = only(document, 'layer-modal');
    assert.equal(own.dataset.escape, 'view', 'режим Escape не виден смоку');
    assert.equal(own.dispatch('cancel').defaultPrevented, true, 'Escape в документе окна закрыл диалог, который Escape оставил виду');
    assert.equal(own.open, true);
    assert.deepEqual(calls.cancelled, []);

    view.sync(snapshot({ modal: modal({ id: 2 }) }), [], layout);
    const plain = only(document, 'layer-modal');
    assert.equal(plain.dataset.escape, undefined);
    assert.equal(plain.dispatch('cancel').defaultPrevented, false, 'по умолчанию Escape закрывает окно движком');
  } finally {
    restore();
  }
});

test('слой окна: закрытие человеком (кнопка, close) отдаёт отмену ядру один раз, снятие ядром отмены не шлёт', () => {
  const { document, view, calls, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal() }), [], layout);
    const dialog = only(document, 'layer-modal');
    child(dialog, 'layer-modal-close').dispatch('click');
    assert.deepEqual(calls.cancelled, [1], 'кнопка закрытия не дошла до ядра');
    dialog.dispatch('close');
    assert.deepEqual(calls.cancelled, [1], 'повторное закрытие ответило ещё раз');

    view.sync(snapshot({ modal: modal({ id: 2 }) }), [], layout);
    view.sync(snapshot(), [], layout);
    assert.deepEqual(calls.cancelled, [1], 'окно, снятое самим ядром, отправило отмену');
  } finally {
    restore();
  }
});

test('слой окна: вида нет в раскладке - заглушка и фокус на кнопке закрытия; краевые ловушки возвращают фокус внутрь', () => {
  const { document, view, restore } = setup();
  try {
    view.sync(snapshot({ modal: modal() }), [], []);
    const missing = only(document, 'layer-modal');
    assert.ok(missing.withClass('layer-modal-missing').length > 0, 'нет заглушки');
    assert.equal(missing.all('iframe').length, 0);
    assert.equal(document.activeElement, child(missing, 'layer-modal-close'));
    view.sync(snapshot(), [], []);

    view.sync(snapshot({ modal: modal({ id: 3 }) }), [], layout);
    const dialog = only(document, 'layer-modal');
    assert.equal(dialog.withClass('layer-modal-trap').length, 2);
    child(dialog, 'layer-modal-trap', 1).dispatch('focus');
    assert.equal(document.activeElement, child(dialog, 'layer-modal-close'), 'ловушка после вида вернула фокус не к началу окна');
    child(dialog, 'layer-modal-trap', 0).dispatch('focus');
    assert.equal(document.activeElement, dialog.all('iframe')[0], 'ловушка перед видом вернула фокус не к виду');
  } finally {
    restore();
  }
});

test('ST-2004/2: слой окна: диалог ask отвечает выбранной кнопкой один раз, снятие ядром закрывает без ответа, меню отменяется кликом мимо и не выходит за окно', () => {
  const { document, view, calls, restore } = setup();
  try {
    const ask = { id: 5, pluginId: 'chat', view: 'main', spec: { kind: 'ask' as const, title: 'Удалить?', message: 'Без возврата', buttons: [{ id: 'yes', label: 'Да' }, { id: 'no', label: 'Нет' }] } };
    view.sync(snapshot({ dialog: ask }), [], []);
    const dialog = only(document, 'layer-ask');
    assert.equal(dialog.getAttribute('aria-label'), 'Удалить?');
    assert.ok(dialog.withClass('layer-from').some((e) => e.textContent === 'Спрашивает chat'));
    dialog.all('button').find((b) => b.dataset.choice === 'yes')?.dispatch('click');
    assert.deepEqual(calls.answered, [[5, 'yes']], 'close после клика ответил второй раз или ответ не дошёл');
    assert.equal(dialog.open, false);

    view.sync(snapshot({ dialog: { ...ask, id: 6 } }), [], []);
    view.sync(snapshot(), [], []);
    assert.equal(calls.answered.length, 1, 'диалог, снятый ядром, ответил сам');
    assert.equal(dialogsOf(document, 'layer-ask').length, 0);

    const menu = { id: 7, pluginId: 'chat', view: 'main', spec: { kind: 'menu' as const, items: [{ id: 'a', label: 'A' }], at: { x: 990, y: 790 } } };
    view.sync(snapshot({ dialog: menu }), [], []);
    const shown = only(document, 'layer-menu');
    assert.deepEqual({ left: shown.style.left, top: shown.style.top }, { left: '900px', top: '750px' }, 'меню вылезло за край окна');
    shown.dispatch('click', shown);
    assert.deepEqual(calls.answered.at(-1), [7, undefined], 'клик мимо меню - не выбор');
  } finally {
    restore();
  }
});

test('слой окна: замок прячет остальное окно и показывает экран владельца, снятие замка убирает экран', () => {
  const { document, main, lockLayer, view, restore } = setup();
  try {
    const plugins = [{ id: 'pin', overlay: 'cyborg-plugin://pin/ui/lock.html' }] as unknown as PluginRow[];
    const locks = [{ pluginId: 'pin', hideNotifications: false }];
    view.sync(snapshot({ locks }), plugins, []);
    assert.equal(document.body.dataset.locked, 'true');
    assert.equal(main.inert, true);
    assert.equal(lockLayer.hidden, false);
    assert.equal(lockLayer.all('iframe')[0]?.src, 'cyborg-plugin://pin/ui/lock.html');

    view.sync(snapshot({ locks }), [{ id: 'pin' }] as unknown as PluginRow[], []);
    assert.equal(lockLayer.all('iframe').length, 0, 'экран с прежним адресом остался');
    assert.ok(lockLayer.withClass('lock-wait').length > 0, 'без адреса нет надписи ожидания');

    view.sync(snapshot(), plugins, []);
    assert.equal(document.body.dataset.locked, 'false');
    assert.equal(main.inert, false);
    assert.equal(lockLayer.hidden, true);
    assert.equal(lockLayer.withClass('lock-screen').length, 0);
  } finally {
    restore();
  }
});
