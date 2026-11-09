// Вид panels: панель инструментов основной области.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  const text = document.createElement('p');
  text.id = 'which';
  text.textContent = `${ctx.pluginId}/${ctx.view}: панель инструментов`;
  root.append(text);
  return undefined;
}

mount satisfies UiModule<HTMLElement>['mount'];
