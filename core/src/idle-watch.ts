import { CoreError } from './errors.ts';
import type { BridgeEnd, Host, IdleWatch, KernelContext } from './kernel-context.ts';

/** Слушатели простоя пользователя (`onIdle`): опрос ОС идёт, только пока кто-то ждёт. */
export function createIdleWatch(ctx: KernelContext): IdleWatch {
  const { options, limits } = ctx;
  const watchers = new Map<string, { host: Host; pluginId: string; seconds: number; fired: boolean }>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function poll(): void {
    const idle = options.idleSeconds?.();
    if (idle === undefined) return;
    for (const [id, w] of watchers) {
      if (w.host.down) continue;
      if (!w.fired && idle >= w.seconds) {
        w.fired = true;
        w.host.endpoint.notify('system', { kind: 'idle', id });
      } else if (w.fired && idle < w.seconds) w.fired = false;
    }
  }

  function sync(): void {
    if (watchers.size > 0 && timer === undefined && options.idleSeconds && !ctx.unloading) {
      timer = setInterval(poll, options.idlePoll ?? 1000);
      timer.unref();
    } else if ((watchers.size === 0 || ctx.unloading) && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function attach({ host, mine, onNote }: BridgeEnd): void {
    onNote('idle.watch', { pluginId: 'string', id: 'string', seconds: 'number' }, (p) => {
      mine(p.pluginId);
      if (!p.id.startsWith(`${p.pluginId}#`)) throw new CoreError('Invalid', `idle.watch: ${p.id} не у ${p.pluginId}`);
      if (!(p.seconds > 0)) throw new CoreError('Invalid', `idle.watch: ${String(p.seconds)} секунд`);
      if (!watchers.has(p.id) && [...watchers.values()].filter((w) => w.pluginId === p.pluginId).length >= limits.idleWatchers) {
        throw new CoreError('Invalid', `idle.watch: у ${p.pluginId} слушателей onIdle больше ${String(limits.idleWatchers)}`);
      }
      watchers.set(p.id, { host, pluginId: p.pluginId, seconds: p.seconds, fired: false });
      sync();
    });
    onNote('idle.unwatch', { pluginId: 'string', id: 'string' }, (p) => {
      mine(p.pluginId);
      if (watchers.get(p.id)?.pluginId === p.pluginId) watchers.delete(p.id);
      sync();
    });
  }

  return {
    attach,
    sync,
    drop(pluginId) {
      for (const [id, w] of [...watchers]) if (w.pluginId === pluginId) watchers.delete(id);
      sync();
    },
  };
}
