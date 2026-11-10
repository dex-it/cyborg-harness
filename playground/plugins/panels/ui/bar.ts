// Вид panels: панель инструментов основной области.

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { mountPanel } from './common.ts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable | undefined {
  return mountPanel(root, ctx, 'панель инструментов');
}

mount satisfies UiModule<HTMLElement>['mount'];
