// Вид panels: модальное окно (area "modal"). Ядро показывает его слоем окна по просьбе главной части (`ctx.views.modal`);
// данные приходят в ctx.modal.data, результат уходит владельцу через ctx.modal.close, Escape закрывает окно без результата.
// С `fit` вид сам просит окно подогнать высоту под содержимое (`ctx.modal.resize`): окно не видит содержимое чужого по origin фрейма.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const modal = ctx.modal;
  if (!modal) {
    root.textContent = 'Вид form открывается только как модальное окно';
    return undefined;
  }
  const data = typeof modal.data === 'object' && modal.data !== null ? (modal.data as { name?: unknown; ownEscape?: unknown; fit?: unknown }) : {};
  const initial = data.name;
  const label = Object.assign(document.createElement('label'), { textContent: 'Название ' });
  const name = Object.assign(document.createElement('input'), { id: 'name', value: typeof initial === 'string' ? initial : '' });
  label.append(name);
  const create = Object.assign(document.createElement('button'), { id: 'create', type: 'button', textContent: 'Создать' });
  const cancel = Object.assign(document.createElement('button'), { id: 'cancel', type: 'button', textContent: 'Отмена' });
  create.addEventListener('click', () => void modal.close({ name: name.value }).catch(() => undefined));
  cancel.addEventListener('click', () => void modal.close().catch(() => undefined));
  root.append(label, create, cancel);
  // Окно просило Escape себе (`escape: "view"`): нажатие доходит сюда, и вид сам решает, что оно значит; здесь - только отмечает его и окно не закрывает.
  const escaped = Object.assign(document.createElement('p'), { id: 'escaped' });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') escaped.textContent = 'Escape получил вид';
  };
  if (data.ownEscape === true) {
    document.addEventListener('keydown', onKey);
    root.append(escaped);
  }
  // Высота содержимого страницы: тело, а не `documentElement` (он не короче фрейма и после уменьшения окна не показал бы меньшую высоту), с полями тела.
  const contentHeight = () => {
    const style = getComputedStyle(document.body);
    return Math.ceil(document.body.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom));
  };
  // Режим «по содержимому» (#197): блок известной высоты, просьба окну ровно по нему; кнопки проверяют потолок окна и отказ ядра на неверной высоте.
  if (data.fit === true) {
    const box = Object.assign(document.createElement('div'), { id: 'fit-box' });
    const filler = Object.assign(document.createElement('div'), { id: 'filler' });
    filler.style.height = '240px';
    const fitted = Object.assign(document.createElement('p'), { id: 'fitted' });
    const failed = Object.assign(document.createElement('p'), { id: 'fit-error' });
    const ask = (id: string, text: string, height: number | (() => number)) => {
      const button = Object.assign(document.createElement('button'), { id, type: 'button', textContent: text });
      button.addEventListener('click', () => {
        const asked = typeof height === 'function' ? height() : height;
        modal.resize({ height: asked }).then(
          () => void (fitted.textContent = `высота: ${String(asked)}`),
          (error: unknown) => void (failed.textContent = error instanceof Error ? error.message : String(error)),
        );
      });
      return button;
    };
    box.append(filler, fitted, failed, ask('shrink', 'По содержимому', contentHeight), ask('grow', 'Выше экрана', 4000), ask('bad', 'Неверная высота', 5000));
    root.append(box);
  }
  return {
    dispose() {
      document.removeEventListener('keydown', onKey);
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
