// Вид panels: боковая колонка. Два вида одного плагина - два фрейма, у каждого свой ctx.view.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const text = document.createElement('p');
  text.id = 'which';
  text.textContent = `${ctx.pluginId}/${ctx.view}: боковая колонка`;
  root.append(text);
  return undefined;
}

mount satisfies UiModule<HTMLElement>['mount'];
