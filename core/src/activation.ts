import { CoreError, errorMessage, ignore } from './errors.ts';
import { providesMatching } from './graph.ts';
import type { ActivateResult } from './host-runtime.ts';
import type { Activation, Host, KernelContext } from './kernel-context.ts';
import type { PluginManifest } from './manifest.ts';
import type { Provenance, ProvenanceVerdict, VerifiedPackage } from './provenance.ts';

/** Проверка происхождения, которая не может уронить активацию: бросок проверяющего - отказ `unavailable` в режиме `enforce`. */
async function check(provenance: Provenance, m: PluginManifest): Promise<ProvenanceVerdict> {
  try {
    return await provenance.check({ id: m.id, version: m.version });
  } catch (error) {
    return { ok: false, code: 'unavailable', reason: `проверка не выполнена: ${errorMessage(error)}`, mode: 'enforce' };
  }
}

/** Активация плагина и ленивые плагины, которые ждут первой команды, сочетания, показа вида или потребителя. */
export function createActivation(ctx: KernelContext): Activation {
  const { options, graph, active, gateway } = ctx;
  const waiting = new Set<string>();
  const waking = new Map<string, Promise<void>>();
  const activating = new Map<string, Promise<void>>();

  /** Поставщики по графу (requires, optional) - их ждём; поставщики consumes будятся без ожидания: у many бывают встречные пары. */
  async function wakeProviders(m: PluginManifest): Promise<void> {
    for (const p of graph.bindings.get(m.id)?.values() ?? []) await wake(p);
    for (const id of waiting) if (Object.entries(m.consumes).some(([c, r]) => providesMatching(ctx.manifestOf(id), c, r))) void wake(id);
  }

  function wake(pluginId: string): Promise<void> {
    const pending = waking.get(pluginId);
    if (pending) return pending;
    if (!waiting.has(pluginId) || ctx.unloading) return Promise.resolve();
    waiting.delete(pluginId);
    const started = activate(pluginId).finally(() => waking.delete(pluginId));
    waking.set(pluginId, started);
    return started;
  }

  // Вид поднимается вместе с enable и зовёт команды главной части раньше, чем та их зарегистрирует: run ждёт любую идущую активацию.
  function activate(pluginId: string): Promise<void> {
    const started = activateNow(pluginId).finally(() => activating.delete(pluginId));
    activating.set(pluginId, started);
    return started;
  }

  async function activateNow(pluginId: string): Promise<void> {
    const { pool, lifecycle, sections } = ctx.parts;
    const m = ctx.manifestOf(pluginId);
    await wakeProviders(m);
    const down = [...(graph.bindings.get(pluginId) ?? [])].find(([c, p]) => c in m.requires && !active.includes(p));
    if (down) {
      ctx.record({ pluginId, kind: 'skipped', reason: `поставщик ${down[0]} (${down[1]}) не активен` });
      return;
    }
    let verified: VerifiedPackage | undefined;
    if (options.provenance) {
      const verdict = await check(options.provenance, m);
      if (!verdict.ok) {
        ctx.record({ pluginId, kind: 'integrity-failed', code: verdict.code, reason: verdict.reason, mode: verdict.mode, ...(verdict.keyId !== undefined && { keyId: verdict.keyId }) });
        if (verdict.mode === 'enforce') return;
      } else verified = verdict.verified;
    }
    const hostId = ctx.hostOf(m.id) ?? m.id;
    let host: Host;
    try {
      host = pool.hosts.get(hostId) ?? pool.start(hostId);
    } catch (error) {
      lifecycle.forgetOs(pluginId);
      ctx.record({ pluginId, kind: 'failed', hostId, error: `хост не запустился: ${errorMessage(error)}` });
      return;
    }
    const started = performance.now();
    try {
      const config = sections.input('config', m);
      const state = sections.input('state', m);
      for (const [kind, s] of [['config', config], ['state', state]] as const) {
        if (s && 'status' in s) {
          ctx.record({ pluginId, kind, result: s });
          return;
        }
      }
      gateway.approve(pluginId);
      const params = { pluginId, entry: options.entry?.(m) ?? pluginId, paths: gateway.pathsOf(pluginId), config, state, ...(verified !== undefined && { verified }) };
      const result = await pool.call<ActivateResult>(host, pluginId, 'activate', params, ctx.activationTimeout);
      if (!result.ok) {
        ctx.record({ pluginId, kind: result.kind, result: result.result });
        return;
      }
      active.push(pluginId);
      gateway.claimPty(pluginId);
      ctx.record({ pluginId, kind: 'activated', hostId, ms: performance.now() - started });
    } catch (error) {
      if (host.down) return;
      lifecycle.dropPlugin(pluginId);
      if (error instanceof CoreError && error.code === 'Timeout') host.endpoint.request('deactivate', { pluginId }).catch(ignore);
      ctx.record({ pluginId, kind: 'failed', hostId, error: errorMessage(error) });
    }
  }

  /** Запуск ядра: окно закрыто до первого кадра, плагины активируются в порядке графа, ленивые ждут. */
  async function start(): Promise<void> {
    const { lifecycle } = ctx.parts;
    // Окно закрыто до первого кадра: иначе виды успели бы показаться до активации плагина замка.
    if (!options.safeMode) for (const pluginId of graph.order) if (ctx.manifestOf(pluginId).lock) ctx.layer.lock(pluginId, false);
    for (const pluginId of graph.order) {
      if (options.safeMode) {
        ctx.record({ pluginId, kind: 'safe-mode' });
        continue;
      }
      if (ctx.manifestOf(pluginId).activation === 'lazy' && !ctx.manifestOf(pluginId).lock) {
        waiting.add(pluginId);
        ctx.record({ pluginId, kind: 'waiting' });
        continue;
      }
      await lifecycle.idle();
      await activate(pluginId);
    }
    await lifecycle.idle();
  }

  return { waiting, waking, activating, forget: (pluginId) => void waiting.delete(pluginId), activate, wake, start };
}
