import { CoreError, errorMessage } from './errors.ts';
import type { Bridge, BridgeEnd, Host, KernelContext } from './kernel-context.ts';
import type { PluginManifest } from './manifest.ts';
import type { OpHandle, OpStart } from './trace.ts';
import { isRecord, parseWire, type Parsed, type WireSpec } from './wire.ts';

/** Плагин, которого называет сообщение хоста (`caller`, иначе `pluginId`): его слова, не проверенные каналом, - запись сохраняет и поддельное имя. */
function claimed(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const name = typeof params.caller === 'string' ? params.caller : params.pluginId;
  return typeof name === 'string' ? name : undefined;
}

/** Канал хоста с ядром: каждая часть сама регистрирует свои сообщения, здесь - проверка отправителя и сообщения о состоянии хоста. */
export function createBridge(ctx: KernelContext): Bridge {
  function attach(host: Host): void {
    const { endpoint } = host;
    const mine = (pluginId: string): PluginManifest => {
      const m = ctx.byId.get(pluginId);
      if (!m || host.down || ctx.hostOf(pluginId) !== host.id) throw new CoreError('Unavailable', `${pluginId} не в этом хосте`);
      return m;
    };
    // Общий хост после disable не гасится, пока в нём есть соседи: код снятого плагина ещё жив и пересоздал бы стёртое.
    const live = (pluginId: string): PluginManifest => {
      const m = mine(pluginId);
      if (!ctx.active.includes(m.id) && !ctx.parts.activation.activating.has(m.id)) throw new CoreError('Unavailable', `${pluginId} не активен`);
      return m;
    };
    // Сообщение хоста - операция трассы на границе Г1 (FR-CH-4001): запись одна, обработчик дописывает в неё адресата и пройденные границы.
    const start = (method: string, raw: unknown): OpStart => {
      const name = claimed(raw);
      return { caller: name === undefined ? `host:${host.id}` : `plugin:${name}`, hostId: host.id, target: `host:${method}`, boundaries: ['host'] };
    };
    const onRequest = <const S extends WireSpec>(method: string, spec: S, handler: (p: Parsed<S>, signal: AbortSignal, op: OpHandle) => unknown) => {
      endpoint.handle(method, (raw: unknown, signal: AbortSignal) =>
        ctx.trace.run(start(method, raw), (op) => {
          const params = parseWire(method, raw, spec);
          op.args(isRecord(params) && 'args' in params ? params.args : params);
          return handler(params, signal, op);
        }),
      );
    };
    // У уведомления нет отправителя, которому вернуть отказ: без записи в лог подделка прошла бы молча.
    const onNote = <const S extends WireSpec>(method: string, spec: S, handler: (p: Parsed<S>) => void) => {
      endpoint.handle(method, (raw: unknown) => {
        try {
          ctx.trace.note(start(method, raw), () => handler(parseWire(method, raw, spec)));
        } catch (error) {
          ctx.parts.logs.hostLine(host.id, `ядро отказало: ${errorMessage(error)}`, 'warn');
        }
      });
    };
    const end: BridgeEnd = { host, mine, live, onRequest, onNote };

    const { contracts, commands, keyRegistry, idleWatch, sections, osRequests, logs, viewChannels } = ctx.parts;
    contracts.attach(end);
    commands.attach(end);
    keyRegistry.attach(end);
    idleWatch.attach(end);
    sections.attach(end);
    osRequests.attach(end);
    viewChannels.attach(end);
    logs.attach(end);
    attachHostState(ctx, end);
  }

  return { attach };
}

/** Сообщения хоста о том, чей код выполняется, и о сбоях: из них сторож называет виновника. */
function attachHostState(ctx: KernelContext, { host, mine, onNote }: BridgeEnd): void {
  onNote('running', { pluginId: 'string' }, (p) => {
    host.running = mine(p.pluginId).id;
    host.notes++;
  });
  onNote('exiting', { pluginId: 'string' }, (p) => {
    host.exiting = mine(p.pluginId).id;
  });
  onNote('rejected', { pluginId: 'string', error: 'string' }, (p) => {
    const { lifecycle } = ctx.parts;
    const id = mine(p.pluginId).id;
    // Хвост отклонений уже выключенного плагина, пока его снимают, - не новые сбои.
    if (lifecycle.switchedOff.has(id) || ctx.unloading) return;
    ctx.record({ pluginId: id, kind: 'unhandled-rejection', error: p.error });
    if (lifecycle.strike(id)) lifecycle.unloadSwitchedOff(id);
  });
}
