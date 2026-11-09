import { serialize } from 'node:v8';
import { CoreError, errorMessage } from './errors.ts';
import type { BridgeEnd, KernelContext, ViewChannels } from './kernel-context.ts';

/**
 * Канал «главная часть - вид» (SAD 3.8, FR-CH-2027). Ядро только связывает: плагин и имя вида берёт из канала хоста и из origin фрейма,
 * сверяет вид с манифестом плагина и размер с `limits.viewMessage`, а доставку виду отдаёт приложению (`LoadOptions.onViewMessage`).
 */
export function createViewChannels(ctx: KernelContext): ViewChannels {
  const { options, limits } = ctx;

  /** Размер по `v8.serialize` - тому, что поедет через границу: `Map` и `Date` считаются как есть, а не как `{}` у JSON. */
  function checkSize(pluginId: string, view: string, message: unknown): void {
    let bytes: number;
    try {
      bytes = serialize(message).byteLength;
    } catch (error) {
      throw new CoreError('NotCloneable', `${pluginId}: сообщение виду ${view} не переживёт structuredClone: ${errorMessage(error)}`);
    }
    if (bytes > limits.viewMessage) throw new CoreError('Invalid', `${pluginId}: сообщение виду ${view} больше ${String(limits.viewMessage)} байт`);
  }

  function attach({ live, onRequest }: BridgeEnd): void {
    onRequest('views', { pluginId: 'string', method: ['post'], args: 'array' }, (p) => {
      const id = live(p.pluginId).id;
      const view = p.args[0];
      if (typeof view !== 'string') throw new CoreError('Invalid', `${id}: канал вида - строка с именем из ui.views`);
      ctx.parts.views.viewKey(id, view);
      checkSize(id, view, p.args[1]);
      if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
      options.onViewMessage?.(id, view, p.args[1]);
      return undefined;
    });
  }

  async function fromView(pluginId: string, view: string, message: unknown): Promise<void> {
    const { activation, pool, views } = ctx.parts;
    if (typeof view !== 'string') throw new CoreError('Invalid', `${pluginId}: канал вида - строка с именем из ui.views`);
    views.viewKey(pluginId, view);
    checkSize(pluginId, view, message);
    if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
    // Вид поднимается вместе с включением плагина и пишет раньше, чем тот активировался: ленивого будим, идущую активацию ждём.
    if (activation.waiting.has(pluginId)) await activation.wake(pluginId);
    else await activation.activating.get(pluginId);
    await pool.live(pluginId).endpoint.request('view.message', { pluginId, view, message });
  }

  return { attach, fromView };
}
