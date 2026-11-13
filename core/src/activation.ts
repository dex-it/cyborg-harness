import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError, errorMessage, ignore } from './errors.ts';
import { providesMatching } from './graph.ts';
import type { ActivateResult } from './host-runtime.ts';
import type { Activation, Host, KernelContext } from './kernel-context.ts';
import type { PluginManifest } from './manifest.ts';
import { checkPlugin, ENTRY_FILES, formatProblem } from './plugin-check.ts';

/** Сколько найденных нарушений ядро пишет строками: остальное одной строкой «и ещё N»; журнал строк плагина ограничен по частоте. */
const AUDIT_LINES = 10;

/** Активация плагина и ленивые плагины, которые ждут первой команды, сочетания, показа вида или потребителя. */
export function createActivation(ctx: KernelContext): Activation {
  const { options, graph, active, gateway } = ctx;
  const waiting = new Set<string>();
  const waking = new Map<string, Promise<void>>();
  const activating = new Map<string, Promise<void>>();
  const audited = new Set<string>();

  /**
   * Плагин вне поставки (TR-06, ADR-CH-0003, п. 6): до первой активации `checkPlugin` читает его исходники и манифест (импорты, манифест, файлы из него, точку входа), найденное идёт в журнал строк плагина
   * уровнем `warn`. Плагин при этом не блокируется: проверка - дисциплина автора, а не защита (код может обойти её динамикой). Один раз за запуск ядра.
   * Каталог плагина берётся из точки входа (`index.mjs|js|ts` рядом с `manifest.json`); нет файла-точки или `manifest.json` рядом - проверять нечего.
   */
  async function auditImports(m: PluginManifest): Promise<void> {
    if (options.bundled === undefined || options.bundled.includes(m.id) || audited.has(m.id)) return;
    audited.add(m.id);
    let entry: string | undefined;
    try {
      entry = options.entry?.(m);
    } catch {
      // Сбой точки входа - отказ активации этого плагина: его записывает `failed` ниже, а не обрыв всей загрузки отсюда.
      return;
    }
    if (typeof entry !== 'string' || !entry.startsWith('file:')) return;
    let file: string;
    try {
      file = fileURLToPath(entry);
    } catch {
      return;
    }
    const dir = path.dirname(file);
    if (!ENTRY_FILES.includes(path.basename(file)) || !fs.existsSync(path.join(dir, 'manifest.json'))) return;
    try {
      const { problems } = await checkPlugin(dir, { apiVersion: options.apiVersion });
      for (const problem of problems.slice(0, AUDIT_LINES)) ctx.parts.logs.pluginLine(m.id, `проверка плагина (плагин вне поставки, загрузка не останавливается): ${formatProblem(problem)}`, 'warn');
      if (problems.length > AUDIT_LINES) ctx.parts.logs.pluginLine(m.id, `проверка плагина: и ещё ${String(problems.length - AUDIT_LINES)} замечаний, полный список - \`cyborg-plugin check\``, 'warn');
    } catch (error) {
      ctx.parts.logs.pluginLine(m.id, `проверка плагина не выполнилась: ${errorMessage(error)}`, 'warn');
    }
  }

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
    await auditImports(m);
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
      const params = { pluginId, entry: options.entry?.(m) ?? pluginId, paths: gateway.pathsOf(pluginId), config, state };
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
