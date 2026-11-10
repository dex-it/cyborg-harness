// Общая часть двух видов panels: подпись «плагин/вид», видимость и меню у своего фрейма.

import type { Disposable, UiContext } from '@cyborg-harness/contracts';

/** Подпись вида, счётчик смен видимости (свёртка соседнего вида его не меняет) и кнопка меню: меню встаёт у фрейма этого вида. */
export function mountPanel(root: HTMLElement, ctx: UiContext, label: string): Disposable {
  const text = document.createElement('p');
  text.id = 'which';
  text.textContent = `${ctx.pluginId}/${ctx.view}: ${label}`;
  const menu = Object.assign(document.createElement('button'), { type: 'button', id: 'menu', textContent: 'Меню' });
  const answer = Object.assign(document.createElement('output'), { id: 'answer', textContent: '-' });
  const visibility = Object.assign(document.createElement('output'), { id: 'visibility', textContent: 'показан' });
  root.append(text, menu, answer, visibility);
  menu.addEventListener('click', () => {
    // Точка меню - в координатах фрейма этого вида; окно прибавляет к ней положение фрейма именно этого вида.
    void ctx.dialogs.show({ kind: 'menu', at: { x: 4, y: 4 }, items: [{ id: 'copy', label: 'Копировать' }] }).then(
      (choice) => (answer.textContent = choice ?? 'отмена'),
      (error: unknown) => (answer.textContent = `отказ: ${error instanceof Error ? error.message : String(error)}`),
    );
  });
  const sub = ctx.onVisibilityChange((visible) => (visibility.textContent = visible ? 'показан' : 'скрыт'));
  return {
    dispose() {
      sub.dispose();
      root.replaceChildren();
    },
  };
}
