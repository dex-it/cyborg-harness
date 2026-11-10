// Шаблон меню приложения по снимку ядра (K-08, SAD 3.9): ядро отдаёт пункты плагинов, приложение называет свои меню и пункты. Без значений Electron: проверяется на Node.
import type { MenuItemConstructorOptions } from 'electron';
import { MENU_NAMES, type MenuEntry, type MenuName } from '@cyborg-harness/core';

/** Верхнее меню приложения; с `menu` в него встают пункты плагинов (после пунктов приложения, через разделитель). */
export type AppMenuItem = MenuItemConstructorOptions & { readonly menu?: MenuName };

/** Подписи меню ядра, если приложение не завело такое само: вклад в меню, которого у приложения нет, не пропадает. */
const FALLBACK_LABELS: Readonly<Record<MenuName, string>> = { workspace: 'Воркспейс', view: 'Вид', tools: 'Инструменты', window: 'Окно' };

function pluginItem(entry: MenuEntry, run: (entry: MenuEntry) => void): MenuItemConstructorOptions {
  return {
    label: entry.title,
    enabled: entry.enabled,
    ...(entry.checked !== undefined && { type: 'checkbox' as const, checked: entry.checked }),
    // Сочетание, которое человек отдал другой команде или освободил, ядро из снимка убрало: у пункта меню ОС его нет.
    ...(entry.accelerator !== undefined && { accelerator: entry.accelerator }),
    click: () => run(entry),
  };
}

/**
 * Шаблон меню ОС: верхние меню приложения, в меню с тегом `menu` - пункты плагинов по порядку снимка. Меню ядра, которого в `base` нет, добавляется в конец.
 * Чистая функция: Electron нужен только `Menu.buildFromTemplate`, который зовёт `bindAppMenu`.
 */
export function appMenuTemplate(base: readonly AppMenuItem[], entries: readonly MenuEntry[], run: (entry: MenuEntry) => void): MenuItemConstructorOptions[] {
  const placed = new Set<MenuName>();
  const withPlugins = (menu: MenuName, own: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => {
    const mine = entries.filter((e) => e.menu === menu).map((e) => pluginItem(e, run));
    return mine.length === 0 ? [...own] : [...own, ...(own.length > 0 ? [{ type: 'separator' as const }] : []), ...mine];
  };
  const top = base.map((item): MenuItemConstructorOptions => {
    const { menu, ...rest } = item;
    if (menu === undefined) return rest;
    placed.add(menu);
    const submenu = Array.isArray(rest.submenu) ? rest.submenu : [];
    return { ...rest, submenu: withPlugins(menu, submenu) };
  });
  const extra = MENU_NAMES.filter((m) => !placed.has(m) && entries.some((e) => e.menu === m));
  return [...top, ...extra.map((menu): MenuItemConstructorOptions => ({ label: FALLBACK_LABELS[menu], submenu: withPlugins(menu, []) }))];
}
