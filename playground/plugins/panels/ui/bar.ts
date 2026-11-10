// Вид panels: панель инструментов основной области. Подписан на свой канал и толчков panels.ping не получает: они адресованы виду panel.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { mountPanel } from './common.ts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const panel = mountPanel(root, ctx, 'панель инструментов');
  const pushed = Object.assign(document.createElement('p'), { id: 'pushed', textContent: 'толчков: 0' });
  root.append(pushed);
  const sub = ctx.channel.onMessage(() => {
    pushed.textContent = 'толчков: получен чужой';
  });
  return {
    dispose() {
      sub.dispose();
      panel.dispose();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
