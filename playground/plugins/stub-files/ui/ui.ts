// Вид-заглушка «Файлы»: подпись области и ответ на команду поиска от главной части.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const which = Object.assign(document.createElement('p'), { id: 'which', textContent: `${ctx.pluginId}/${ctx.view}: дерево файлов (заглушка)` });
  const search = Object.assign(document.createElement('output'), { id: 'search', textContent: 'поиск не открывали' });
  root.append(which, search);
  const sub = ctx.channel.onMessage(() => (search.textContent = 'поиск открыт командой плагина'));
  return {
    dispose() {
      sub.dispose();
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
