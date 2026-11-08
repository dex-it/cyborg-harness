import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
import type { KeyRegistration, PluginContext } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type JournalEntry, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts } from '../src/transports.ts';
import { MENU_OWNER, WINDOW_OWNER } from '../src/window-layer.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

/** Плагин, который отдаёт тесту свой `ctx`: регистрации клавиш делает тест, когда ему нужно. */
function harness(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost'>) {
  const ctxs = new Map<string, PluginContext>();
  const modules = Object.fromEntries(
    Object.entries(table).map(([id, mod]) => [
      id,
      {
        ...mod,
        activate(ctx: PluginContext) {
          ctxs.set(id, ctx);
          return mod.activate(ctx);
        },
      },
    ]),
  );
  const start = () =>
    load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async (entry) => {
        const mod = modules[entry];
        if (!mod) throw new Error(`нет модуля ${entry}`);
        return mod;
      }),
      platform: 'linux',
      ...options,
    });
  const keys = (id: string) => {
    const ctx = ctxs.get(id);
    if (!ctx) throw new Error(`${id} не активирован`);
    return ctx.keys;
  };
  return { start, keys };
}

/** Уведомление хоста о снятии (`notify`) доходит до ядра не мгновенно. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick();
};

const idle: PluginModule = { activate: () => undefined };
const buttons = manifest('buttons', {
  commands: { 'buttons.press': { args: ['string'] }, 'buttons.plain': {} },
  ui: { views: { main: './ui.js' } },
});
const conflicts = (journal: readonly JournalEntry[]) => journal.flatMap((e) => (e.kind === 'key-conflict' ? [`${e.pluginId}:${e.key}->${e.winner}`] : []));

test('ctx.keys.register: сочетание с аргументом команды попадает в таблицу, нажатие отдаёт команду и аргументы', async () => {
  const { start, keys } = harness({ buttons: idle }, { enabled: ['buttons'], manifests: [buttons] });
  const k = await start();
  const reg = await keys('buttons').register({ key: 'ctrl+shift+1', command: 'buttons.press', args: ['build'] });
  assert.equal(reg.active, true);
  assert.deepEqual(k.keybinding('Ctrl+Shift+1'), { key: 'Ctrl+Shift+1', command: 'buttons.press', pluginId: 'buttons', args: ['build'], dynamic: true, shadowed: [] });
  assert.deepEqual(
    k.keybindings.filter((b) => b.pluginId !== WINDOW_OWNER).map((b) => [b.key, b.command, b.dynamic ?? false]),
    [['Ctrl+Shift+1', 'buttons.press', true]],
    'динамическое сочетание видно в общем списке',
  );
  reg.dispose();
  await settle();
  assert.equal(k.keybinding('Ctrl+Shift+1'), undefined, 'снятая регистрация не ловится');
  assert.equal((await keys('buttons').register({ key: 'Ctrl+Shift+1', command: 'buttons.plain' })).active, true, 'сочетание свободно');
  await k.unload();
});

test('ctx.keys.register: CmdOrCtrl разворачивается под платформу', async () => {
  const { start, keys } = harness({ buttons: idle }, { enabled: ['buttons'], manifests: [buttons], platform: 'darwin' });
  const k = await start();
  await keys('buttons').register({ key: 'CmdOrCtrl+Shift+9', command: 'buttons.plain' });
  assert.equal(k.keybinding('Shift+Meta+9')?.command, 'buttons.plain');
  await k.unload();
});

test('ctx.keys.register: недоверенный вход - отказ с кодом, таблица не меняется', async () => {
  const { start, keys } = harness({ buttons: idle, other: idle }, { enabled: ['buttons', 'other'], manifests: [buttons, manifest('other', { commands: ['other.go'] })] });
  const k = await start();
  const bad = async (spec: unknown, code: string, what: string) => {
    await assert.rejects(keys('buttons').register(spec as never), { code }, what);
    assert.deepEqual(
      k.keybindings.filter((b) => b.pluginId !== WINDOW_OWNER),
      [],
      what,
    );
  };
  await bad({ key: 'K', command: 'buttons.plain' }, 'Invalid', 'одиночная буква перехватила бы набор текста');
  await bad({ key: 'F2', command: 'buttons.nothing' }, 'NotDeclared', 'команды нет в манифесте');
  await bad({ key: 'F2', command: 'other.go' }, 'NotDeclared', 'чужая команда');
  await bad({ key: 'F2', command: 'buttons.press' }, 'Invalid', 'обязательного аргумента нет');
  await bad({ key: 'F2', command: 'buttons.press', args: [1] }, 'Invalid', 'аргумент не того вида');
  await bad({ key: 'F2', command: 'buttons.plain', args: ['x'.repeat(5000)] }, 'Invalid', 'аргументы больше предела');
  await bad({ key: 'F2', command: 'buttons.plain', when: { focus: true } }, 'Invalid', 'незнакомое условие');
  await bad({ key: 'F2', command: 'buttons.plain', when: { repeat: 'yes' } }, 'Invalid', 'условие не того вида');
  await bad({ key: 'F2', command: 'buttons.plain', when: { input: 'maybe' } }, 'Invalid', 'input вне списка');
  await bad({ key: 'F2', command: 'buttons.plain', when: 5 }, 'Invalid', 'when не объект');
  await k.unload();
});

test('ctx.keys.register: условие visible у плагина без вида - Invalid, лимит регистраций на плагин', async () => {
  const noView = manifest('plain', { commands: ['plain.go'] });
  const { start, keys } = harness({ plain: idle }, { enabled: ['plain'], manifests: [noView] });
  const k = await start();
  await assert.rejects(keys('plain').register({ key: 'F2', command: 'plain.go', when: { visible: true } }), { code: 'Invalid' });
  for (const mod of ['Ctrl', 'Alt', 'Ctrl+Alt', 'Ctrl+Shift', 'Alt+Shift', 'Ctrl+Alt+Shift']) {
    for (let i = 1; i <= 24; i++) if (k.keybindings.length < 128 + 2) await keys('plain').register({ key: `${mod}+F${String(i)}`, command: 'plain.go' });
  }
  assert.equal(k.keybindings.filter((b) => b.dynamic).length, 128);
  await assert.rejects(keys('plain').register({ key: 'F2', command: 'plain.go' }), { code: 'Invalid', message: /не больше 128/ });
  await k.unload();
});

test('конфликт динамического с манифестным: манифестный побеждает, запись key-conflict, проигравший назван в shadowed', async () => {
  const pad = manifest('pad', { commands: ['pad.open'], keybindings: [{ key: 'Ctrl+K', command: 'pad.open' }] });
  const { start, keys } = harness({ pad: idle, buttons: idle }, { enabled: ['pad', 'buttons'], manifests: [pad, buttons] });
  const k = await start();
  const reg = await keys('buttons').register({ key: 'ctrl+k', command: 'buttons.plain' });
  assert.equal(reg.active, false);
  assert.equal(reg.winner, 'pad');
  assert.deepEqual(conflicts(k.journal), ['buttons:Ctrl+K->pad']);
  assert.deepEqual(k.journal.flatMap((e) => (e.kind === 'key-conflict' ? [e.command] : [])), ['buttons.plain']);
  assert.equal(k.keybinding('Ctrl+K')?.pluginId, 'pad');
  assert.deepEqual(k.keybinding('Ctrl+K')?.shadowed, [{ pluginId: 'buttons', command: 'buttons.plain' }]);
  reg.dispose();
  await settle();
  assert.deepEqual(k.keybinding('Ctrl+K')?.shadowed, [], 'снятая регистрация проигравшего уходит из shadowed');
  await k.unload();
});

test('победитель манифеста выгружен: сочетание не переходит к динамическому проигравшему', async () => {
  const pad = manifest('pad', { commands: ['pad.open'], keybindings: [{ key: 'Ctrl+K', command: 'pad.open' }] });
  const { start, keys } = harness({ pad: idle, buttons: idle }, { enabled: ['pad', 'buttons'], manifests: [pad, buttons] });
  const k = await start();
  await keys('buttons').register({ key: 'Ctrl+K', command: 'buttons.plain' });
  await k.disable('pad');
  assert.equal(k.keybinding('Ctrl+K'), undefined, 'как у манифестных: идёт в окно');
  await k.unload();
});

test('сочетание пользователя сильнее динамического; освобождённое пользователем (null) динамическому доступно', async () => {
  const pad = manifest('pad', { commands: ['pad.open'], keybindings: [{ key: 'F5', command: 'pad.open' }] });
  const { start, keys } = harness(
    { pad: idle, buttons: idle },
    { enabled: ['pad', 'buttons'], manifests: [pad, buttons], keybindings: [{ key: 'F7', command: 'pad.open' }, { key: 'F5', command: null }] },
  );
  const k = await start();
  assert.equal((await keys('buttons').register({ key: 'F7', command: 'buttons.plain' })).winner, 'pad');
  assert.equal((await keys('buttons').register({ key: 'F5', command: 'buttons.plain' })).active, true);
  assert.equal(k.keybinding('F5')?.pluginId, 'buttons');
  assert.equal(k.keybinding('F7')?.pluginId, 'pad');
  await k.unload();
});

test('два динамических на одно сочетание: первый побеждает, второй назван в журнале', async () => {
  const other = manifest('other', { commands: ['other.go'] });
  const { start, keys } = harness({ buttons: idle, other: idle }, { enabled: ['buttons', 'other'], manifests: [buttons, other] });
  const k = await start();
  await keys('buttons').register({ key: 'F3', command: 'buttons.plain' });
  const second = await keys('other').register({ key: 'F3', command: 'other.go' });
  assert.deepEqual([second.active, second.winner], [false, 'buttons']);
  assert.deepEqual(conflicts(k.journal), ['other:F3->buttons']);
  assert.deepEqual(k.keybinding('F3')?.shadowed, [{ pluginId: 'other', command: 'other.go' }]);
  await k.unload();
});

test('сочетание команды окна динамически занять нельзя, и сочетание меню тоже: Invalid-отказ с названием владельца', async () => {
  const { start, keys } = harness({ buttons: idle }, { enabled: ['buttons'], manifests: [buttons], menuKeys: { 'menu.print': 'CmdOrCtrl+P', 'menu.broken': 'Hyper+Q' } });
  const k = await start();
  await assert.rejects(keys('buttons').register({ key: 'F6', command: 'buttons.plain' }), { code: 'CommandConflict', message: /cyborg\.window\.focus-next/ });
  await assert.rejects(keys('buttons').register({ key: 'shift+f6', command: 'buttons.plain' }), { code: 'CommandConflict' });
  await assert.rejects(keys('buttons').register({ key: 'Ctrl+P', command: 'buttons.plain' }), { code: 'CommandConflict', message: /menu\.print/ });
  assert.equal(k.keybinding('F6')?.pluginId, WINDOW_OWNER, 'окно по-прежнему владелец');
  assert.deepEqual(
    conflicts(k.journal),
    [],
    'отказ - исключение плагину, а не конфликт в журнале: занять нельзя вовсе',
  );
  assert.deepEqual(
    k.journal.flatMap((e) => (e.kind === 'key-ignored' ? [`${e.key}:${e.reason}`] : [])),
    ['Hyper+Q:сочетание меню не разобрано'],
  );
  await k.unload();
});

test('акселератор меню занят заранее: манифестное сочетание проигрывает меню с записью key-conflict, нажатие не перехватывается ядром', async () => {
  const pad = manifest('pad', { commands: ['pad.print'], keybindings: [{ key: 'CmdOrCtrl+P', command: 'pad.print' }] });
  const { start } = harness({ pad: idle }, { enabled: ['pad'], manifests: [pad], menuKeys: { 'menu.print': 'CmdOrCtrl+P' } });
  const k = await start();
  assert.deepEqual(conflicts(k.journal), ['pad:Ctrl+P->cyborg.menu']);
  assert.deepEqual(
    [k.keybinding('Ctrl+P')?.pluginId, k.keybinding('Ctrl+P')?.command, MENU_OWNER],
    ['cyborg.menu', 'menu.print', 'cyborg.menu'],
    'приложение видит владельца-меню и пропускает нажатие меню',
  );
  await k.unload();
});

test('выгрузка плагина снимает его динамические регистрации, остальные остаются', async () => {
  const other = manifest('other', { commands: ['other.go'] });
  const { start, keys } = harness({ buttons: idle, other: idle }, { enabled: ['buttons', 'other'], manifests: [buttons, other] });
  const k = await start();
  await keys('buttons').register({ key: 'F3', command: 'buttons.plain' });
  await keys('other').register({ key: 'F4', command: 'other.go' });
  await k.disable('buttons');
  assert.equal(k.keybinding('F3'), undefined);
  assert.equal(k.keybinding('F4')?.pluginId, 'other');
  assert.deepEqual(
    k.keybindings.filter((b) => b.pluginId !== WINDOW_OWNER).map((b) => b.key),
    ['F4'],
    'в общем списке выгруженного нет',
  );
  await k.enable('buttons');
  assert.equal(k.keybinding('F3'), undefined, 'регистрацию заново делает плагин, ядро её не помнит');
  assert.equal((await keys('buttons').register({ key: 'F3', command: 'buttons.plain' })).active, true);
  await k.unload();
});

test('откат активации: плагин зарегистрировал сочетание и упал - сочетания нет, ядро без хвоста', async () => {
  let registered: Promise<KeyRegistration> | undefined;
  const failing: PluginModule = {
    async activate(ctx) {
      registered = ctx.keys.register({ key: 'F3', command: 'buttons.plain' });
      await registered;
      throw new Error('не вышло');
    },
  };
  const { start } = harness({ buttons: failing }, { enabled: ['buttons'], manifests: [buttons] });
  const k = await start();
  await registered;
  assert.ok(k.journal.some((e) => e.kind === 'failed'), 'активация отклонена');
  assert.equal(k.keybinding('F3'), undefined);
  assert.deepEqual(k.keybindings.filter((b) => b.pluginId !== WINDOW_OWNER), []);
  await k.unload();
});

test('нажатие спящего (lazy) плагина: сочетание ждёт его пробуждения и не теряется после активации', async () => {
  const { start, keys } = harness({ buttons: idle }, { enabled: ['buttons'], manifests: [{ ...buttons, activation: 'lazy' }] });
  const k = await start();
  assert.equal(k.keybinding('F3'), undefined);
  await k.wake('buttons');
  await keys('buttons').register({ key: 'F3', command: 'buttons.plain' });
  assert.equal(k.keybinding('F3')?.pluginId, 'buttons');
  await k.unload();
});

test('when: по умолчанию не при автоповторе, не в поле ввода, не при открытом диалоге; поле условия снимает запрет', async () => {
  const { start, keys } = harness({ buttons: idle }, { enabled: ['buttons'], manifests: [buttons] });
  const k = await start();
  await keys('buttons').register({ key: 'F1', command: 'buttons.plain' });
  await keys('buttons').register({ key: 'F2', command: 'buttons.plain', when: { repeat: true } });
  await keys('buttons').register({ key: 'F3', command: 'buttons.plain', when: { input: 'any' } });
  await keys('buttons').register({ key: 'F4', command: 'buttons.plain', when: { dialog: true } });
  const at = (key: string, press?: Parameters<typeof k.keybinding>[1]) => k.keybinding(key, press)?.pluginId;

  assert.equal(at('F1', {}), 'buttons');
  assert.equal(at('F1', { repeat: true }), undefined, 'автоповтор');
  assert.equal(at('F2', { repeat: true }), 'buttons', 'repeat: true разрешает автоповтор');
  assert.equal(at('F1', { focus: 'text' }), undefined, 'поле ввода');
  assert.equal(at('F1', { focus: 'terminal' }), 'buttons', 'терминал - не поле ввода');
  assert.equal(at('F1', { focus: 'other' }), 'buttons');
  assert.equal(at('F3', { focus: 'text' }), 'buttons', 'input: any - и в поле ввода');
  assert.equal(at('F1'), 'buttons', 'без нажатия условия не проверяются: так спрашивает панель «Клавиши»');

  const dialog = k.showDialog('buttons', 'main', { kind: 'ask', title: 'Вопрос', buttons: [{ id: 'ok', label: 'ok' }] });
  assert.equal(at('F1', {}), undefined, 'открыт диалог');
  assert.equal(at('F4', {}), 'buttons', 'dialog: true разрешает при диалоге');
  const id = k.window.dialog?.id;
  assert.ok(id !== undefined);
  k.answerDialog(id, 'ok');
  await dialog;
  assert.equal(at('F1', {}), 'buttons', 'диалог закрыт');
  await k.unload();
});

test('when.visible: пока приложение не сказало, что вид виден, сочетание молчит; скрытый вид снова молчит', async () => {
  const { start, keys } = harness({ buttons: idle }, { enabled: ['buttons'], manifests: [buttons] });
  const k = await start();
  await keys('buttons').register({ key: 'F1', command: 'buttons.plain', when: { visible: true } });
  await keys('buttons').register({ key: 'F2', command: 'buttons.plain' });
  assert.equal(k.keybinding('F1', {}), undefined);
  k.setViewVisible('buttons', true);
  assert.equal(k.keybinding('F1', {})?.pluginId, 'buttons');
  assert.equal(k.keybinding('F2', {})?.pluginId, 'buttons', 'без visible видимость не требуется');
  k.setViewVisible('buttons', false);
  assert.equal(k.keybinding('F1', {}), undefined);
  assert.throws(() => k.setViewVisible('ghost', true), { code: 'Unavailable' });
  k.setViewVisible('buttons', true);
  await k.disable('buttons');
  await k.enable('buttons');
  await keys('buttons').register({ key: 'F1', command: 'buttons.plain', when: { visible: true } });
  assert.equal(k.keybinding('F1', {})?.pluginId, 'buttons', 'видимость - состояние окна, выгрузка плагина её не сбрасывает');
  await k.unload();
});

test('статические сочетания и команды окна автоповтор не получают, как раньше в приложении', async () => {
  const pad = manifest('pad', { commands: ['pad.open'], keybindings: [{ key: 'F5', command: 'pad.open' }] });
  const { start } = harness({ pad: idle }, { enabled: ['pad'], manifests: [pad] });
  const k = await start();
  assert.equal(k.keybinding('F5', { repeat: false })?.pluginId, 'pad');
  assert.equal(k.keybinding('F5', { repeat: true }), undefined);
  assert.equal(k.keybinding('F6', { repeat: true }), undefined);
  assert.equal(k.keybinding('F6', {})?.pluginId, WINDOW_OWNER);
  await k.unload();
});

test('замок окна: динамическое сочетание чужого плагина под замком не работает', async () => {
  const lock = manifest('lock', { commands: ['lock.go'], permissions: { 'ui.lock': true }, ui: { overlay: './lock.js' } });
  const locker: PluginModule = {
    activate(ctx) {
      ctx.commands.register('lock.go', async () => {
        await ctx.os.ui?.lock();
      });
      return undefined;
    },
  };
  const { start, keys } = harness({ buttons: idle, lock: locker }, { enabled: ['buttons', 'lock'], manifests: [buttons, lock] });
  const k = await start();
  await keys('buttons').register({ key: 'F3', command: 'buttons.plain' });
  assert.equal(k.keybinding('F3', {})?.pluginId, 'buttons');
  await k.run('lock.go');
  assert.equal(k.keybinding('F3', {}), undefined, 'под замком чужое молчит');
  await k.unload();
});
