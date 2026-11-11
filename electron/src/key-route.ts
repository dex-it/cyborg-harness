// Решение по нажатию из `before-input-event` окна, без значений Electron: проверяется на Node (PL-03).
import type { KeyInput } from '@cyborg-harness/core';

/** Нажатие в той части `Electron.Input`, что нужна решению: кадр в нём не назван, и от него решение не зависит. */
export interface RoutedInput extends KeyInput {
  readonly type: string;
  readonly isAutoRepeat: boolean;
}

/** Что решению нужно от службы плагинов (`PluginsService`). */
export interface KeyRouter {
  dismissModal(): boolean;
  press(input: KeyInput, repeat?: boolean): boolean;
}

/**
 * `true` - нажатие забрало ядро, странице его отдавать не надо (`preventDefault`).
 * Ядро видит нажатие в главном процессе до страницы: сочетание срабатывает одинаково из каркаса и из `<iframe>` любого origin (SAD 3.9).
 * Escape закрывает модальное окно плагина, где бы ни стоял фокус; диалог поверх окна забирает Escape себе.
 */
export function routeInput(plugins: KeyRouter, input: RoutedInput): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'Escape' && plugins.dismissModal()) return true;
  return plugins.press(input, input.isAutoRepeat);
}
