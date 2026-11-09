// Вид panels: боковая колонка. Два вида одного плагина - два фрейма, у каждого свой ctx.view и свой канал с главной частью.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const text = document.createElement('p');
  text.id = 'which';
  text.textContent = `${ctx.pluginId}/${ctx.view}: боковая колонка`;
  // Толчки главной части (команда panels.ping) приходят сюда без опроса; сообщение до открытия вида канал не хранит.
  const pushed = document.createElement('p');
  pushed.id = 'pushed';
  pushed.textContent = 'толчков: 0';
  const reply = document.createElement('button');
  reply.id = 'reply';
  reply.type = 'button';
  reply.textContent = 'Ответить главной части';
  reply.addEventListener('click', () => void ctx.channel.post({ from: ctx.view }).catch(() => undefined));
  root.append(text, pushed, reply);
  return ctx.channel.onMessage((message) => {
    const ping = typeof message === 'object' && message !== null ? (message as { ping?: unknown }).ping : undefined;
    if (typeof ping === 'number') pushed.textContent = `толчков: ${String(ping)}`;
  });
}

mount satisfies UiModule<HTMLElement>['mount'];
