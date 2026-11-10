import { serialize } from 'node:v8';
import type { ModalSize } from '@cyborg-harness/contracts';
import { CoreError, errorMessage } from './errors.ts';
import type { BridgeEnd, KernelContext, ViewChannels } from './kernel-context.ts';
import type { PluginManifest } from './manifest.ts';
import { isRecord } from './wire.ts';

const MAX_TITLE = 200;
const MODAL_SIDE = { min: 100, max: 4096 } as const;

/** Размер окна от автора - недоверенные данные: целые пиксели в пределах, лишних полей нет. */
function parseModalSize(pluginId: string, raw: unknown): ModalSize | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never => {
    throw new CoreError('Invalid', `${pluginId}: size окна - { width?, height? }, целые пиксели от ${String(MODAL_SIDE.min)} до ${String(MODAL_SIDE.max)}`);
  };
  if (!isRecord(raw) || Array.isArray(raw)) return bad();
  const out: { width?: number; height?: number } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'width' && key !== 'height') return bad();
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MODAL_SIDE.min || value > MODAL_SIDE.max) return bad();
    out[key] = value;
  }
  return out;
}

/**
 * Канал «главная часть - вид» (SAD 3.8, FR-CH-2027). Ядро только связывает: плагин и имя вида берёт из канала хоста и из origin фрейма,
 * сверяет вид с манифестом плагина и размер с `limits.viewMessage`, а доставку виду отдаёт приложению (`LoadOptions.onViewMessage`).
 * Здесь же модальные окна плагина (вид с `area: "modal"`) и диалоги главной части: состояние держит слой окна (`window-layer.ts`).
 */
export function createViewChannels(ctx: KernelContext): ViewChannels {
  const { options, limits, layer } = ctx;

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

  /** Окно открывает главная часть: вид обязан быть объявлен модальным, название и данные проверены до показа. */
  function openModal(m: PluginManifest, view: unknown, init: unknown): Promise<unknown> {
    if (typeof view !== 'string') throw new CoreError('Invalid', `${m.id}: модальное окно - строка с именем из ui.views`);
    ctx.parts.views.viewKey(m.id, view);
    const place = m.ui?.placement?.[view];
    if (place?.area !== 'modal') throw new CoreError('Invalid', `${m.id}: вид ${view} не объявлен модальным (ui.views.${view}.area: "modal")`);
    if (init !== undefined && !isRecord(init)) throw new CoreError('Invalid', `${m.id}: модальное окно - { title?, data?, size?, escape? }`);
    const title = init?.title ?? place.title ?? m.id;
    if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TITLE) throw new CoreError('Invalid', `${m.id}: название окна - строка от 1 до ${String(MAX_TITLE)} символов`);
    checkSize(m.id, view, init?.data);
    const size = parseModalSize(m.id, init?.size);
    const escape = init?.escape;
    if (escape !== undefined && escape !== 'close' && escape !== 'view') throw new CoreError('Invalid', `${m.id}: escape окна - "close" или "view"`);
    if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
    return layer.showModal(m.id, view, title, init?.data, { ...(size && { size }), ...(escape && { escape }) }).result;
  }

  function attach({ live, onRequest }: BridgeEnd): void {
    onRequest('views', { pluginId: 'string', method: ['post', 'modal'], args: 'array' }, (p, _signal, op) => {
      const m = live(p.pluginId);
      // Главная часть обращается к виду: операция выходит на мост вида (Г2).
      op.enter('bridge');
      op.target(`bridge:views.${p.method}`);
      if (p.method === 'modal') return openModal(m, p.args[0], p.args[1]);
      const view = p.args[0];
      if (typeof view !== 'string') throw new CoreError('Invalid', `${m.id}: канал вида - строка с именем из ui.views`);
      ctx.parts.views.viewKey(m.id, view);
      checkSize(m.id, view, p.args[1]);
      if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
      options.onViewMessage?.(m.id, view, p.args[1]);
      return undefined;
    });
    onRequest('dialogs', { pluginId: 'string', method: ['show'], args: 'array' }, (p, _signal, op) => {
      const id = live(p.pluginId).id;
      op.enter('bridge');
      op.target('bridge:dialogs.show');
      const spec = p.args[0];
      // Меню стоит у точки в координатах вида, а у главной части вида нет.
      if (isRecord(spec) && spec.kind === 'menu') throw new CoreError('Invalid', `${id}: меню привязано к виду, у главной части есть только ask`);
      if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
      return layer.show(id, '', spec);
    });
  }

  function closeModal(pluginId: string, view: string, result: unknown): void {
    checkSize(pluginId, view, result);
    layer.closeModal(pluginId, view, result);
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

  return { attach, fromView, closeModal };
}
