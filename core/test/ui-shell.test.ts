import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedLine, PtyExit, Reply, ThemeTokens } from '@cyborg-harness/contracts';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { load } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import { inlineHosts } from '../src/transports.ts';
import { connectView, mountModule, type TerminalEvent, type ViewBridge } from '../src/ui-shell.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

function fakeBridge(tokens: ThemeTokens) {
  const calls: unknown[][] = [];
  const on: { theme?: (t: ThemeTokens) => void; visibility?: (v: boolean) => void; log?: (l: FeedLine) => void; terminal?: (e: TerminalEvent) => void; channel?: (m: unknown) => void } = {};
  const bridge: ViewBridge = {
    run: async (command, args) => (calls.push(['run', command, ...args]), command === 'own.go' ? { value: args.length } : { error: `${command}: не команда плагина own` }),
    contract: async (contract): Promise<Reply> => (contract === 'test.files' ? { value: true } : contract === 'test.tab' ? { value: false } : { error: `${contract} нет в requires и optional` }),
    call: async (contract, major, method, args) => (calls.push(['call', contract, major, method, ...args]), { value: `${method}:${String(args[0])}` }),
    theme: async () => tokens,
    onTheme: (l) => (on.theme = l),
    onVisibility: (l) => (on.visibility = l),
    logs: async () => [],
    onLog: (l) => (on.log = l),
    startDrag: (path) => calls.push(['drag', path]),
    drop: async () => null,
    terminalOpen: async (ticket) => {
      calls.push(['open', ticket]);
      if (ticket !== 'билет') return { error: 'билет терминала не найден, просрочен или уже использован' };
      // Вывод, обогнавший ответ на open: вид не должен его потерять.
      on.terminal?.({ tid: 7, data: 'ранний ' });
      return { value: { tid: 7, id: 'pty-1', pid: 42, program: '/bin/sh', args: [], persist: true, backlog: '$ ' } };
    },
    terminalWrite: async (tid, data) => (calls.push(['write', tid, data]), {}),
    terminalResize: async (tid, cols, rows) => (calls.push(['resize', tid, cols, rows]), cols > 0 ? {} : { error: 'размер' }),
    terminalClose: (tid) => calls.push(['close', tid]),
    onTerminal: (l) => (on.terminal = l),
    state: async (view) => (view === 'main' ? { value: { opened: 1 } } : {}),
    dialog: async (view, spec) => (calls.push(['dialog', view, spec.kind]), spec.kind === 'ask' ? { value: spec.buttons[0]?.id } : { error: 'диалог: меню вне вида' }),
    keys: async () => ({ 'own.go': 'Ctrl+G' }),
    modal: async (view) => (view === 'form' ? { value: { data: { имя: 'черновик' } } } : {}),
    modalResize: async (view, size) => (calls.push(['modal-resize', view, size]), view === 'form' ? {} : { error: 'окна нет' }),
    modalClose: async (view, result) => (calls.push(['modal-close', view, result]), view === 'form' ? {} : { error: 'окна нет' }),
    channelPost: async (view, message) => (calls.push(['channel', view, message]), JSON.stringify(message).length > 20 ? { error: 'сообщение больше предела' } : {}),
    onChannel: (l) => (on.channel = l),
    setState: async (view, value) => (calls.push(['state', view, value]), (value === undefined ? 0 : JSON.stringify(value).length) > 20 ? { error: 'память вида больше 20 байт' } : {}),
  };
  return { bridge, calls, on };
}

test('connectView: тема на :root до mount и при смене, видимость без повторов, упавший слушатель не мешает соседу', async () => {
  const applied: ThemeTokens[] = [];
  const reported: unknown[] = [];
  const { bridge, on } = fakeBridge({ '--cy-bg': '#fff' });
  const ctx = await connectView(bridge, { pluginId: 'own', view: 'main', applyTheme: (t) => applied.push(t), report: (e) => reported.push(e) });
  assert.deepEqual(applied, [{ '--cy-bg': '#fff' }], 'mount получил бы вид без темы');

  const seen: string[] = [];
  const sub = ctx.theme.onChange((t) => seen.push(`тема ${t['--cy-bg'] ?? ''}`));
  ctx.onVisibilityChange(() => {
    throw new Error('сломан');
  });
  ctx.onVisibilityChange((v) => seen.push(`видим ${String(v)}`));
  on.theme?.({ '--cy-bg': '#000' });
  assert.equal(ctx.theme.tokens['--cy-bg'], '#000');
  on.visibility?.(true);
  on.visibility?.(false);
  on.visibility?.(false);
  assert.equal(ctx.visible, false);
  sub.dispose();
  on.theme?.({ '--cy-bg': '#111' });
  assert.deepEqual(seen, ['тема #000', 'видим false']);
  assert.equal(applied.length, 3, 'смена темы после отписки слушателя всё равно ставится на :root');
  assert.equal(reported.length, 1);
  assert.throws(() => Object.assign(ctx, { pluginId: 'чужой' }), TypeError);
});

test('connectView: команда и контракт идут мостом, отказ ядра - исключение, await на контракте не уходит вызовом', async () => {
  const { bridge, calls } = fakeBridge({});
  const ctx = await connectView(bridge, { pluginId: 'own', view: 'main', applyTheme: () => undefined, report: () => undefined });
  assert.equal(await ctx.commands.run('own.go', 1, 2), 2);
  await assert.rejects(ctx.commands.run('other.go'), /не команда плагина own/);

  const files = await ctx.contracts.get('test.files', 1);
  assert.ok(files);
  assert.equal(await files.read?.('a.md'), 'read:a.md');
  assert.equal(await ctx.contracts.get('test.tab', 1), undefined);
  await assert.rejects(ctx.contracts.get('test.clock', 1), /нет в requires/);
  ctx.drag.start('notes.md');
  assert.deepEqual(calls, [['run', 'own.go', 1, 2], ['run', 'other.go'], ['call', 'test.files', 1, 'read', 'a.md'], ['drag', 'notes.md']]);
});

test('ST-1003/8: mountModule: модуль без mount отклонён с причиной, dispose результата зовётся один раз', async () => {
  const ctx = await connectView(fakeBridge({}).bridge, { pluginId: 'own', view: 'main', applyTheme: () => undefined, report: () => undefined });
  assert.throws(() => mountModule({ default: () => undefined }, {}, ctx), /own: модуль вида main не экспортирует mount/);
  let disposed = 0;
  const roots: unknown[] = [];
  const handle = mountModule({ mount: (root: unknown) => (roots.push(root), { dispose: () => disposed++ }) }, 'корень', ctx);
  handle.dispose();
  handle.dispose();
  assert.deepEqual([roots, disposed], [['корень'], 1]);
  mountModule({ mount: () => undefined }, {}, ctx).dispose();
});

test('манифест ui.views: путь модуля только вниз от каталога плагина и без символов разметки', () => {
  const base = { id: 'own', version: '1.0.0', engines: { cyborg: '^1' } };
  const ok = parseManifest({ ...base, ui: { views: { tree: './ui/tree.js', main: './ui.js' } } });
  assert.ok(ok.ok && ok.manifest.ui?.views.tree === './ui/tree.js');
  const errorsOf = (ui: unknown) => {
    const r = parseManifest({ ...base, ui });
    return r.ok ? [] : r.errors;
  };
  for (const bad of ['ui.js', '../x/ui.js', './a/../../ui.js', '/abs/ui.js', './ui.ts', './"><script>.js', './a\\b.js', 'https://x/ui.js'])
    assert.ok(errorsOf({ views: { main: bad } }).some((e) => e.startsWith('ui.views.main:')), bad);
  assert.ok(errorsOf({ views: { Main: './ui.js' } }).some((e) => e.startsWith('ui.views.Main:')));
  assert.ok(errorsOf({ views: {} }).includes('ui.views: нет ни одного вида'));
  assert.ok(errorsOf({ popup: './pop.js', views: { main: './ui.js' } }).includes('ui.popup: ядро знает только ui.views, ui.overlay, ui.group и ui.inlineStyles'));
  assert.ok(errorsOf('./ui.js').some((e) => e.startsWith('ui:')));
});

test('terminal.open: хвост и вывод до подписки не теряются, ввод и размер идут по tid, выход и close', async () => {
  const { bridge, calls, on } = fakeBridge({});
  const ctx = await connectView(bridge, { pluginId: 'own', view: 'main', applyTheme: () => {}, report: () => {} });
  await assert.rejects(ctx.terminal.open('чужой'), /билет терминала не найден/);
  const term = await ctx.terminal.open('билет');
  assert.deepEqual([term.id, term.pid, term.backlog], ['pty-1', 42, '$ ']);
  on.terminal?.({ tid: 7, data: 'вывод' });
  const seen: string[] = [];
  term.onData((c) => seen.push(c));
  on.terminal?.({ tid: 7, data: ' дальше' });
  on.terminal?.({ tid: 8, data: 'чужой tid' });
  assert.deepEqual(seen, ['ранний ', 'вывод', ' дальше']);
  await term.write('ls\r');
  await term.resize(100, 30);
  await assert.rejects(term.resize(0, 30), /размер/);
  const exits: PtyExit[] = [];
  term.onExit((e) => exits.push(e));
  on.terminal?.({ tid: 7, exit: { code: 0 } });
  assert.deepEqual(exits, [{ code: 0 }]);
  term.close();
  term.close();
  assert.deepEqual(calls.filter((c) => c[0] !== 'open'), [['write', 7, 'ls\r'], ['resize', 7, 100, 30], ['resize', 7, 0, 30], ['close', 7]]);
});

test('память вида: до mount, set меняет value, отказ ядра - исключение и прежнее значение', async () => {
  const { bridge, calls } = fakeBridge({});
  const ctx = await connectView(bridge, { pluginId: 'own', view: 'main', applyTheme: () => undefined, report: () => undefined });
  assert.deepEqual(ctx.state.value, { opened: 1 });
  const seen = ctx.state.value;
  seen.opened = 99;
  assert.deepEqual(ctx.state.value, { opened: 1 }, 'value отдаёт копию');
  await ctx.state.set({ opened: 2 });
  assert.deepEqual(ctx.state.value, { opened: 2 });
  await assert.rejects(ctx.state.set({ text: 'x'.repeat(40) }), /больше 20 байт/);
  assert.deepEqual(ctx.state.value, { opened: 2 });
  await ctx.state.set(undefined);
  assert.equal(ctx.state.value, undefined);
  assert.deepEqual(calls.filter((c) => c[0] === 'state'), [['state', 'main', { opened: 2 }], ['state', 'main', { text: 'x'.repeat(40) }], ['state', 'main', undefined]]);
  const other = await connectView(bridge, { pluginId: 'own', view: 'side', applyTheme: () => undefined, report: () => undefined });
  assert.equal(other.state.value, undefined);
});

test('ядро: память вида в разделе $views state воркспейса, только объявленный вид, предел 64 КБ, параллельные записи не теряются', async () => {
  let doc: Record<string, unknown> = { own: { $version: 1, keep: true } };
  const store: LayerStore = { load: async () => structuredClone(doc), save: async (_layer, next) => void (doc = structuredClone(next)) };
  const state = await SectionStore.open(store, ['workspace']);
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    enabled: ['own'],
    manifests: [{ id: 'own', version: '1.0.0', engines: { cyborg: '^1' }, ui: { views: { main: './ui.js', side: './side.js' } } }],
    state,
  });
  assert.equal(k.viewState('own', 'main'), undefined);
  await Promise.all([k.setViewState('own', 'main', { a: 1 }), k.setViewState('own', 'side', { b: 2 })]);
  assert.deepEqual(doc.$views, { $version: 1, 'own/main': { a: 1 }, 'own/side': { b: 2 } });
  assert.deepEqual(doc.own, { $version: 1, keep: true }, 'раздел плагина не тронут');
  assert.deepEqual(k.viewState('own', 'side'), { b: 2 });
  assert.throws(() => k.viewState('own', 'нет'), { code: 'Invalid' });
  assert.throws(() => k.viewState('chat', 'main'), { code: 'Invalid' });
  assert.throws(() => k.setViewState('own', 'main', 'x'.repeat(64 * 1024)), { code: 'Invalid' });
  assert.throws(() => k.setViewState('own', 'main', 1n), TypeError);
  await k.setViewState('own', 'side', undefined);
  assert.deepEqual(doc.$views, { $version: 1, 'own/main': { a: 1 } });
  await k.unload();
});

test('диалоги и сочетания вида: ответ окна, отказ ядра - исключение; сочетание своей команды без запроса', async () => {
  const { bridge, calls } = fakeBridge({});
  const ctx = await connectView(bridge, { pluginId: 'own', view: 'main', applyTheme: () => undefined, report: () => undefined });
  assert.equal(await ctx.dialogs.show({ kind: 'ask', title: 'Удалить?', buttons: [{ id: 'yes', label: 'Да' }] }), 'yes');
  await assert.rejects(ctx.dialogs.show({ kind: 'menu', items: [{ id: 'a', label: 'A' }], at: { x: 0, y: 0 } }), /меню вне вида/);
  assert.deepEqual(calls.filter((c) => c[0] === 'dialog'), [['dialog', 'main', 'ask'], ['dialog', 'main', 'menu']]);
  assert.equal(ctx.keys.of('own.go'), 'Ctrl+G');
  assert.equal(ctx.keys.of('toString'), undefined);
});

test('connectView: канал с главной частью - сообщения вида идут мостом под именем вида, сообщения главной части - слушателям, отказ - исключение', async () => {
  const reported: unknown[] = [];
  const { bridge, calls, on } = fakeBridge({});
  const ctx = await connectView(bridge, { pluginId: 'own', view: 'main', applyTheme: () => undefined, report: (e) => reported.push(e) });
  await ctx.channel.post({ ask: 1 });
  await assert.rejects(ctx.channel.post({ big: 'x'.repeat(30) }), /больше предела/);
  assert.deepEqual(calls, [['channel', 'main', { ask: 1 }], ['channel', 'main', { big: 'x'.repeat(30) }]]);

  const seen: unknown[] = [];
  ctx.channel.onMessage(() => {
    throw new Error('сломан');
  });
  const sub = ctx.channel.onMessage((m) => seen.push(m));
  on.channel?.('раз');
  on.channel?.({ два: 2 });
  sub.dispose();
  on.channel?.('после отписки');
  assert.deepEqual(seen, ['раз', { два: 2 }]);
  assert.equal(reported.length, 3, 'упавший слушатель сообщён оболочке на каждое сообщение, соседу он не мешает');
  assert.throws(() => Object.assign(ctx.channel, { post: () => undefined }), TypeError, 'плагин не подменит канал');
});

test('connectView: у вида модального окна есть ctx.modal с данными владельца, close отдаёт результат мостом; у обычного вида ctx.modal нет', async () => {
  const { bridge, calls } = fakeBridge({});
  const shell = { pluginId: 'own', applyTheme: () => undefined, report: () => undefined };
  const plain = await connectView(bridge, { ...shell, view: 'main' });
  assert.equal(plain.modal, undefined);
  const form = await connectView(bridge, { ...shell, view: 'form' });
  const modal = form.modal;
  assert.ok(modal, 'у вида модального окна есть ctx.modal');
  assert.deepEqual(modal.data, { имя: 'черновик' });
  await modal.resize({ height: 320 });
  assert.deepEqual(calls.at(-1), ['modal-resize', 'form', { height: 320 }]);
  await modal.close({ имя: 'Проект' });
  assert.deepEqual(calls.at(-1), ['modal-close', 'form', { имя: 'Проект' }]);
  assert.throws(() => Object.assign(modal, { data: 1 }), TypeError, 'данные окна не подменить');
});
