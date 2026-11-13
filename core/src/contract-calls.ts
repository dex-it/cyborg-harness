import { checkCall, mayUse } from './call-check.ts';
import { splitSignal } from './cancel.ts';
import type { Disposable } from './disposable.ts';
import { CoreError } from './errors.ts';
import { cancelError } from './rpc.ts';
import { CALLBACK, handleKey, marker, SUBSCRIPTION, type ContractDescriptor } from './host-runtime.ts';
import type { BridgeEnd, ContractCalls, Host, KernelContext, Subscription } from './kernel-context.ts';
import type { OpHandle } from './trace.ts';

/** Участник записи трассы: вызов члена контракта по мажорной версии (так его называет и `ctx.contracts.get`). */
const memberOf = (contract: string, version: string, member: string): string => `${contract}@${version.split('.')[0] ?? version}#${member}`;

/** Контракты между хостами: что предоставил каждый плагин, подписки через границу и сам вызов члена. */
export function createContractCalls(ctx: KernelContext): ContractCalls {
  const { registry, limits, callTimeout } = ctx;
  const descriptors = new Map<string, ContractDescriptor[]>();
  const provided = new Map<string, Disposable>();
  const subscriptions = new Map<number, Subscription>();
  let subscriptionSeq = 0;

  // Минимум данных (TR-03): описание поставщика с его `data` уходит только в хосты, где есть потребитель контракта (requires, optional, consumes).
  // Состав плагинов хоста задан при запуске ядра (граф не меняется), поэтому таблица строится один раз; enable, disable и перезапуск хоста её не меняют.
  let wanted: Map<string, Set<string>> | undefined;
  const hostWants = (hostId: string, contract: string): boolean => {
    if (!wanted) {
      wanted = new Map();
      for (const id of ctx.graph.order) {
        const hostOf = ctx.hostOf(id);
        if (hostOf === undefined) continue;
        const manifest = ctx.manifestOf(id);
        const set = wanted.get(hostOf) ?? new Set<string>();
        for (const declared of [manifest.requires, manifest.optional, manifest.consumes]) for (const name of Object.keys(declared)) set.add(name);
        wanted.set(hostOf, set);
      }
    }
    return wanted.get(hostId)?.has(contract) ?? false;
  };

  const broadcast = (contract: string) => {
    for (const host of ctx.parts.pool.hosts.values()) if (hostWants(host.id, contract)) host.endpoint.notify('contracts', { contract, providers: descriptors.get(contract) ?? [] });
  };

  function dropProvided(pluginId: string, contract: string, version: string): void {
    const key = handleKey(pluginId, contract, version);
    const disposable = provided.get(key);
    if (!disposable) return;
    provided.delete(key);
    disposable.dispose();
    descriptors.set(contract, (descriptors.get(contract) ?? []).filter((d) => d.pluginId !== pluginId || d.version !== version));
    broadcast(contract);
  }

  function release(subscription: number): void {
    const s = subscriptions.get(subscription);
    if (!s) return;
    subscriptions.delete(subscription);
    s.providerHost.endpoint.notify('release', { subscription });
    s.consumerHost.endpoint.notify('forget', { ids: s.callbacks.filter((id) => id !== undefined) });
  }

  /** Вызов члена контракта из хоста `host` от имени `p.caller`; колбэки в аргументах становятся подпиской. `signal` - отмена: доходит до хоста поставщика, подписка отменённого вызова снимается. */
  async function invoke(
    host: Host,
    p: { readonly caller: string; readonly pluginId: string; readonly contract: string; readonly version: string; readonly member: string; readonly args: readonly unknown[] },
    signal: AbortSignal | undefined,
    op: OpHandle,
  ): Promise<unknown> {
    // Член контракта - Г3; к хосту поставщика операция выходит (Г1 ещё раз) в `invokeChecked`, когда проверки пройдены.
    op.enter('contract');
    op.target(`contract:${memberOf(p.contract, p.version, p.member)}`, `plugin:${p.pluginId}`);
    try {
      return await invokeChecked(host, p, signal, op);
    } finally {
      // Вызов мог изменить состояние поставщика, которое читает пункт меню.
      ctx.parts.menus.touch(p.pluginId);
    }
  }

  async function invokeChecked(
    host: Host,
    p: { readonly caller: string; readonly pluginId: string; readonly contract: string; readonly version: string; readonly member: string; readonly args: readonly unknown[] },
    signal: AbortSignal | undefined,
    op: OpHandle,
  ): Promise<unknown> {
    const { pool } = ctx.parts;
    const d = descriptors.get(p.contract)?.find((x) => x.pluginId === p.pluginId && x.version === p.version);
    if (!d?.methods.includes(p.member)) throw new CoreError('Unavailable', `${p.contract}@${p.version}.${p.member} у ${p.pluginId} нет`);
    if (!mayUse(ctx, p.caller, p.pluginId, p.contract, p.version)) {
      throw new CoreError('NotDeclared', `${p.caller}: ${p.contract}@${p.version} от ${p.pluginId} не объявлен потребляемым`);
    }
    const { pluginId, contract, version, member } = p;
    await checkCall(ctx, p.caller, pluginId, contract, member, p.args);
    const target = pool.live(pluginId);
    const callbacks = p.args.map((arg) => marker(arg, CALLBACK));
    if (!callbacks.some((id) => id !== undefined)) {
      op.enter('host');
      return pool.call(target, pluginId, 'call', { pluginId, contract, version, member, args: p.args }, callTimeout, signal);
    }
    if (callbacks.some((id) => id !== undefined && typeof id !== 'string')) throw new CoreError('Invalid', 'invoke: номер колбэка не строка');

    const held = [...subscriptions.values()].filter((s) => s.consumer === p.caller).length;
    if (held >= limits.subscriptions) throw new CoreError('Invalid', `${p.caller}: подписок через контракты больше ${String(limits.subscriptions)} - снимите прежние`);
    const subscription = ++subscriptionSeq;
    subscriptions.set(subscription, { consumer: p.caller, consumerHost: host, provider: pluginId, providerHost: target, callbacks: callbacks as (string | undefined)[], of: memberOf(contract, version, member) });
    op.enter('host');
    const args = p.args.map((arg, i) => (callbacks[i] === undefined ? arg : { [CALLBACK]: i }));
    // Ответ поставщика, обогнавший отмену, подписку уже открыл: снимаем её, вызывающему она не достанется.
    const drop = (result: unknown) => {
      if (marker(result, SUBSCRIPTION) === subscription) target.endpoint.notify('release', { subscription });
      subscriptions.delete(subscription);
    };
    return pool.call(target, pluginId, 'call', { pluginId, contract, version, member, args, subscription }, callTimeout, signal, drop).then(
      (result) => {
        // Потребителя могли снять, пока поставщик отвечал, или вызов отменили вместе с ответом: тогда подписку закрывает ядро.
        if (!signal?.aborted && marker(result, SUBSCRIPTION) === subscription && subscriptions.has(subscription)) return result;
        drop(result);
        if (signal?.aborted) throw cancelError(signal);
        return result;
      },
      (error: unknown) => {
        subscriptions.delete(subscription);
        throw error;
      },
    );
  }

  function attach({ host, mine, onRequest, onNote }: BridgeEnd): void {
    const KEY = { pluginId: 'string', contract: 'string', version: 'string' } as const;

    onNote('provide', { ...KEY, data: 'record', methods: 'strings' }, (d) => {
      if (!mine(d.pluginId).provides[d.contract]?.includes(d.version)) {
        throw new CoreError('NotDeclared', `${d.pluginId}: ${d.contract}@${d.version} не объявлен в provides`);
      }
      const descriptor: ContractDescriptor = { pluginId: d.pluginId, contract: d.contract, version: d.version, data: d.data, methods: d.methods };
      const impl: Record<string, unknown> = { ...descriptor.data };
      for (const member of descriptor.methods) {
        impl[member] = (...given: unknown[]) => {
          const { args, signal } = splitSignal(given);
          return ctx.parts.pool.call(host, d.pluginId, 'call', { pluginId: d.pluginId, contract: d.contract, version: d.version, member, args }, callTimeout, signal);
        };
      }
      provided.set(handleKey(d.pluginId, d.contract, d.version), registry.provide(d.pluginId, d.contract, d.version, impl));
      descriptors.set(d.contract, [...(descriptors.get(d.contract) ?? []), descriptor]);
      broadcast(d.contract);
    });
    onNote('unprovide', KEY, (p) => {
      mine(p.pluginId);
      dropProvided(p.pluginId, p.contract, p.version);
    });
    onRequest('invoke', { ...KEY, caller: 'string', member: 'string', args: 'array' }, async (p, signal, op) => {
      mine(p.caller);
      return invoke(host, p, signal, op);
    });
    onNote('emit', { subscription: 'number', index: 'number', args: 'array' }, (p) => {
      const s = subscriptions.get(p.subscription);
      if (!s) return;
      // Событие контракта - операция Г3: поставщик -> ядро -> потребитель; доставленный колбэк и всё, что он вызовет, идёт в цепочке события.
      const start = { caller: `plugin:${s.provider}`, hostId: host.id, target: `event:${s.of}`, boundaries: ['host'] } as const;
      ctx.trace.run(start, (op) => {
        op.target(`event:${s.of}`, `plugin:${s.consumer}`);
        op.args(p.args);
        op.enter('contract');
        if (s.providerHost !== host) throw new CoreError('Unavailable', `подписка ${p.subscription} не из этого хоста`);
        const id = s.callbacks[p.index];
        if (id === undefined) return;
        s.consumerHost.endpoint.notify('callback', { id, args: p.args });
        op.enter('host');
      });
    });
    onNote('release', { caller: 'string', subscription: 'number' }, (p) => {
      mine(p.caller);
      const s = subscriptions.get(p.subscription);
      if (!s) return;
      if (s.consumerHost !== host || s.consumer !== p.caller) throw new CoreError('Unavailable', `подписка ${p.subscription} не у ${p.caller}`);
      release(p.subscription);
    });
  }

  return {
    attach,
    announce(host) {
      for (const contract of descriptors.keys()) if (hostWants(host.id, contract)) host.endpoint.notify('contracts', { contract, providers: descriptors.get(contract) });
    },
    dropFor(pluginId) {
      for (const [n, s] of [...subscriptions]) if (s.consumer === pluginId || s.provider === pluginId) release(n);
      const given = [...descriptors.values()].flat().filter((d) => d.pluginId === pluginId);
      for (const d of given) dropProvided(d.pluginId, d.contract, d.version);
    },
    async callAs(caller, contract, major, member, args, op) {
      op?.enter('contract');
      const impl = registry.get(caller, contract, major);
      if (impl === undefined) throw new CoreError('Unavailable', `${contract}: поставщика сейчас нет`);
      const fn = Object.hasOwn(impl, member) ? impl[member] : undefined;
      if (typeof fn !== 'function') throw new CoreError('Invalid', `${contract}.${member}: не метод контракта`);
      const provider = ctx.graph.bindings.get(caller)?.get(contract);
      if (provider === undefined) throw new CoreError('Unavailable', `${contract}: поставщика сейчас нет`);
      op?.target(`contract:${memberOf(contract, String(major), member)}`, `plugin:${provider}`);
      await checkCall(ctx, caller, provider, contract, member, args);
      op?.enter('host');
      return (fn as (...xs: unknown[]) => unknown).apply(impl, [...args]);
    },
  };
}
