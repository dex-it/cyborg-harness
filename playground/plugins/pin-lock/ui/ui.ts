// Вид pin-lock: кнопка замка с сочетанием из ctx.keys и примеры диалогов слоя окна.

import type { Disposable, UiContext, UiModule } from '@cyborg/contracts';

function button(id: string, text: string): HTMLButtonElement {
  return Object.assign(document.createElement('button'), { type: 'button', id, textContent: text });
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const key = ctx.keys.of('pin-lock.lock');
  const lock = button('lock', key === undefined ? 'Заблокировать' : `Заблокировать (${key})`);
  const ask = button('ask', 'Спросить');
  const menu = button('menu', 'Меню');
  const answer = Object.assign(document.createElement('output'), { id: 'answer', textContent: '-' });
  root.append(lock, ask, menu, answer);

  const shown = (choice: string | undefined) => (answer.textContent = choice ?? 'отмена');
  const failed = (error: unknown) => (answer.textContent = `отказ: ${error instanceof Error ? error.message : String(error)}`);
  lock.addEventListener('click', () => void ctx.commands.run('pin-lock.lock').catch(failed));
  ask.addEventListener('click', () => {
    void ctx.dialogs
      .show({ kind: 'ask', title: 'Закрыть окно?', message: 'Откроет его PIN 0000.', buttons: [{ id: 'yes', label: 'Закрыть' }, { id: 'no', label: 'Нет' }] })
      .then(shown, failed);
  });
  menu.addEventListener('click', () => {
    const r = menu.getBoundingClientRect();
    void ctx.dialogs
      .show({ kind: 'menu', at: { x: r.left, y: r.bottom }, items: [{ id: 'copy', label: 'Копировать' }, { id: 'paste', label: 'Вставить' }] })
      .then(shown, failed);
  });
  return { dispose: () => root.replaceChildren() };
}

mount satisfies UiModule<HTMLElement>['mount'];
