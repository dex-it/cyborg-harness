import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { forkHosts, load, MENU_OWNER, PLUGIN_API_VERSION, type JournalEntry } from '@cyborg-harness/core';
import manifest from '../plugins/keys-pilot/manifest.json' with { type: 'json' };

// PL-03: пилот единого реестра сочетаний. Плагин keys-pilot на настоящем хосте-процессе занимает сочетания кнопок Cyborg динамически (`ctx.keys.register`),
// приложение отдаёт акселераторы меню (`menuKeys`), ядро решает по `when` и по конфликтам. Нажатие настоящей клавиатурой в окне - `docs/05-verification/macos-check.md`.
const ENTRY = pathToFileURL(path.join(import.meta.dirname, '..', 'plugins', 'keys-pilot', 'index.ts')).href;

/** Акселераторы меню приложения (macOS): те, что кнопка Cyborg могла бы занять; ядро их не пускает. */
const MENU: Readonly<Record<string, string>> = {
  'Вид/Размер шрифта по умолчанию': 'CmdOrCtrl+0',
  'Поиск/Найти в файлах…': 'CmdOrCtrl+Shift+F',
  'Расширения/Магазины…': 'CmdOrCtrl+Shift+X',
  'Правка/Копировать': 'CommandOrControl+C',
  'Cyborg/Выход': 'CmdOrCtrl+Q',
};

async function start() {
  const journal: JournalEntry[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['keys-pilot'],
    manifests: [manifest],
    spawnHost: forkHosts({ silent: true }),
    entry: () => ENTRY,
    platform: 'darwin',
    menuKeys: MENU,
    onJournal: (entry) => journal.push(entry),
  });
  return { k, journal };
}

test('keys-pilot: кнопки F1-F4 и Cmd+Shift+N заняты динамически, занятое меню приложения - отказ CommandConflict, и всё это видно при загрузке', async () => {
  const { k, journal } = await start();
  try {
    assert.deepEqual(k.active, ['keys-pilot']);
    const report = (await k.run('keys-pilot.report')) as { presses: string[]; outcomes: Record<string, string> };
    assert.deepEqual(report.outcomes, {
      F1: 'active',
      F2: 'active',
      F3: 'active',
      F4: 'active',
      'CmdOrCtrl+Shift+N': 'active',
      'CmdOrCtrl+0': 'CommandConflict',
      'CmdOrCtrl+Shift+F': 'CommandConflict',
      'CmdOrCtrl+Shift+X': 'CommandConflict',
      'CmdOrCtrl+C': 'CommandConflict',
      'CmdOrCtrl+Q': 'CommandConflict',
    });
    const refused = journal.flatMap((e) => (e.kind === 'key-conflict' && e.winner === MENU_OWNER ? [e.key] : []));
    assert.deepEqual(refused.toSorted(), ['Meta+0', 'Meta+C', 'Meta+Q', 'Shift+Meta+F', 'Shift+Meta+X'].toSorted(), 'отказы записаны в журнал, победитель - меню');
    assert.deepEqual(
      k.keybindings.filter((b) => b.pluginId === 'keys-pilot').map((b) => b.key).toSorted(),
      ['F1', 'F2', 'F3', 'F4', 'Shift+Meta+N'].toSorted(),
    );
  } finally {
    await k.unload();
  }
});

test('keys-pilot: условия Cyborg - не при автоповторе, не в поле ввода (терминал можно), не при открытом диалоге; сработавшее сочетание выполняет команду плагина в его хосте', async () => {
  const { k } = await start();
  try {
    const at = (key: string, press?: Parameters<typeof k.keybinding>[1]) => k.keybinding(key, press);
    assert.equal(at('F1', { repeat: true }), undefined, 'автоповтор');
    assert.equal(at('F1', { focus: 'text' }), undefined, 'поле ввода');
    assert.equal(at('Shift+Meta+N', { focus: 'text' }), undefined, 'Cmd+Shift+N в поле ввода');
    assert.equal(at('F1', { focus: 'terminal' })?.pluginId, 'keys-pilot', 'терминал - не поле ввода');
    assert.equal(at('F1', { focus: 'other' })?.pluginId, 'keys-pilot');

    const dialog = k.showDialog('keys-pilot', 'main', { kind: 'ask', title: 'Вопрос', buttons: [{ id: 'ok', label: 'ok' }] });
    assert.equal(at('F1', {}), undefined, 'открыт диалог');
    const id = k.window.dialog?.id;
    assert.ok(id !== undefined);
    k.answerDialog(id, 'ok');
    await dialog;

    for (const key of ['F3', 'Shift+Meta+N']) {
      const binding = at(key, { focus: 'terminal' });
      assert.ok(binding, key);
      await k.run(binding.command, ...(binding.args ?? []));
    }
    const report = (await k.run('keys-pilot.report')) as { presses: string[] };
    assert.deepEqual(report.presses, ['F3', 'new-session']);
  } finally {
    await k.unload();
  }
});
