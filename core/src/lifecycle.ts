import { CoreError, errorMessage, ignore } from './errors.ts';
import { providesMatching } from './graph.ts';
import { bump } from './host-pool.ts';
import type { Counter, KernelContext, Lifecycle, PtyDrop } from './kernel-context.ts';
import type { DisableOptions, UninstallReport } from './kernel-types.ts';
import { isValidId } from './manifest-fields.ts';
import type { PluginManifest } from './manifest.ts';

/** Очередь операций над плагинами, выключение и включение, страйки сторожа, снятие плагина и выгрузка ядра. */
export function createLifecycle(ctx: KernelContext): Lifecycle {
  const { active, graph, layer, gateway, notices, options, watchdog } = ctx;
  const strikes = new Map<string, Counter>();
  const switchedOff = new Set<string>();
  const userOff = new Set<string>();
  // Последний список из файла: setEnabled применяет разницу с ним, а не с выключенными в окне.
  let listed = new Set(options.enabled);
  let chain: Promise<void> = Promise.resolve();

  // Отказ одного шага не отравляет очередь: иначе idle, enable, disable и unload отвечали бы им вечно.
  const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
    const run = chain.then(step);
    chain = run.then(ignore, ignore);
    return run;
  };

  async function idle(): Promise<void> {
    const { activation } = ctx.parts;
    for (;;) {
      const current = chain;
      await current;
      await Promise.allSettled([...activation.waking.values()]);
      if (current === chain && activation.waking.size === 0) return;
    }
  }

  function strike(id: string): boolean {
    const n = bump(strikes, id, watchdog.window);
    if (n < watchdog.strikes) return false;
    switchedOff.add(id);
    ctx.record({ pluginId: id, kind: 'switched-off', strikes: n, affects: affected([id]) });
    return true;
  }

  function affected(gone: readonly string[]): string[] {
    const uses = (consumer: PluginManifest, provider: PluginManifest) =>
      [...(graph.bindings.get(consumer.id)?.values() ?? [])].includes(provider.id) ||
      Object.entries(consumer.consumes).some(([contract, range]) => providesMatching(provider, contract, range));
    return active.filter((id) => !gone.includes(id) && gone.some((p) => uses(ctx.manifestOf(id), ctx.manifestOf(p))));
  }

  /** Падение хоста (`detach`) уведомления не закрывает: клик дойдёт до вернувшегося плагина. */
  function forgetOs(pluginId: string, pty: PtyDrop = 'release'): number {
    if (pty !== 'detach') notices.forget(pluginId);
    return gateway.forget(pluginId, pty);
  }

  function dropPlugin(pluginId: string, pty: PtyDrop = 'release'): number {
    const { idleWatch, contracts, commands } = ctx.parts;
    idleWatch.drop(pluginId);
    contracts.dropFor(pluginId);
    commands.dropFor(pluginId);
    const kept = forgetOs(pluginId, pty);
    layer.forget(pluginId);
    const i = active.indexOf(pluginId);
    if (i >= 0) active.splice(i, 1);
    return kept;
  }

  function guard(pluginId: string): void {
    if (!graph.order.includes(pluginId)) throw new CoreError('Unavailable', `${pluginId} не загружается: причина в журнале`);
    if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
    if (options.safeMode) throw new CoreError('Unavailable', 'безопасный режим');
  }

  /** Активные, кто через requires прямо или по цепочке держится за `root`. */
  function dependents(root: string): Set<string> {
    const gone = new Set([root]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const id of active) {
        if (gone.has(id)) continue;
        const m = ctx.manifestOf(id);
        if (![...(graph.bindings.get(id) ?? [])].some(([c, p]) => c in m.requires && gone.has(p))) continue;
        gone.add(id);
        grew = true;
      }
    }
    return gone;
  }

  async function unloadPlugin(pluginId: string, keepPty = false): Promise<{ error?: string; keptPty: number }> {
    const { pool } = ctx.parts;
    const host = pool.hosts.get(ctx.hostOf(pluginId) ?? '');
    let error: string | undefined;
    try {
      if (host) await pool.call(host, pluginId, 'deactivate', { pluginId }, ctx.activationTimeout);
    } catch (e) {
      error = errorMessage(e);
    }
    const keptPty = dropPlugin(pluginId, keepPty ? 'park' : 'release');
    // Пустой хост гасится: следующая активация импортирует код плагина заново, в новом процессе.
    if (host && !host.down && !active.some((id) => ctx.hostOf(id) === host.id)) pool.stop(host, new CoreError('HostGone', `хост ${host.id} без плагинов`));
    return { ...(error !== undefined && { error }), keptPty };
  }

  async function deactivate(pluginId: string, by: string, keepPty = false): Promise<void> {
    const { error, keptPty } = await unloadPlugin(pluginId, keepPty);
    ctx.record({ pluginId, kind: 'unloaded', by, ...(error !== undefined && { error }), ...(keptPty > 0 && { keptPty }) });
  }

  async function enable(pluginId: string): Promise<void> {
    const { activation, pool } = ctx.parts;
    guard(pluginId);
    userOff.delete(pluginId);
    activation.forget(pluginId);
    // Идущая активация (wake ленивого) - та же самая: вторая дала бы двойной activate и дубль в active.
    await activation.waking.get(pluginId);
    if (active.includes(pluginId)) return;
    strikes.delete(pluginId);
    switchedOff.delete(pluginId);
    pool.forgetFailures(ctx.hostOf(pluginId) ?? pluginId);
    const last = (id: string) => ctx.journal.findLast((e) => e.pluginId === id && e.kind !== 'key-conflict');
    const follows = (id: string) => {
      const e = last(id);
      return e?.kind === 'skipped' || (e?.kind === 'unloaded' && e.by === pluginId && id !== pluginId);
    };
    const run = enqueue(async () => {
      await activation.activating.get(pluginId);
      if (ctx.unloading || active.includes(pluginId)) return;
      ctx.record({ pluginId, kind: 'revived' });
      await activation.activate(pluginId);
      for (const id of graph.order) if (!active.includes(id) && !switchedOff.has(id) && !userOff.has(id) && follows(id)) await activation.activate(id);
    });
    await run;
    await idle();
  }

  async function disable(pluginId: string, disableOptions: DisableOptions = {}): Promise<void> {
    const { activation } = ctx.parts;
    guard(pluginId);
    const owner = [...(active.includes(pluginId) ? dependents(pluginId) : [pluginId])].find((id) => layer.isOwner(id));
    if (owner !== undefined) throw new CoreError('Invalid', `окно закрыто замком ${owner}: выключить его из-под замка нельзя`);
    userOff.add(pluginId);
    activation.forget(pluginId);
    await activation.waking.get(pluginId);
    const run = enqueue(async () => {
      if (ctx.unloading) return;
      if (!active.includes(pluginId)) {
        ctx.record({ pluginId, kind: 'unloaded', by: pluginId });
        return;
      }
      const gone = dependents(pluginId);
      for (const id of [...active].reverse()) if (gone.has(id)) await deactivate(id, pluginId, disableOptions.keepPty === true);
    });
    await run;
    await idle();
  }

  /** Что осталось после `uninstall` и почему: человек читает это до того, как поставит плагин с тем же id. */
  function leftAfterUninstall(pluginId: string): string[] {
    const hasConfig = (options.config?.raw(pluginId) ?? []).some(([, data]) => data !== undefined);
    return [
      ...(hasConfig ? ['настройки (config) в файлах пользователя и воркспейса: их правит человек'] : []),
      'state, память видов, документы и выбранные пути в других воркспейсах: ядро знает только текущий',
      'код плагина на диске: его убирает приложение',
      'веб-хранилище видов плагина (localStorage, IndexedDB его origin): его стирает приложение',
    ];
  }

  async function uninstall(pluginId: string): Promise<UninstallReport> {
    if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
    // Путь и ключи строятся из id: недопустимый не доходит ни до одного шага.
    if (!isValidId(pluginId)) throw new CoreError('Invalid', `недопустимый id плагина: ${JSON.stringify(pluginId)}`);
    // В очереди вместе с enable и disable: пока идёт стирание, плагин не поднимется.
    return enqueue(async (): Promise<UninstallReport> => {
      if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
      const { activation, views } = ctx.parts;
      const running = active.includes(pluginId) || activation.waiting.has(pluginId) || activation.waking.has(pluginId) || activation.activating.has(pluginId);
      // Плагин в графе, но не выключен ни человеком, ни сторожем: хост может вернуть его, и он пересоздал бы стёртое.
      // Снятый плагин общего хоста, который жив ради соседей, пересоздать не может: шлюз (`live` в host-bridge) отказывает в os, documents и section.write всем, кто не active.
      // В безопасном режиме хостов нет и enable/disable недоступны: ждать нечего, а удалить сломанный плагин нужно именно здесь (BR-CH-005).
      if (running || (!options.safeMode && graph.order.includes(pluginId) && !userOff.has(pluginId) && !switchedOff.has(pluginId))) {
        throw new CoreError('Invalid', `${pluginId} работает или ждёт запуска: сначала disablePreview и disable`);
      }
      const erased: string[] = [];
      const failed: string[] = [];
      const step = async (what: string, run: () => Promise<string | string[] | undefined> | string | undefined): Promise<void> => {
        try {
          const done = await run();
          if (done !== undefined) erased.push(...[done].flat());
        } catch (error) {
          failed.push(`${what}: ${errorMessage(error)}`);
        }
      };
      const counted = (n: number, what: string) => (n > 0 ? `${what}: ${String(n)}` : undefined);
      dropPlugin(pluginId);
      await step('терминалы', () => counted(gateway.endAllPty(pluginId), 'терминалов завершено'));
      await step('файлы', () => gateway.eraseFiles(pluginId));
      await step('секреты', async () => counted(await gateway.eraseSecrets(pluginId), 'секреты'));
      await step('выбранные пути', async () => counted(await gateway.eraseGrants(pluginId), 'выбранные человеком пути (granted)'));
      await step('память видов', async () => counted(await views.forget(pluginId), 'память видов'));
      await step('документы', async () => counted(await ctx.documents.removeOf(pluginId), 'документы'));
      await step('state', async () => ((await options.state?.remove('workspace', pluginId)) === true ? 'состояние (state) воркспейса' : undefined));
      const left = leftAfterUninstall(pluginId);
      const error = failed.join('; ');
      ctx.record({ pluginId, kind: 'uninstalled', erased, left, ...(error !== '' && { error }) });
      if (error !== '') throw new CoreError('Unavailable', `${pluginId}: стёрто не всё, повтор доделает: ${error}; стёрто: ${erased.join(', ') || 'ничего'}`);
      return { pluginId, erased, left };
    });
  }

  /** Снимает плагины в обратном порядке активации и гасит хосты. */
  async function shutdown(): Promise<void> {
    const { pool, idleWatch } = ctx.parts;
    await idle();
    ctx.unloading = true;
    idleWatch.sync();
    for (const pluginId of [...active].reverse()) {
      try {
        await pool.call(pool.live(pluginId), pluginId, 'deactivate', { pluginId }, ctx.activationTimeout);
        ctx.record({ pluginId, kind: 'deactivated' });
      } catch (error) {
        ctx.record({ pluginId, kind: 'deactivated', error: errorMessage(error) });
      }
      dropPlugin(pluginId);
    }
    gateway.releaseAllPty();
    layer.clear();
    pool.stopAll();
    ctx.flushRepeats();
  }

  return {
    switchedOff,
    userOff,
    enqueue,
    idle,
    strike,
    affected,
    dropPlugin,
    forgetOs,
    unloadPlugin,
    enable,
    disable,
    uninstall,
    shutdown,
    async setEnabled(next) {
      const want = new Set(next);
      const restart: string[] = [];
      const failed: string[] = [];
      const inGraph = (id: string) => graph.order.includes(id);
      const removed = [...listed].filter((id) => !want.has(id));
      const added = [...want].filter((id) => !listed.has(id));
      listed = want;
      for (const id of removed) {
        if (!inGraph(id)) continue;
        try {
          await disable(id);
        } catch (error) {
          failed.push(`${id}: ${errorMessage(error)}`);
        }
      }
      for (const id of added) {
        if (inGraph(id)) await enable(id);
        else if (!ctx.enabled.has(id)) restart.push(id);
      }
      return { restart, failed };
    },
    disablePreview(pluginId) {
      guard(pluginId);
      const plugins = active.includes(pluginId) ? [...dependents(pluginId)] : [];
      return { plugins, ptys: plugins.flatMap((id) => gateway.ptysOf(id).map((p) => ({ ...p, pluginId: id }))) };
    },
  };
}
