import { splitSignal, withSignal } from './cancel.ts';
import { CoreError } from './errors.ts';
import type { BridgeEnd, Commands, KernelContext } from './kernel-context.ts';
import { checkArgs } from './manifest.ts';
import { KERNEL_COMMANDS } from './window-layer.ts';

const isKernelCommand = (name: string): boolean => (Object.values(KERNEL_COMMANDS) as string[]).includes(name);

/** Реестр команд: кто какую зарегистрировал и запуск команды у её владельца, будя ленивого. */
export function createCommands(ctx: KernelContext): Commands {
  const owners = new Map<string, string>();

  async function run(command: string, ...given: unknown[]): Promise<unknown> {
    const { activation, pool } = ctx.parts;
    // Сигнал отмены - последний аргумент: схема манифеста его не видит, владельцу он едет меткой (cancel.ts).
    const { args: wire, signal } = splitSignal(given);
    const args = signal ? wire.slice(0, -1) : wire;
    if (command === KERNEL_COMMANDS.revealWorkspace) return ctx.gateway.revealWorkspace();
    const declares = (id: string) => Object.hasOwn(ctx.manifestOf(id).commands, command);
    if (!owners.has(command)) {
      const sleeper = [...activation.waiting].find(declares);
      if (sleeper !== undefined) await activation.wake(sleeper);
      else await [...activation.activating].find(([id]) => declares(id))?.[1];
    }
    const owner = owners.get(command);
    if (!owner) throw new CoreError('CommandNotFound', `команды ${command} нет`);
    const spec = ctx.manifestOf(owner).commands[command];
    if (!spec) throw new CoreError('CommandNotFound', `команда ${command} не объявлена у ${owner}`);
    checkArgs(command, spec, args);
    return pool.call(pool.live(owner), owner, 'command', { pluginId: owner, name: command, args: wire }, undefined, signal);
  }

  function attach({ mine, onRequest, onNote }: BridgeEnd): void {
    onNote('register', { pluginId: 'string', name: 'string' }, (p) => {
      if (!Object.hasOwn(mine(p.pluginId).commands, p.name)) throw new CoreError('NotDeclared', `${p.pluginId}: команда ${p.name} не объявлена в commands`);
      const owner = owners.get(p.name);
      if (owner !== undefined && owner !== p.pluginId) throw new CoreError('CommandConflict', `${p.pluginId}: команда ${p.name} уже у ${owner}`);
      owners.set(p.name, p.pluginId);
    });
    onNote('unregister', { pluginId: 'string', name: 'string' }, (p) => {
      mine(p.pluginId);
      if (owners.get(p.name) === p.pluginId) owners.delete(p.name);
    });
    onRequest('run', { name: 'string', args: 'array' }, (p, signal) => {
      if (isKernelCommand(p.name)) throw new CoreError('PermissionDenied', `${p.name}: команду ядра зовёт приложение, а не плагин`);
      return run(p.name, ...withSignal(p.args, signal));
    });
  }

  return {
    owners,
    attach,
    run,
    dropFor(pluginId) {
      for (const [name, owner] of [...owners]) if (owner === pluginId) owners.delete(name);
    },
  };
}
