import type { KernelContext } from './kernel-context.ts';
import type { LayoutMark } from './layout.ts';

/** Метка плагина сейчас: общая для раскладки и меню окна. Нет метки - плагин не отстранён настройками, человеком, сторожем или графом. */
export function pluginMark(ctx: KernelContext, pluginId: string): LayoutMark | undefined {
  const { switchedOff, userOff } = ctx.parts.lifecycle;
  return ctx.graph.rejected.has(pluginId) ? 'out-of-graph' : !ctx.byId.has(pluginId) ? 'not-enabled' : switchedOff.has(pluginId) || userOff.has(pluginId) ? 'disabled' : undefined;
}
