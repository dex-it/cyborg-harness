import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HostHandle } from '../src/transports.ts';
import { load, type LoadOptions } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts } from '../src/transports.ts';
import { keepFocus } from '../src/ui-shell.ts';
import { parseDialog, reservedId, WINDOW_OWNER, WindowLayer, type WindowSnapshot } from '../src/window-layer.ts';

const shown = (layer: WindowLayer) => layer.snapshot.dialog;
const shownId = (layer: WindowLayer): number => {
  const dialog = layer.snapshot.dialog;
  assert.ok(dialog, 'диалога на экране нет');
  return dialog.id;
};
const ask = (...ids: string[]) => ({ kind: 'ask', title: 'Вопрос', buttons: ids.map((id) => ({ id, label: id })) });

test('parseDialog: описание вида проверяется, в окно уходит разобранная копия', () => {
  assert.deepEqual(parseDialog({ kind: 'ask', title: 'Удалить?', message: 'Файл', buttons: [{ id: 'yes', label: 'Да', extra: 1 }] }), {
    kind: 'ask',
    title: 'Удалить?',
    message: 'Файл',
    buttons: [{ id: 'yes', label: 'Да' }],
  });
  assert.deepEqual(parseDialog({ kind: 'menu', items: [{ id: 'a', label: 'A' }], at: { x: 1, y: 2 } }), { kind: 'menu', items: [{ id: 'a', label: 'A' }], at: { x: 1, y: 2 } });
  for (const bad of [
    null,
    { kind: 'html', title: 'x' },
    { kind: 'ask', title: '', buttons: [{ id: 'a', label: 'A' }] },
    { kind: 'ask', title: 'x', buttons: [] },
    { kind: 'ask', title: 'x', buttons: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] },
    { kind: 'ask', title: 'x'.repeat(201), buttons: [{ id: 'a', label: 'A' }] },
    { kind: 'ask', title: 'x', buttons: Array.from({ length: 13 }, (_, i) => ({ id: String(i), label: 'x' })) },
    { kind: 'menu', items: [{ id: 'a', label: 'A' }], at: { x: Number.NaN, y: 0 } },
  ]) {
    assert.throws(() => parseDialog(bad), { code: 'Invalid' }, JSON.stringify(bad));
  }
});

test('слой окна: диалоги по одному и по порядку, ответ - только пункт показанного диалога, выгрузка закрывает свои', async () => {
  const snaps: WindowSnapshot[] = [];
  const layer = new WindowLayer((s) => snaps.push(s));
  const first = layer.show('a', 'main', ask('yes', 'no'));
  const second = layer.show('b', 'main', ask('ok'));
  const third = layer.show('a', 'main', ask('ok'));
  assert.equal(shown(layer)?.pluginId, 'a');
  assert.equal(layer.snapshot.queued, 2);
  const first_ = shownId(layer);
  assert.throws(() => layer.answer(first_ + 1, 'ok'), { code: 'NotFound' });
  assert.throws(() => layer.answer(first_, 'ok'), { code: 'Invalid' }, 'пункт не из этого диалога');
  layer.answer(first_, 'no');
  assert.equal(await first, 'no');
  assert.equal(shown(layer)?.pluginId, 'b');
  layer.forget('a');
  assert.equal(await third, undefined, 'выгрузка плагина закрывает его диалоги в очереди');
  layer.answer(shownId(layer), undefined);
  assert.equal(await second, undefined, 'Escape - undefined');
  assert.equal(shown(layer), undefined);
  assert.ok(snaps.length >= 4);
  for (let i = 0; i < 8; i++) void layer.show('c', 'main', ask('ok'));
  assert.throws(() => layer.show('c', 'main', ask('ok')), { code: 'Invalid' }, 'очередь одного плагина ограничена');
  layer.clear();
});

test('слой окна под замком: чужой диалог уходит в очередь, свои у владельца идут первыми; окно открыто, когда сняты все замки', async () => {
  const layer = new WindowLayer(() => undefined);
  const other = layer.show('chat', 'main', ask('ok'));
  assert.equal(shown(layer)?.pluginId, 'chat');
  layer.lock('pin', true);
  layer.lock('guard', false);
  assert.equal(shown(layer), undefined, 'чужой диалог не виден под замком');
  assert.equal(layer.hideNotifications, true);
  assert.ok(!layer.allows('chat') && layer.allows('pin') && layer.allows('guard'));
  const own = layer.show('pin', 'overlay', ask('ok'));
  assert.equal(shown(layer)?.pluginId, 'pin');
  layer.answer(shownId(layer), 'ok');
  assert.equal(await own, 'ok');
  layer.release('chat');
  layer.release('pin');
  assert.equal(shown(layer), undefined, 'второй замок ещё стоит');
  assert.equal(layer.hideNotifications, false);
  layer.release('guard');
  assert.equal(shown(layer)?.pluginId, 'chat', 'отложенный диалог вернулся после снятия замков');
  layer.answer(shownId(layer), 'ok');
  assert.equal(await other, 'ok');
});

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
const pinManifest = (fields: Record<string, unknown> = {}) =>
  manifest('pin', { commands: { 'pin.lock': { args: ['boolean'] }, 'pin.unlock': {}, 'pin.notify': {} }, keybindings: [{ key: 'Ctrl+L', command: 'pin.unlock' }], permissions: { 'ui.lock': true, notify: true }, ui: { overlay: './lock.js' }, ...fields });
const pin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('pin.lock', async (hide) => {
      await ctx.os.ui?.lock({ hideNotifications: hide === true });
    });
    ctx.commands.register('pin.unlock', async () => {
      const lock = await ctx.os.ui?.lock();
      await lock?.release();
    });
    ctx.commands.register('pin.notify', () => ctx.os.notify?.show('Сессия', 'ждёт ответа'));
    return undefined;
  },
};

function kernel(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>) {
  const handles = new Map<string, HostHandle>();
  const notes: string[] = [];
  const snaps: WindowSnapshot[] = [];
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-window-'));
  return {
    handles,
    notes,
    snaps,
    start: () =>
      load({
        apiVersion: '1.0.0',
        spawnHost: (id) => {
          const h = base(id);
          handles.set(id, h);
          return h;
        },
        os: { dataDir: dir, tempDir: dir, notify: (t, b) => void notes.push(`${t}: ${b ?? ''}`) },
        onWindow: (s) => snaps.push(s),
        watchdog: { interval: 20, timeout: 1000, strikes: 3 },
        ...options,
      }),
  };
}

test('замок окна: только с правом, сочетания и выключение - только у владельца, падение хоста окно не открывает, уведомления без текста', async () => {
  const chat: PluginModule = {
    activate(ctx) {
      ctx.commands.register('chat.go', () => 'go');
      ctx.commands.register('chat.lock', async () => {
        await (ctx.os as { ui?: { lock(): Promise<unknown> } }).ui?.lock();
      });
      return undefined;
    },
  };
  const { start, handles, notes } = kernel(
    { pin, chat, store: { activate: () => undefined } },
    {
      enabled: ['store', 'pin', 'chat'],
      manifests: [
        manifest('store', { provides: { 'test.files': '1.0' } }),
        pinManifest({ requires: { 'test.files': '^1' } }),
        manifest('chat', { commands: { 'chat.go': {}, 'chat.lock': {} }, keybindings: [{ key: 'Ctrl+G', command: 'chat.go' }] }),
      ],
      hosts: { p: ['pin'], c: ['chat'], s: ['store'] },
      platform: 'linux',
    },
  );
  const k = await start();
  await k.run('chat.lock');
  assert.deepEqual(k.window.locks, [], 'ctx.os.ui без права нет');

  await k.run('pin.lock', true);
  assert.deepEqual(k.window.locks, [{ pluginId: 'pin', hideNotifications: true }]);
  assert.equal(k.keybinding('Ctrl+G'), undefined, 'чужое сочетание под замком не работает');
  assert.equal(k.keybinding('Ctrl+L')?.command, 'pin.unlock');
  await assert.rejects(k.disable('pin'), { code: 'Invalid' });
  await assert.rejects(k.disable('store'), { code: 'Invalid' }, 'store унёс бы pin по requires');
  await k.run('pin.notify');
  assert.deepEqual(notes, ['Cyborg: новое событие']);

  handles.get('p')?.kill();
  await new Promise((r) => setTimeout(r, 50));
  await k.idle();
  assert.deepEqual(k.window.locks, [{ pluginId: 'pin', hideNotifications: true }], 'хост владельца упал - окно закрыто');
  assert.ok(k.active.includes('pin'), 'сторож вернул плагин замка');

  await k.run('pin.unlock');
  assert.deepEqual(k.window.locks, []);
  assert.equal(k.keybinding('Ctrl+G')?.command, 'chat.go');
  await k.run('pin.notify');
  assert.deepEqual(notes, ['Cyborg: новое событие', 'Сессия: ждёт ответа']);
  await k.disable('pin');
  await k.unload();
});

test('диалог вида: только объявленный вид, ответ человека доходит, выключение плагина закрывает его диалог', async () => {
  const { start, snaps } = kernel(
    { chat: { activate: () => undefined } },
    { enabled: ['chat'], manifests: [manifest('chat', { ui: { views: { main: './ui.js' } } })] },
  );
  const k = await start();
  assert.throws(() => k.showDialog('chat', 'side', ask('ok')), { code: 'Invalid' });
  assert.throws(() => k.showDialog('chat', 'main', { kind: 'ask' }), { code: 'Invalid' });
  const answered = k.showDialog('chat', 'main', ask('yes', 'no'));
  const onScreen = k.window.dialog;
  assert.equal(snaps.at(-1)?.dialog?.id, onScreen?.id, 'окно узнало о диалоге');
  k.answerDialog(onScreen?.id ?? -1, 'yes');
  assert.equal(await answered, 'yes');
  const dropped = k.showDialog('chat', 'main', ask('ok'));
  await k.disable('chat');
  assert.equal(await dropped, undefined);
  assert.equal(k.window.dialog, undefined);
  await k.unload();
});

test('lock.onStart: окно закрыто до активации, ленивый плагин замка активируется сразу; безопасный режим не запирает', async () => {
  const order: string[] = [];
  const watched: PluginModule = {
    activate(ctx) {
      order.push('activate');
      return pin.activate(ctx);
    },
  };
  const options = { enabled: ['pin'], manifests: [pinManifest({ lock: { onStart: true }, activation: 'lazy' })] };
  const { start, snaps } = kernel({ pin: watched }, options);
  const k = await start();
  assert.equal(snaps[0]?.locks[0]?.pluginId, 'pin', 'первый снимок окна уже с замком');
  assert.deepEqual(order, ['activate']);
  assert.deepEqual(k.keysOf('pin'), { 'pin.unlock': 'Ctrl+L' });
  await k.run('pin.unlock');
  assert.deepEqual(k.window.locks, []);
  await k.unload();

  const safe = await kernel({ pin: watched }, { ...options, safeMode: true }).start();
  assert.deepEqual(safe.window.locks, [], 'безопасный режим - выход, если плагин замка не открывает окно');
  await safe.unload();
});

test('манифест: ui.lock только с ui.overlay, overlay и lock.onStart - только с правом, имя overlay занято', () => {
  const errors = (fields: Record<string, unknown>) => {
    const r = parseManifest(manifest('pin', fields));
    return r.ok ? [] : r.errors;
  };
  assert.deepEqual(errors({ permissions: { 'ui.lock': true }, ui: { overlay: './lock.js' }, lock: { onStart: true } }), []);
  assert.match(errors({ permissions: { 'ui.lock': true } }).join(), /нужен ui.overlay/);
  assert.match(errors({ ui: { overlay: './lock.js' } }).join(), /ui.overlay: только с правом/);
  assert.match(errors({ lock: { onStart: true } }).join(), /lock.onStart: только с правом/);
  assert.match(errors({ lock: { onStart: false } }).join(), /lock: допустимо только/);
  assert.match(errors({ ui: { views: { overlay: './x.js' } } }).join(), /имя занято/);
  assert.match(errors({ permissions: { 'ui.lock': true }, ui: { overlay: '../lock.js' } }).join(), /ui.overlay: ожидается путь/);
});

test('команды окна: F6 и Shift+F6 у ядра, плагин их не перехватит, человек переназначит; под замком не работают', async () => {
  const pad: PluginModule = {
    activate(ctx) {
      ctx.commands.register('pad.open', () => 'open');
      return undefined;
    },
  };
  const { start } = kernel(
    { pin, pad },
    {
      enabled: ['pin', 'pad'],
      manifests: [pinManifest(), manifest('pad', { commands: { 'pad.open': {} }, keybindings: [{ key: 'F6', command: 'pad.open' }] })],
      keybindings: [
        { key: 'Ctrl+Alt+Right', command: 'cyborg.window.focus-next' },
        { key: 'Shift+F6', command: null },
      ],
      platform: 'linux',
    },
  );
  const k = await start();
  assert.deepEqual(k.keybinding('F6'), { key: 'F6', command: 'cyborg.window.focus-next', pluginId: WINDOW_OWNER, shadowed: [{ pluginId: 'pad', command: 'pad.open' }] });
  assert.ok(k.journal.some((e) => e.kind === 'key-conflict' && e.pluginId === 'pad' && e.winner === WINDOW_OWNER));
  assert.equal(k.keybinding('Ctrl+Alt+Right')?.command, 'cyborg.window.focus-next');
  assert.ok(!k.journal.some((e) => e.kind === 'key-ignored'), 'команда окна - известная команда');
  assert.equal(k.keybinding('Shift+F6'), undefined, 'освобождённое сочетание идёт в окно');
  await k.run('pin.lock', false);
  assert.equal(k.keybinding('F6'), undefined, 'под замком области недоступны');
  await k.run('pin.unlock');
  assert.equal(k.keybinding('F6')?.pluginId, WINDOW_OWNER);
  await k.unload();
});

test('манифест: id, в пространстве которого лежат команды окна, занят', () => {
  for (const id of ['cyborg', 'cyborg.window']) assert.equal(reservedId(id), true, id);
  for (const id of ['cyborg.files', 'cyborg.window.focus-next', 'window']) assert.equal(reservedId(id), false, id);
  const r = parseManifest(manifest('cyborg.window'));
  assert.ok(!r.ok && r.errors.join().includes('занято командами окна'));
});

test('keepFocus: фокус, пришедший во фрейм, ложится на autofocus или первый элемент, но не сбивает запомненный', () => {
  const focused: string[] = [];
  const el = (name: string) => ({ focus: () => void focused.push(name) });
  const listeners = new Set<() => void>();
  const doc: { activeElement: unknown; body: unknown } = { activeElement: null, body: {} };
  const win = {
    document: doc,
    addEventListener: (_: 'focus', l: () => void) => void listeners.add(l),
    removeEventListener: (_: 'focus', l: () => void) => void listeners.delete(l),
  };
  let auto: ReturnType<typeof el> | null = null;
  const sub = keepFocus(win, { querySelector: (s) => (s === '[autofocus]' ? auto : el('первая кнопка')) });
  const arrive = () => listeners.forEach((l) => l());
  arrive();
  doc.activeElement = doc.body;
  auto = el('поле');
  arrive();
  doc.activeElement = { name: 'запомненный' };
  arrive();
  assert.deepEqual(focused, ['первая кнопка', 'поле']);
  sub.dispose();
  assert.equal(listeners.size, 0);
});

test('замок окна: системный диалог чужого плагина не встаёт поверх экрана замка', async () => {
  const picker: PluginModule = {
    activate(ctx) {
      ctx.commands.register('picker.pick', () => ctx.os.dialog.open());
      return undefined;
    },
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-window-dialog-'));
  const { start } = kernel(
    { pin, picker },
    {
      enabled: ['pin', 'picker'],
      manifests: [pinManifest(), manifest('picker', { commands: { 'picker.pick': {} } })],
      os: { dataDir: dir, tempDir: dir, dialog: { open: async () => ['/выбран'] } },
    },
  );
  const k = await start();
  assert.deepEqual(await k.run('picker.pick'), ['/выбран']);
  await k.run('pin.lock', false);
  await assert.rejects(k.run('picker.pick'), { code: 'Unavailable' });
  await k.run('pin.unlock');
  assert.deepEqual(await k.run('picker.pick'), ['/выбран']);
  await k.unload();
});
