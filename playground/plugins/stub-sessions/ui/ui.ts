// Виды-заглушки «Сессии» (боковая колонка) и «Новая сессия» (панель инструментов): у обоих один модуль, подпись берётся из имени вида.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

const CAPTION: Record<string, string> = { list: 'список сессий (заглушка)', new: 'кнопка «Новая сессия» (заглушка)' };

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  root.append(Object.assign(document.createElement('p'), { id: 'which', textContent: `${ctx.pluginId}/${ctx.view}: ${CAPTION[ctx.view] ?? ctx.view}` }));
  return {
    dispose() {
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
