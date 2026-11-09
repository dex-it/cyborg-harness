// Вид panels: боковая колонка. Два вида одного плагина - два фрейма, у каждого свой ctx.view.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { mountPanel } from './common.ts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  return mountPanel(root, ctx, 'боковая колонка');
}

mount satisfies UiModule<HTMLElement>['mount'];
