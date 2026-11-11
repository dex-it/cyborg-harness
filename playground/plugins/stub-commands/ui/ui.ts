// Вид-заглушка полосы кнопок-команд под терминалом.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  root.append(Object.assign(document.createElement('p'), { id: 'which', textContent: `${ctx.pluginId}/${ctx.view}: полоса кнопок под терминалом (заглушка)` }));
  return {
    dispose() {
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
