import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuEntry } from '@cyborg-harness/core';
import { acceleratorsOf, appMenuTemplate, type AppMenuItem } from '../src/app-menu-template.ts';

// K-08: меню ОС собирается из снимка ядра; Electron для этого не нужен, шаблон - данные.
const entry = (over: Partial<MenuEntry> & Pick<MenuEntry, 'pluginId' | 'id' | 'menu'>): MenuEntry => ({ title: over.id, command: `${over.pluginId}.run`, order: 1000, enabled: true, ...over });
const base: AppMenuItem[] = [
  { label: 'Воркспейс', menu: 'workspace', submenu: [{ role: 'quit' }] },
  { role: 'editMenu' },
  { label: 'Вид', menu: 'view', submenu: [] },
];
const labels = (items: readonly { label?: string | undefined; type?: string | undefined }[] | undefined) => (items ?? []).map((i) => i.label ?? i.type ?? '?');
const sub = (template: ReturnType<typeof appMenuTemplate>, label: string) => {
  const found = template.find((t) => t.label === label);
  return Array.isArray(found?.submenu) ? found.submenu : [];
};

test('меню ОС: пункты плагинов встают в меню приложения после его пунктов, через разделитель, по порядку снимка', () => {
  const template = appMenuTemplate(base, [entry({ pluginId: 'a', id: 'one', menu: 'workspace', title: 'Один' }), entry({ pluginId: 'b', id: 'two', menu: 'workspace', title: 'Два' }), entry({ pluginId: 'a', id: 'view', menu: 'view', title: 'Вид плагина' })], () => undefined);
  assert.deepEqual(labels(sub(template, 'Воркспейс')), ['?', 'separator', 'Один', 'Два']);
  assert.deepEqual(labels(sub(template, 'Вид')), ['Вид плагина'], 'у меню без своих пунктов разделителя нет');
  assert.equal(template[1]?.role, 'editMenu', 'меню без тега остаётся как есть');
  assert.equal(JSON.stringify(template).includes('"menu"'), false, 'тег меню в шаблон ОС не попадает');
});

test('меню ОС: enabled, галочка и сочетание пункта - из снимка; нажатие зовёт обработчик с пунктом', () => {
  const pressed: string[] = [];
  const template = appMenuTemplate(
    base,
    [
      entry({ pluginId: 'a', id: 'plain', menu: 'view', enabled: false, mark: 'disabled' }),
      entry({ pluginId: 'a', id: 'tick', menu: 'view', checked: true, accelerator: 'CmdOrCtrl+Shift+F' }),
      entry({ pluginId: 'a', id: 'free', menu: 'view', checked: false }),
    ],
    (e) => void pressed.push(`${e.pluginId}/${e.id}`),
  );
  const [plain, tick, free] = sub(template, 'Вид');
  assert.deepEqual([plain?.enabled, plain?.type, plain?.checked, plain?.accelerator], [false, undefined, undefined, undefined], 'недоступный пункт на месте, без галочки и сочетания');
  assert.deepEqual([tick?.enabled, tick?.type, tick?.checked, tick?.accelerator], [true, 'checkbox', true, 'CmdOrCtrl+Shift+F']);
  assert.deepEqual([free?.type, free?.checked, free?.accelerator], ['checkbox', false, undefined], 'сочетание, которого нет в снимке, меню ОС не получает');
  tick?.click?.(undefined as never, undefined, undefined as never);
  assert.deepEqual(pressed, ['a/tick']);
});

test('меню ОС: вклад в меню, которого нет у приложения, добавляется в конец с подписью ядра, а не пропадает', () => {
  const template = appMenuTemplate(base, [entry({ pluginId: 'a', id: 'tool', menu: 'tools', title: 'Поиск' }), entry({ pluginId: 'a', id: 'win', menu: 'window', title: 'Окно плагина' })], () => undefined);
  assert.deepEqual(template.slice(3).map((t) => t.label), ['Инструменты', 'Окно']);
  assert.deepEqual(labels(sub(template, 'Инструменты')), ['Поиск']);
  assert.deepEqual(appMenuTemplate(base, [], () => undefined).length, 3, 'без вкладов меню приложения не растёт');
});

// PL-03: акселераторы меню приложения идут в единый реестр ядра (`LoadOptions.menuKeys`) из настоящего меню, а не из списка, который ведут руками (D-27).
interface Node {
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string | null;
  submenu?: { items: Node[] };
}
const menu = (items: Node[]): { items: Node[] } => ({ items });

test('акселераторы меню: обход собирает путь -> сочетание, включая сочетания ролей, и пропускает разделители и пункты без сочетания', () => {
  const items: Node[] = [
    { label: 'Electron', role: 'appmenu', submenu: menu([{ label: 'Hide Electron', role: 'hide', accelerator: 'Command+H' }, { type: 'separator' }, { label: 'Quit Electron', role: 'quit', accelerator: 'CommandOrControl+Q' }]) },
    { label: 'Edit', role: 'editmenu', submenu: menu([{ label: 'Copy', role: 'copy', accelerator: 'CommandOrControl+C' }, { label: 'Delete', role: 'delete', accelerator: null }, { submenu: menu([{ role: 'togglesmartquotes' }]) }]) },
    { label: 'Вид', submenu: menu([{ role: 'toggledevtools', accelerator: 'Alt+Command+I' }]) },
  ];
  assert.deepEqual(acceleratorsOf(items), {
    'Electron/Hide Electron': 'Command+H',
    'Electron/Quit Electron': 'CommandOrControl+Q',
    'Edit/Copy': 'CommandOrControl+C',
    'Вид/toggledevtools': 'Alt+Command+I',
  });
});

test('акселераторы меню: два пункта с одним путём не затирают друг друга', () => {
  const items: Node[] = [{ label: 'Файл', submenu: menu([{ label: 'Открыть', accelerator: 'CmdOrCtrl+O' }, { label: 'Открыть', accelerator: 'CmdOrCtrl+Shift+O' }]) }];
  assert.deepEqual(Object.values(acceleratorsOf(items)).toSorted(), ['CmdOrCtrl+O', 'CmdOrCtrl+Shift+O']);
});
