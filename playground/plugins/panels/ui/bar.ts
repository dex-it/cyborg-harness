// Вид panels: панель инструментов основной области. Подписан на свой канал и толчков panels.ping не получает: они адресованы виду panel.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const text = document.createElement('p');
  text.id = 'which';
  text.textContent = `${ctx.pluginId}/${ctx.view}: панель инструментов`;
  const pushed = document.createElement('p');
  pushed.id = 'pushed';
  pushed.textContent = 'толчков: 0';
  root.append(text, pushed);
  return ctx.channel.onMessage(() => {
    pushed.textContent = 'толчков: получен чужой';
  });
}

mount satisfies UiModule<HTMLElement>['mount'];
