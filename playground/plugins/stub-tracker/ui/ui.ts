// Виды-заглушки трекеров: один модуль на четыре вида, подпись берётся из имени вида.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

const CAPTION: Record<string, string> = {
  status: 'карточка «Статус» (заглушка)',
  tasks: 'кнопка «Задачи» (заглушка)',
  mrs: 'кнопка «MR/PR» (заглушка)',
  'task-panel': 'выезжающая панель задач (заглушка)',
};

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  root.append(Object.assign(document.createElement('p'), { id: 'which', textContent: `${ctx.pluginId}/${ctx.view}: ${CAPTION[ctx.view] ?? ctx.view}` }));
  return {
    dispose() {
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
