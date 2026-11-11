import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type JournalEntry } from '../src/loader.ts';
import { normalizeKey, resolveKey } from '../src/keys.ts';
import type { PluginModule } from '../src/plugin.ts';
import { inlineHosts } from '../src/transports.ts';
import { MENU_OWNER } from '../src/window-layer.ts';

// PL-03, D-27: единый реестр ядра ловит те же конфликты, что ручной список `RESERVED_MAC` / `RESERVED_OTHER` Cyborg, и те, которых в списке нет.
// Сверено с ai-cyborg `src/main/commands.ts:79-80` и `src/main/menu.ts` (коммит e112be0, 2026-11-11).

/** `RESERVED_MAC` и `RESERVED_OTHER` Cyborg дословно: запись canonical (ctrl, alt, shift, meta, code). */
const RESERVED_MAC = ['meta+KeyQ', 'meta+KeyC', 'meta+KeyV', 'meta+KeyX', 'meta+KeyA', 'meta+KeyZ', 'meta+KeyW', 'meta+KeyM', 'meta+KeyH', 'meta+Digit0', 'shift+meta+KeyN', 'shift+meta+KeyZ'];
const RESERVED_OTHER = ['ctrl+shift+KeyN', 'ctrl+shift+KeyC', 'ctrl+shift+KeyV', 'F11'];

/**
 * Меню Cyborg на macOS, как его строит Electron 45.2 (`Menu.buildFromTemplate` по `menu.ts`, снято на macOS 27.2 2026-11-11, роли получили свои сочетания от Electron):
 * путь пункта -> сочетание. Пять с явным `accelerator` в `menu.ts`, остальное - роли.
 */
const CYBORG_MENU_MAC: Readonly<Record<string, string>> = {
  'Cyborg/Выход': 'CmdOrCtrl+Q',
  'Поиск/Найти файл…': 'Cmd+P',
  'Поиск/Найти в файлах…': 'CmdOrCtrl+Shift+F',
  'Поиск/Найти в изменениях…': 'CmdOrCtrl+Shift+D',
  'Расширения/Магазины…': 'CmdOrCtrl+Shift+X',
  'Cyborg/Скрыть Cyborg': 'Command+H',
  'Cyborg/Скрыть остальные': 'Command+Alt+H',
  'Правка/Отменить': 'CommandOrControl+Z',
  'Правка/Повторить': 'Shift+CommandOrControl+Z',
  'Правка/Вырезать': 'CommandOrControl+X',
  'Правка/Копировать': 'CommandOrControl+C',
  'Правка/Вставить': 'CommandOrControl+V',
  'Правка/Выделить всё': 'CommandOrControl+A',
  'Вид/Инструменты разработчика': 'Alt+Command+I',
  'Вид/Во весь экран': 'Control+Command+F',
  'Окно/Свернуть': 'CommandOrControl+M',
  'Окно/Закрыть окно': 'CommandOrControl+W',
};
/** Сочетания, которые у Cyborg живут только в слушателе `keydown` окна (`app.ts:1263-1273`): решение PL-03 - приложение объявляет их пунктами меню, и они попадают в реестр. */
const WINDOW_ONLY: Readonly<Record<string, string>> = { 'Окно/Новая сессия': 'CmdOrCtrl+Shift+N', 'Вид/Размер шрифта по умолчанию': 'CmdOrCtrl+0' };
/** Linux: меню строится без роли appMenu; `Файл/Выход` и поиск с Shift, `Вид/Во весь экран` - роль с `F11` (по документации роли Electron: на Linux меню не строилось). */
const CYBORG_MENU_OTHER: Readonly<Record<string, string>> = {
  'Файл/Выход': 'CmdOrCtrl+Q',
  'Файл/Закрыть окно': 'CommandOrControl+W',
  'Поиск/Найти файл…': 'Ctrl+Shift+P',
  'Поиск/Найти в файлах…': 'CmdOrCtrl+Shift+F',
  'Вид/Во весь экран': 'F11',
  'Окно/Новая сессия': 'CmdOrCtrl+Shift+N',
};

/** Запись canonical Cyborg (`shift+meta+KeyN`) -> запись реестра ядра (`Shift+Meta+N`). */
function inRegistryForm(canonical: string): string {
  const parts = canonical.split('+');
  const code = parts.pop() ?? '';
  const key = /^(?:Key|Digit)(.)$/.exec(code)?.[1] ?? code;
  const names: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  const mods = parts.map((m) => names[m] ?? m);
  const normalized = normalizeKey([...mods, key].join('+'));
  assert.ok(normalized !== undefined, `${canonical}: ядро не разбирает запись`);
  return resolveKey(normalized, 'linux');
}

async function startWith(platform: string, menuKeys: Record<string, string>) {
  let ctx: PluginContext | undefined;
  const mod: PluginModule = {
    activate(c) {
      ctx = c;
      c.commands.register('buttons.press', () => undefined);
    },
  };
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['buttons'],
    manifests: [{ id: 'buttons', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'buttons.press': { args: ['string'] } } }],
    spawnHost: inlineHosts(async () => mod),
    platform,
    menuKeys,
  });
  const keys = ctx?.keys;
  assert.ok(keys, 'плагин не активирован');
  return { k, keys };
}

const conflictsOf = (journal: readonly JournalEntry[]) => journal.flatMap((e) => (e.kind === 'key-conflict' ? [e.key] : []));

test('реестр ловит всё из RESERVED_MAC Cyborg: меню владеет сочетанием, кнопка получает CommandConflict с записью в журнале', async () => {
  const { k, keys } = await startWith('darwin', { ...CYBORG_MENU_MAC, ...WINDOW_ONLY });
  const caught: string[] = [];
  for (const reserved of RESERVED_MAC) {
    // На macOS реестр читает `CmdOrCtrl` как Meta: запись canonical (`meta+KeyQ`) та же, что нажатие.
    const key = inRegistryForm(reserved);
    assert.equal(k.keybinding(key)?.pluginId, MENU_OWNER, `${reserved} (${key}): реестр не знает сочетания`);
    await assert.rejects(keys.register({ key, command: 'buttons.press', args: [reserved] }), { code: 'CommandConflict' }, reserved);
    caught.push(key);
  }
  assert.equal(caught.length, RESERVED_MAC.length);
  assert.deepEqual(conflictsOf(k.journal).toSorted(), caught.toSorted(), 'каждый отказ кнопке записан в журнал с победителем-меню');
  await k.unload();
});

test('D-27: реестр ловит и акселераторы меню Cyborg, которых нет в RESERVED_MAC - поиск, «Расширения», скрытие, инструменты разработчика', async () => {
  const { k, keys } = await startWith('darwin', { ...CYBORG_MENU_MAC, ...WINDOW_ONLY });
  const listed = new Set(RESERVED_MAC.map(inRegistryForm));
  const missed = [...Object.values(CYBORG_MENU_MAC), ...Object.values(WINDOW_ONLY)].map((raw) => resolveKey(normalizeKey(raw) ?? raw, 'darwin')).filter((key) => !listed.has(key));
  // Cmd+P, Shift+Cmd+F, Shift+Cmd+D, Shift+Cmd+X, Opt+Cmd+H, Opt+Cmd+I, Ctrl+Cmd+F - кнопка с таким сочетанием у Cyborg молча не срабатывает.
  assert.deepEqual(missed.toSorted(), ['Alt+Meta+H', 'Alt+Meta+I', 'Ctrl+Meta+F', 'Meta+P', 'Shift+Meta+D', 'Shift+Meta+F', 'Shift+Meta+X'].toSorted(), 'список ручной не полон: меню занимает больше');
  for (const key of missed) {
    assert.equal(k.keybinding(key)?.pluginId, MENU_OWNER, key);
    await assert.rejects(keys.register({ key, command: 'buttons.press', args: [key] }), { code: 'CommandConflict' }, key);
  }
  await k.unload();
});

test('RESERVED_OTHER на Linux: Ctrl+Shift+N и F11 реестр ловит по объявленному приложением меню; Ctrl+Shift+C и Ctrl+Shift+V - клавиши терминала, а не меню', async () => {
  const { k, keys } = await startWith('linux', CYBORG_MENU_OTHER);
  const bySource = new Map(RESERVED_OTHER.map((r) => [r, k.keybinding(inRegistryForm(r))?.pluginId]));
  assert.deepEqual([...bySource], [
    ['ctrl+shift+KeyN', MENU_OWNER],
    ['ctrl+shift+KeyC', undefined],
    ['ctrl+shift+KeyV', undefined],
    ['F11', MENU_OWNER],
  ]);
  await assert.rejects(keys.register({ key: 'Ctrl+Shift+N', command: 'buttons.press', args: ['n'] }), { code: 'CommandConflict' });
  await assert.rejects(keys.register({ key: 'F11', command: 'buttons.press', args: ['f'] }), { code: 'CommandConflict' });
  // Остаток, о котором ядро знать не может: копирование и вставку в терминале ведёт xterm, ядру их никто не объявлял.
  assert.equal((await keys.register({ key: 'Ctrl+Shift+C', command: 'buttons.press', args: ['c'] })).active, true);
  await k.unload();
});
