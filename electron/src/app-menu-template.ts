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

/** Пункт построенного меню Electron в той части, что нужна обходу: `Menu.items` и `MenuItem` её удовлетворяют. */
export interface BuiltMenuItem {
  readonly label?: string | undefined;
  readonly role?: string | undefined;
  readonly accelerator?: string | null | undefined;
  readonly submenu?: { readonly items: readonly BuiltMenuItem[] } | null | undefined;
}

/**
 * Сочетания меню ОС: путь пункта (`Меню/Подменю/Пункт`, без подписи - роль) -> сочетание, в том числе то, что Electron дал роли сам (`copy` - `CommandOrControl+C`).
 * Это `LoadOptions.menuKeys` ядра: реестр знает настоящие акселераторы, а не список, который приложение ведёт руками (D-27). Чистая функция: меню строит `baseAccelerators`.
 */
export function acceleratorsOf(items: readonly BuiltMenuItem[]): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (list: readonly BuiltMenuItem[], path: string): void => {
    for (const item of list) {
      const name = item.label ?? item.role;
      const here = name === undefined ? path : path === '' ? name : `${path}/${name}`;
      if (typeof item.accelerator === 'string' && name !== undefined) {
        let key = here;
        // Два пункта с одним именем - два сочетания, а не одно затёртое.
        for (let n = 2; Object.hasOwn(found, key); n++) key = `${here}#${String(n)}`;
        found[key] = item.accelerator;
      }
      if (item.submenu) walk(item.submenu.items, here);
    }
  };
  walk(items, '');
  return found;
}
