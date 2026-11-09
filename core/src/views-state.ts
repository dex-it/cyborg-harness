import { VERSION_KEY } from './config.ts';
import { CoreError } from './errors.ts';
import type { KernelContext, ViewsState } from './kernel-context.ts';
import { viewEntry } from './manifest.ts';
import { isRecord } from './wire.ts';

// Id раздела ядра: плагин не может так называться, `$` манифест не пропустит.
const VIEW_STATE = '$views';
const VIEW_STATE_MAX = 64 * 1024;

/** Память видов: раздел ядра `$views` в state воркспейса, ключ `<плагин>/<вид>`; записи идут по очереди, чтобы параллельные не затёрли друг друга. */
export function createViewsState(ctx: KernelContext): ViewsState {
  const { options } = ctx;
  let writes: Promise<unknown> = Promise.resolve();

  const viewKey = (pluginId: string, view: string): string => {
    const m = ctx.known.find((k) => k.id === pluginId);
    if (!m || viewEntry(m, view) === undefined) throw new CoreError('Invalid', `${pluginId}: вида ${JSON.stringify(view)} нет в манифесте`);
    return `${pluginId}/${view}`;
  };

  const memory = (): Record<string, unknown> => {
    const raw = options.state?.raw(VIEW_STATE).find(([layer]) => layer === 'workspace')?.[1];
    if (!isRecord(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== VERSION_KEY));
  };

  return {
    viewKey,
    viewState: (pluginId, view) => {
      const value = memory()[viewKey(pluginId, view)];
      return value === undefined ? undefined : structuredClone(value);
    },
    setViewState(pluginId, view, value) {
      const key = viewKey(pluginId, view);
      const text = JSON.stringify(value) as string | undefined;
      if (text !== undefined && Buffer.byteLength(text) > VIEW_STATE_MAX) throw new CoreError('Invalid', `${key}: память вида больше ${String(VIEW_STATE_MAX)} байт`);
      const data: unknown = text === undefined ? undefined : JSON.parse(text);
      const write = writes.then(async () => {
        if (!options.state) throw new CoreError('Unavailable', 'state воркспейса нет');
        const doc = Object.fromEntries(Object.entries(memory()).filter(([k]) => k !== key));
        if (data !== undefined) doc[key] = data;
        await options.state.write('workspace', VIEW_STATE, 1, doc);
      });
      writes = write.catch(() => undefined);
      return write;
    },
  };
}
