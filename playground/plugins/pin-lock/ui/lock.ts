// Экран замка pin-lock: единственное, что видно и доступно, пока окно закрыто.

import type { Disposable, UiContext, UiModule } from '@cyborg/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const form = document.createElement('form');
  const pin = Object.assign(document.createElement('input'), { id: 'pin', type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: 'PIN' });
  const status = Object.assign(document.createElement('output'), { id: 'status', textContent: 'Окно закрыто' });
  form.append(pin, Object.assign(document.createElement('button'), { type: 'submit', id: 'unlock', textContent: 'Открыть' }), status);
  root.append(form);
  pin.focus();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void ctx.commands.run('pin-lock.unlock', pin.value).then(
      (ok) => {
        status.textContent = ok === true ? 'Открыто' : 'Неверный PIN';
        pin.value = '';
      },
      (error: unknown) => (status.textContent = error instanceof Error ? error.message : String(error)),
    );
  });
  return { dispose: () => root.replaceChildren() };
}

mount satisfies UiModule<HTMLElement>['mount'];
