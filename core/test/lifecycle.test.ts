import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { keyOfInput, normalizeKey, resolveKey } from '../src/keys.ts';
import { load, type JournalEntry, type LoadOptions } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import type { PluginModule } from '../src/plugin.ts';
import { pluginStatuses } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

function kernel(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>) {
  const spawned: string[] = [];
  const base = inlineHosts(async (entry) => {
    const mod = table[entry];
    if (!mod) throw new Error(`нет модуля ${entry}`);
    return mod;
  });
  return {
    spawned,
    start: () =>
      load({
        apiVersion: '1.0.0',
        spawnHost: (id) => {
          spawned.push(id);
          return base(id);
        },
        ...options,
      }),
  };
}

const lines = (journal: readonly JournalEntry[], from = 0) =>
  journal.slice(from).map((e) => (e.kind === 'unloaded' ? `${e.pluginId}:unloaded:${e.by}` : `${e.pluginId ?? '-'}:${e.kind}`));

const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

const files: PluginModule = { activate: (ctx) => ctx.contracts.provide('test.files', '1.0', { read: (p: string) => p }) };
const idle: PluginModule = { activate: () => undefined };

test('disable: требующие выгружаются вместе с поставщиком, необязательный остаётся; enable поднимает их в порядке графа', async () => {
  let changes = 0;
  const { start, spawned } = kernel(
    {
      files,
      editor: idle,
      preview: idle,
      tabs: {
        activate(ctx) {
          ctx.contracts.onChange('test.files', () => changes++);
          return undefined;
        },
      },
    },
    {
      enabled: ['files', 'editor', 'preview', 'tabs'],
      manifests: [
        manifest('files', { provides: { 'test.files': '1.0' } }),
        manifest('editor', { requires: { 'test.files': '^1' }, provides: { 'test.tab': '1.0' } }),
        manifest('preview', { requires: { 'test.tab': '^1' } }),
        manifest('tabs', { optional: { 'test.files': '^1' } }),
      ],
      hosts: { f: ['files'], ui: ['editor', 'preview', 'tabs'] },
      bundled: ['files', 'editor', 'preview', 'tabs'],
    },
  );
  const k = await start();
  const mark = k.journal.length;
  await k.disable('files');
  assert.deepEqual(lines(k.journal, mark), ['preview:unloaded:files', 'editor:unloaded:files', 'files:unloaded:files']);
  assert.deepEqual(k.active, ['tabs']);
  await settle();
  assert.equal(changes, 1);

  const states = pluginStatuses(k.journal).map((s) => `${s.id}:${s.state}:${s.revivable ? 'R' : '-'}`);
  assert.deepEqual(states, ['files:stopped:R', 'editor:stopped:-', 'preview:stopped:-', 'tabs:active:-']);

  await k.enable('files');
  assert.deepEqual(k.active, ['tabs', 'files', 'editor', 'preview']);
  await settle();
  assert.equal(changes, 2);
  assert.deepEqual(spawned, ['f', 'ui', 'f'], 'хост files погашен пустым и поднят заново, ui жил всё время');
  await k.unload();
});

test('disable: выключенного человеком enable соседа не поднимает', async () => {
  const { start } = kernel({ files, reader: idle }, {
    enabled: ['files', 'reader'],
    manifests: [manifest('files', { provides: { 'test.files': '1.0' } }), manifest('reader', { requires: { 'test.files': '^1' } })],
  });
  const k = await start();
  await k.disable('files');
  await k.enable('reader');
  assert.deepEqual(k.active, []);
  assert.equal(k.journal.at(-1)?.kind, 'skipped');
  await k.enable('files');
  assert.deepEqual(k.active, ['files', 'reader']);
  await assert.rejects(k.disable('nobody'), { code: 'Unavailable' });
  await k.unload();
});

test('сочетания клавиш: запись, платформа, нажатие', () => {
  assert.equal(normalizeKey('shift+cmdorctrl+k'), 'CmdOrCtrl+Shift+K');
  assert.equal(normalizeKey('Control+Option+Up'), 'Ctrl+Alt+Up');
  assert.equal(normalizeKey('F5'), 'F5');
  assert.equal(normalizeKey('K'), undefined, 'одиночная буква перехватила бы набор текста');
  assert.equal(normalizeKey('Ctrl+Ctrl+K'), undefined);
  assert.equal(normalizeKey('Hyper+K'), undefined);
  assert.equal(resolveKey('CmdOrCtrl+Shift+K', 'linux'), 'Ctrl+Shift+K');
  assert.equal(resolveKey('CmdOrCtrl+Shift+K', 'darwin'), 'Shift+Meta+K');
  assert.equal(keyOfInput({ key: 'K', control: true, alt: false, shift: true, meta: false }), 'Ctrl+Shift+K');
  assert.equal(keyOfInput({ key: '!', code: 'Digit1', control: true, alt: false, shift: true, meta: false }), 'Ctrl+Shift+1');
  assert.equal(keyOfInput({ key: 'Control', control: true, alt: false, shift: false, meta: false }), undefined);
});

test('манифест: сочетание - на свою команду без обязательных аргументов', () => {
  const problem = (fields: Record<string, unknown>) => {
    const r = parseManifest(manifest('pad', { commands: { 'pad.open': {}, 'pad.say': { args: ['string'] } }, ...fields }));
    return r.ok ? '' : r.errors.join('\n');
  };
  const ok = parseManifest(manifest('pad', { commands: { 'pad.open': {} }, keybindings: [{ key: 'ctrl+shift+o', command: 'pad.open' }] }));
  assert.deepEqual(ok.ok && ok.manifest.keybindings, [{ key: 'Ctrl+Shift+O', command: 'pad.open' }]);
  assert.match(problem({ keybindings: [{ key: 'O', command: 'pad.open' }] }), /не разобрано/);
  assert.match(problem({ keybindings: [{ key: 'F2', command: 'other.open' }] }), /не объявлена/);
  assert.match(problem({ keybindings: [{ key: 'F2', command: 'pad.say' }] }), /обязательные аргументы/);
  assert.match(problem({ keybindings: [{ key: 'F2', command: 'pad.open' }, { key: 'f2', command: 'pad.open' }] }), /повторяется/);
});

test('plugins.keybindings: выбор пользователя перекрывает манифесты, null отдаёт сочетание окну, неверное - в журнал', async () => {
  const pad = (id: string): PluginModule => ({ activate: (ctx) => ctx.commands.register(`${id}.go`, () => id) });
  const keyed = (id: string, key: string) => manifest(id, { commands: [`${id}.go`, `${id}.alt`], keybindings: [{ key, command: `${id}.go` }] });
  const { start } = kernel(
    { alpha: pad('alpha'), zeta: pad('zeta') },
    {
      enabled: ['alpha', 'zeta'],
      manifests: [keyed('alpha', 'Ctrl+K'), keyed('zeta', 'Ctrl+K'), keyed('beta', 'F5')],
      platform: 'linux',
      keybindings: [
        { key: 'cmdorctrl+k', command: 'zeta.go' },
        { key: 'F5', command: null },
        { key: 'F6', command: 'alpha.alt' },
        { key: 'K', command: 'alpha.go' },
        { key: 'F7', command: 'nobody.go' },
      ],
    },
  );
  const k = await start();
  assert.deepEqual(
    k.keybindings.map((b) => [b.key, b.command, b.user ?? false, b.shadowed.map((x) => x.command)]),
    [
      ['Ctrl+K', 'zeta.go', true, ['alpha.go']],
      ['F6', 'alpha.alt', true, []],
    ],
  );
  assert.equal(k.keybinding('F5'), undefined, 'освобождённое сочетание осталось у плагина');
  assert.deepEqual(
    k.journal.flatMap((e) => (e.kind === 'key-ignored' ? [`${e.key}:${e.reason}`] : [])),
    ['K:сочетание не разобрано', 'F7:команды нет ни у одного плагина'],
  );
  await k.unload();
});

test('конфликт сочетаний: встроенный побеждает сторонний, между равными - первый по id; нажатие идёт активному владельцу', async () => {
  const pad = (id: string): PluginModule => ({ activate: (ctx) => ctx.commands.register(`${id}.go`, () => id) });
  const keyed = (id: string, key: string) => manifest(id, { commands: [`${id}.go`], keybindings: [{ key, command: `${id}.go` }] });
  const { start } = kernel(
    { zeta: pad('zeta'), alpha: pad('alpha'), mallory: pad('mallory') },
    {
      enabled: ['zeta', 'alpha', 'mallory'],
      manifests: [keyed('mallory', 'CmdOrCtrl+K'), keyed('zeta', 'Ctrl+K'), keyed('alpha', 'CmdOrCtrl+K')],
      bundled: ['zeta', 'alpha'],
      platform: 'linux',
    },
  );
  const k = await start();
  const conflicts = k.journal.flatMap((e) => (e.kind === 'key-conflict' ? [`${e.pluginId}->${e.winner}`] : []));
  assert.deepEqual(conflicts, ['zeta->alpha', 'mallory->alpha']);
  assert.deepEqual(k.keybindings, [{ key: 'Ctrl+K', command: 'alpha.go', pluginId: 'alpha', shadowed: [{ pluginId: 'zeta', command: 'zeta.go' }, { pluginId: 'mallory', command: 'mallory.go' }] }]);
  assert.equal(k.keybinding('Ctrl+K')?.command, 'alpha.go');
  assert.deepEqual(
    pluginStatuses(k.journal).map((s) => s.state),
    ['active', 'active', 'active'],
    'конфликт сочетаний плагин не выключает',
  );
  await k.disable('alpha');
  assert.equal(k.keybinding('Ctrl+K'), undefined, 'выгруженный владелец нажатие не получает');
  await k.unload();
});
