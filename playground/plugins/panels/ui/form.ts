// Вид panels: модальное окно (area "modal"). Ядро показывает его слоем окна по просьбе главной части (`ctx.views.modal`);
// данные приходят в ctx.modal.data, результат уходит владельцу через ctx.modal.close, Escape закрывает окно без результата.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const modal = ctx.modal;
  if (!modal) {
    root.textContent = 'Вид form открывается только как модальное окно';
    return undefined;
  }
  const initial = typeof modal.data === 'object' && modal.data !== null ? (modal.data as { name?: unknown }).name : undefined;
  const label = Object.assign(document.createElement('label'), { textContent: 'Название ' });
  const name = Object.assign(document.createElement('input'), { id: 'name', value: typeof initial === 'string' ? initial : '' });
  label.append(name);
  const create = Object.assign(document.createElement('button'), { id: 'create', type: 'button', textContent: 'Создать' });
  const cancel = Object.assign(document.createElement('button'), { id: 'cancel', type: 'button', textContent: 'Отмена' });
  create.addEventListener('click', () => void modal.close({ name: name.value }).catch(() => undefined));
  cancel.addEventListener('click', () => void modal.close().catch(() => undefined));
  root.append(label, create, cancel);
  return {
    dispose() {
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
