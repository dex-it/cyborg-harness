import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startKernel } from '@cyborg-harness/testing';

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
