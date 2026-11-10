import { CoreError, errorMessage, ignore } from './errors.ts';
import type { SystemEvent } from './host-runtime.ts';
import type { Counter, Host, HostPool, KernelContext } from './kernel-context.ts';
import type { JournalEntry } from './kernel-types.ts';
import type { PluginManifest } from './manifest.ts';
import { cancelError, Endpoint } from './rpc.ts';

// Граница доверия ядра - процесс хоста: внутри хоста плагины неразличимы, поэтому сторонний не делит процесс ни с кем.
export function assignHosts(
  manifests: readonly PluginManifest[],
  groups: Readonly<Record<string, readonly string[]>>,
  bundled: ReadonlySet<string>,
  record: (entry: JournalEntry) => void,
): Map<string, string> {
  const loaded = new Set(manifests.map((m) => m.id));
  const groupOf = (id: string) => Object.entries(groups).find(([, ids]) => ids.includes(id));
  const result = new Map<string, string>();
  for (const m of manifests) {
    const group = groupOf(m.id);
    result.set(m.id, group?.[0] ?? (m.host === 'own' || !bundled.has(m.id) ? m.id : 'builtin'));
  }
  const used = new Set(result.values());
  for (const m of manifests) {
    if (bundled.has(m.id)) continue;
    const hostId = result.get(m.id) ?? m.id;
    const neighbours = manifests.filter((other) => other.id !== m.id && result.get(other.id) === hostId);
    if (neighbours.length === 0) continue;
    let own = m.id;
    for (let n = 2; used.has(own); n++) own = `${m.id}~${n}`;
    used.add(own);
    result.set(m.id, own);
    const group = groupOf(m.id);
    if (group?.[1].some((id) => id !== m.id && loaded.has(id))) record({ pluginId: m.id, kind: 'host-isolated', group: group[0], hostId: own });
  }
  // Соседи считаются после выселения сторонних: тот, кто ушёл из группы в свой хост, зависанием её не заденет.
  for (const m of manifests) {
    const group = groupOf(m.id);
    if (!bundled.has(m.id) || m.host !== 'own' || !group) continue;
    const neighbours = manifests.filter((other) => other.id !== m.id && result.get(other.id) === group[0]).map((other) => other.id);
    if (neighbours.length > 0) record({ pluginId: m.id, kind: 'host-own-grouped', group: group[0], neighbours });
  }
  return result;
}

/** Ещё один сбой подряд: сбой позже `window` мс после прошлого - уже не «подряд», счёт начинается заново. */
export function bump(counts: Map<string, Counter>, key: string, window: number): number {
  const at = performance.now();
  const prev = counts.get(key);
  const n = prev && at - prev.at < window ? prev.n + 1 : 1;
  counts.set(key, { n, at });
  return n;
}

/** Отмена вызывающего переносится на контроллер вызова; уже отменённый сигнал отменяет сразу. */
function linkAbort(signal: AbortSignal, controller: AbortController | undefined): () => void {
  const onAbort = () => controller?.abort(cancelError(signal));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

export function createHostPool(ctx: KernelContext): HostPool {
  const { options, watchdog, active } = ctx;
  const hosts = new Map<string, Host>();
  const hostFailures = new Map<string, Counter>();

  async function call<T>(host: Host, pluginId: string, method: string, params: unknown, timeout?: number, signal?: AbortSignal, discard?: (value: unknown) => void): Promise<T> {
    const token = ++host.seq;
    host.inflight.set(token, pluginId);
    // Срок и отмена вызывающего - одно и то же для хоста поставщика: ему уходит `cancel`, а не только отпускается вызывающий.
    const controller = timeout !== undefined || signal !== undefined ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlink: (() => void) | undefined;
    try {
      if (signal) unlink = linkAbort(signal, controller);
      if (timeout !== undefined) timer = setTimeout(() => controller?.abort(new CoreError('Timeout', `${method} ${pluginId} дольше ${timeout} мс`)), timeout);
      return await host.endpoint.request<T>(method, params, controller?.signal, discard);
    } finally {
      clearTimeout(timer);
      unlink?.();
      host.inflight.delete(token);
    }
  }

  function live(pluginId: string): Host {
    const host = hosts.get(ctx.hostOf(pluginId) ?? '');
    if (!host || !active.includes(pluginId)) throw new CoreError('Unavailable', `${pluginId} не активен`);
    return host;
  }

  function start(hostId: string): Host {
    const handle = options.spawnHost(hostId);
    const host: Host = { id: hostId, handle, endpoint: new Endpoint(handle.port, ctx.trace.owner), inflight: new Map(), seq: 0, answered: 0, notes: 0, down: false };
    hosts.set(hostId, host);
    const { endpoint } = host;
    ctx.parts.bridge.attach(host);

    handle.onExit(() => hostDown(host, 'crash'));
    endpoint.request('init', ctx.wire).catch(ignore);
    ctx.parts.contracts.announce(host);

    let tickAt = performance.now();
    host.timer = setInterval(() => {
      const now = performance.now();
      // Тик пришёл позже срока: цикл событий самого ядра стоял (занятый раннер, долгий синхронный код). Таймеры идут раньше фазы poll, где обрабатываются
      // ответ на пинг и выход процесса хоста, поэтому молчание, совпавшее с простоем ядра, - не вина хоста: оно в срок зависания не засчитывается.
      const stalled = Math.max(0, now - tickAt - watchdog.interval);
      tickAt = now;
      if (host.down) return;
      if (host.pingAt !== undefined) {
        if (now - host.pingAt - stalled > watchdog.timeout) hostDown(host, 'hang');
        return;
      }
      host.pingAt = now;
      const mark = host.seq;
      endpoint.request('ping', null).then((sent) => {
        host.pingAt = undefined;
        host.answered = mark;
        // Ответ пришёл позже уведомления о коде после пинга (оба в одной порции сообщений): это уведомление не стирается.
        if (typeof sent !== 'number' || host.notes <= sent) host.running = undefined;
      }, ignore);
    }, watchdog.interval);
    host.timer.unref();
    return host;
  }

  function stop(host: Host, error: CoreError): void {
    host.down = true;
    clearInterval(host.timer);
    host.handle.kill();
    host.endpoint.close(error);
    if (hosts.get(host.id) === host) hosts.delete(host.id);
  }

  function hostDown(host: Host, reason: 'hang' | 'crash'): void {
    if (host.down) return;
    const { lifecycle, activation } = ctx.parts;
    const inflight = [...host.inflight].sort(([a], [b]) => a - b);
    // Хост не назвал виновника - вызовы до последнего отвеченного пинга он уже принял, их владельцы ждут честно; держит первый принятый после.
    const blocker = (reason === 'hang' ? host.running : host.exiting) ?? inflight.find(([token]) => token > host.answered)?.[1];
    const culprits = blocker === undefined ? [] : [blocker];
    const victims = active.filter((id) => ctx.hostOf(id) === host.id);
    // Активация, оборванная падением, успела отдать контракты и команды: без снятия они остались бы заготовками мёртвого хоста.
    const halfway = [...new Set(inflight.map(([, id]) => id))].filter((id) => !active.includes(id) && ctx.hostOf(id) === host.id);
    stop(host, new CoreError('HostGone', `хост ${host.id} ${reason === 'hang' ? 'завис' : 'упал'}`));
    if (ctx.unloading) return;
    ctx.record({ kind: 'host-down', hostId: host.id, reason, culprits, plugins: victims, affects: lifecycle.affected(victims) });
    for (const id of [...victims, ...halfway].reverse()) lifecycle.dropPlugin(id, 'detach');

    for (const id of culprits) lifecycle.strike(id);
    if (culprits.length === 0) {
      const failures = bump(hostFailures, host.id, watchdog.window);
      if (failures >= watchdog.strikes) {
        ctx.record({ kind: 'host-abandoned', hostId: host.id, failures, plugins: victims });
        for (const id of victims) lifecycle.forgetOs(id);
        return;
      }
    }

    const { switchedOff, userOff } = lifecycle;
    const again = ctx.graph.order.filter((id) => ctx.hostOf(id) === host.id && !switchedOff.has(id) && !userOff.has(id) && (victims.includes(id) || culprits.includes(id) || halfway.includes(id)));
    // pty с persist ждут только тех, кто вернётся; выключенному сторожем их некому забрать.
    for (const id of victims) if (!again.includes(id)) lifecycle.forgetOs(id);
    if (again.length === 0) return;
    lifecycle.enqueue(async () => {
      if (ctx.unloading) return;
      ctx.record({ kind: 'host-restart', hostId: host.id, plugins: again });
      for (const id of again) {
        // Человек мог выключить плагин, пока перезапуск ждал очереди: сторож его не поднимает.
        if (userOff.has(id) || switchedOff.has(id)) {
          lifecycle.forgetOs(id);
          continue;
        }
        await activation.activate(id);
      }
    }).catch((error: unknown) => ctx.parts.logs.hostLine(host.id, `перезапуск не удался: ${errorMessage(error)}`, 'error'));
  }

  return {
    hosts,
    start,
    stop,
    call,
    live,
    forgetFailures: (hostId) => hostFailures.delete(hostId),
    emit(event: SystemEvent) {
      if (!['focus', 'suspend', 'resume', 'screen-lock'].includes(event.kind)) throw new CoreError('Invalid', `событие ${event.kind as string} ядру не известно`);
      for (const host of hosts.values()) if (!host.down) host.endpoint.notify('system', event);
    },
    async beforeQuit(budget) {
      await ctx.parts.lifecycle.idle();
      const late = new Promise<void>((resolve) => setTimeout(resolve, budget).unref());
      // Без call: зависший слушатель - не сбой плагина, хост всё равно уходит вместе с приложением.
      const asks = [...hosts.values()].filter((h) => !h.down).map((h) => h.endpoint.request('system.beforeQuit', null).catch(ignore));
      await Promise.race([Promise.all(asks), late]);
    },
    stopAll() {
      for (const host of [...hosts.values()]) stop(host, new CoreError('HostGone', 'ядро выгружено'));
    },
  };
}
