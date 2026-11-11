// Меню приложения: ставит меню ОС по снимку ядра и пересобирает его, когда снимок меняется (K-08, SAD 3.9).
import { Menu } from 'electron';
import { acceleratorsOf, appMenuTemplate, type AppMenuItem } from './app-menu-template.ts';
import type { PluginsService } from './plugins.ts';

/**
 * Ставит меню приложения и пересобирает его, когда меняется снимок ядра (`PluginsService.menus`). Нажатие пункта исполняет его команду через ядро.
 * Возвращает снятие подписки; меню ОС при снятии остаётся как есть.
 */
export function bindAppMenu(plugins: PluginsService, base: readonly AppMenuItem[]): () => void {
  let shown = '';
  const apply = (): void => {
    const entries = plugins.menus();
    // Набор пунктов в окне пересобирается на каждое изменение журнала; меню ОС трогаем, только когда изменился его вид.
    const key = JSON.stringify(entries);
    if (key === shown) return;
    shown = key;
    Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(base, entries, (e) => void plugins.runMenuItem(e.pluginId, e.id))));
  };
  const stop = plugins.watch(apply);
  apply();
  return stop;
}

/**
 * Настоящие акселераторы меню приложения для `StartOptions.menuKeys`: меню строится из тех же `base`, что видит ОС, поэтому роли (`copy`, `quit`, `togglefullscreen`) приходят с сочетаниями Electron.
 * Пункты плагинов сюда не входят: их сочетания ядро берёт из манифестов само.
 */
export function baseAccelerators(base: readonly AppMenuItem[]): Record<string, string> {
  return acceleratorsOf(Menu.buildFromTemplate(appMenuTemplate(base, [], () => undefined)).items);
}
