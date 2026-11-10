// Вид panels: боковая колонка. Два вида одного плагина - два фрейма, у каждого свой ctx.view и свой канал с главной частью.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { mountPanel } from './common.ts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const panel = mountPanel(root, ctx, 'боковая колонка');
  // Толчки главной части (команда panels.ping) приходят сюда без опроса; сообщение до открытия вида канал не хранит.
  const pushed = Object.assign(document.createElement('p'), { id: 'pushed', textContent: 'толчков: 0' });
  const reply = Object.assign(document.createElement('button'), { id: 'reply', type: 'button', textContent: 'Ответить главной части' });
  reply.addEventListener('click', () => void ctx.channel.post({ from: ctx.view }).catch(() => undefined));
  root.append(pushed, reply);
  const sub = ctx.channel.onMessage((message) => {
    const ping = typeof message === 'object' && message !== null ? (message as { ping?: unknown }).ping : undefined;
    if (typeof ping === 'number') pushed.textContent = `толчков: ${String(ping)}`;
  });
  return {
    dispose() {
      sub.dispose();
      panel.dispose();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
