import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startKernel } from '@cyborg-harness/testing';
import { waitFor } from '../../core/test/wait-for.ts';

// Пилот PL-08: настоящие манифесты плагинов раскладки Cyborg (sessions и заглушки stub-*) через ядро. Таблица «область Cyborg - плагин - вид - kind - order»
// из docs/05-verification/pl08-window-layout.md проверяется здесь по снимку `Kernel.layout`, а не пересказывается.
const PLUGINS = path.join(import.meta.dirname, '..', 'plugins');
const SHELL = ['sessions', 'stub-files', 'stub-sessions', 'stub-tracker', 'stub-commands'];
const dirs = (ids: readonly string[]) => ids.map((id) => path.join(PLUGINS, id));

test('раскладка Cyborg: пять областей на пилотных видах, порядок задаёт order манифестов', async () => {
  await using k = await startKernel({ plugins: dirs(SHELL) });
  const where = (area: string) =>
    k.layout
      .filter((e) => e.area === area)
      .map((e) => `${e.pluginId}/${e.name}:${String(e.order)}${e.title === undefined ? '' : `:${e.title}`}`);
  // Боковая панель с вкладками «Файлы/Сессии».
  assert.deepEqual(where('sidebar'), ['stub-files/tree:100:Файлы', 'stub-sessions/list:200:Сессии']);
  // Панель инструментов основной области.
  assert.deepEqual(where('toolbar'), ['stub-tracker/status:100:Статус', 'stub-tracker/tasks:200:Задачи', 'stub-tracker/mrs:300:MR/PR', 'stub-sessions/new:400:Новая сессия']);
  // Основная область: терминал сессии (документы-вкладки образуют полосу сессий) и под ним полоса кнопок.
  assert.deepEqual(where('main'), ['sessions/main:100', 'sessions/session:100', 'stub-commands/strip:200:Кнопки команд']);
  // Выезжающая панель.
  assert.deepEqual(where('popup'), ['stub-tracker/task-panel:100:Панель задач']);
  assert.deepEqual(k.layout.filter((e) => e.mark !== undefined), [], 'в здоровом ядре ни у одного вида нет метки');
});

test('выгрузка плагина оставляет его вид в той же области с меткой disabled: окно ставит заглушку на место', async () => {
  await using k = await startKernel({ plugins: dirs(SHELL) });
  await k.disable('stub-tracker');
  const marked = k.layout.filter((e) => e.pluginId === 'stub-tracker');
  assert.deepEqual(marked.map((e) => [e.name, e.area, e.order, e.mark]), [
    ['status', 'toolbar', 100, 'disabled'],
    ['task-panel', 'popup', 100, 'disabled'],
    ['tasks', 'toolbar', 200, 'disabled'],
    ['mrs', 'toolbar', 300, 'disabled'],
  ]);
  assert.equal(k.layout.find((e) => e.pluginId === 'stub-files')?.mark, undefined, 'соседи не задеты');
});

// Вклады в меню окна (K-08) на пилотных плагинах: пункты приходят от плагинов, enabled и checked идут за их состоянием.
const MENU = ['stub-files', 'stub-tracker', 'stub-project'];
const brief = (k: { menus: readonly { pluginId: string; id: string; enabled: boolean; checked?: boolean; mark?: string }[] }) =>
  k.menus.map((e) => `${e.pluginId}/${e.id}:${e.enabled ? 'on' : 'off'}${e.checked === undefined ? '' : e.checked ? '+' : '-'}${e.mark ? `[${e.mark}]` : ''}`);

test('меню окна: четыре пункта от трёх плагинов, enabled и checked идут за состоянием плагинов, нажатие выполняет команду плагина', async () => {
  const sent: { pluginId: string; view: string; message: unknown }[] = [];
  await using k = await startKernel({ plugins: dirs(MENU), load: { onViewMessage: (pluginId, view, message) => void sent.push({ pluginId, view, message }) } });
  // Порядок: меню из закрытого списка (workspace, view, tools), затем order.
  assert.deepEqual(
    k.menus.map((e) => `${e.menu}:${String(e.order)}:${e.title}`),
    ['workspace:100:Свойства проекта', 'view:100:Уведомления', 'view:200:Поиск', 'tools:300:Расширения'],
  );
  assert.equal(k.menus.find((e) => e.id === 'search')?.accelerator, 'CmdOrCtrl+Shift+F');
  // Проект не выбран: «Свойства проекта» и «Поиск» недоступны, уведомления включены, «Расширения» доступны, пока работает плагин.
  assert.deepEqual(brief(k), ['stub-project/properties:off', 'stub-project/notifications:on+', 'stub-files/search:off', 'stub-tracker/extensions:on']);

  // Ядро перечитывает источники само после команды, приложение ничего не просит: снимок догоняет состояние плагина.
  await k.run('stub-project.next');
  await waitFor('выбранный проект включил пункты двух плагинов', () => brief(k).join() === ['stub-project/properties:on', 'stub-project/notifications:on+', 'stub-files/search:on', 'stub-tracker/extensions:on'].join());

  // Нажатие пункта - команда плагина-вкладчика: «Поиск» будит главную часть stub-files, та шлёт толчок своему виду.
  await k.runMenuItem('stub-files', 'search');
  assert.deepEqual(sent, [{ pluginId: 'stub-files', view: 'tree', message: { search: 1 } }]);

  await k.runMenuItem('stub-project', 'notifications');
  await waitFor('галочка пошла за состоянием плагина', () => k.menus.find((e) => e.id === 'notifications')?.checked === false);
  await k.runMenuItem('stub-project', 'notifications');
  await waitFor('галочка вернулась', () => k.menus.find((e) => e.id === 'notifications')?.checked === true);

  // Владелец состояния выгружен: пункты остаются, недоступны, у пунктов самого плагина метка.
  await k.disable('stub-project');
  // Пункты выгруженного плагина остаются в снимке недоступными, с меткой; соседи, которых выгрузка не касалась, на месте.
  await waitFor('пункты выгруженного плагина недоступны, но не убраны', () => brief(k).slice(0, 2).join() === ['stub-project/properties:off[disabled]', 'stub-project/notifications:off-[disabled]'].join());
  assert.equal(brief(k).at(-1), 'stub-tracker/extensions:on');
  // Пункт зависимого плагина читает состояние выгруженного владельца: после перечитывания он недоступен до возвращения владельца.
  await k.refreshMenus();
  assert.equal(brief(k).find((e) => e.startsWith('stub-files/')), 'stub-files/search:off');
  await k.enable('stub-project');
  await k.run('stub-project.next');
  await waitFor('владелец вернулся и выбрал проект - пункты снова доступны', () => brief(k).filter((e) => e.endsWith(':on') || e.endsWith(':on+')).length === 4);
});

test('меню: пункт не из снимка - NotFound, команда пункта чужим плагином не запускается', async () => {
  await using k = await startKernel({ plugins: dirs(MENU) });
  await assert.rejects(k.runMenuItem('stub-files', 'nope'), { code: 'NotFound' });
  await assert.rejects(k.runMenuItem('stub-sessions', 'search'), { code: 'NotFound' });
});

test('заголовок окна: воркспейс, название проекта от плагина, приложение; смена проекта обновляет строку, выгрузка плагина снимает фрагмент', async () => {
  const titles: string[] = [];
  await using k = await startKernel({
    plugins: dirs(['stub-project']),
    load: { windowTitle: { workspace: 'team.cyborg.json', app: 'Cyborg Playground' }, onWindow: (snapshot) => void titles.push(snapshot.title) },
  });
  assert.equal(k.window.title, 'team.cyborg.json - Cyborg Playground');
  await k.run('stub-project.next');
  assert.equal(k.window.title, 'team.cyborg.json - Альфа - Cyborg Playground');
  await k.run('stub-project.next');
  assert.equal(k.window.title, 'team.cyborg.json - Бета - Cyborg Playground');
  await k.run('stub-project.next');
  assert.equal(k.window.title, 'team.cyborg.json - Cyborg Playground', 'проект снят - фрагмента нет');
  await k.run('stub-project.next');
  await k.disable('stub-project');
  assert.equal(k.window.title, 'team.cyborg.json - Cyborg Playground', 'выгрузка плагина снимает его фрагмент');
  assert.equal(titles.at(-1), k.window.title, 'приложение получает ту же строку');
  assert.ok(titles.includes('team.cyborg.json - Бета - Cyborg Playground'), 'каждая смена проекта дошла до приложения');
});
