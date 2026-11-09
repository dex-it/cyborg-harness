import { CoreError } from './errors.ts';
import type { BridgeEnd, Commands, KernelContext } from './kernel-context.ts';
import { checkArgs, type CommandSpec } from './manifest.ts';
import { guardedValue } from './via-contract.ts';
import { KERNEL_COMMANDS } from './window-layer.ts';

const isKernelCommand = (name: string): boolean => (Object.values(KERNEL_COMMANDS) as string[]).includes(name);

/** Реестр команд: кто какую зарегистрировал и запуск команды у её владельца, будя ленивого. */
export function createCommands(ctx: KernelContext): Commands {
  const owners = new Map<string, string>();

  /** Чужой главной части команду открывает исполнитель (`callers: "plugins"`); отказ пишется вызывающему, обработчик не вызывается. */
  function open(caller: string, executor: string, command: string): void {
    if (caller === executor || ctx.manifestOf(executor).commands[command]?.callers === 'plugins') return;
    const detail = `${command} - ${executor} не открыл её другим плагинам (callers: "user")`;
    ctx.record({ pluginId: caller, kind: 'denied', method: command, detail, reason: 'command-callers' });
    throw new CoreError('PermissionDenied', `${command}: ${executor} не открыл команду другим плагинам`);
  }

  /** Право вызывающего на аргументы чужой команды, как их объявил исполнитель (`guard`); выполнит команду исполнитель по своим правам. */
  async function guard(caller: string, command: string, spec: CommandSpec, args: readonly unknown[]): Promise<void> {
    for (const g of spec.guard ?? []) await ctx.gateway.checkFor(ctx.manifestOf(caller), command, g.right, guardedValue(args, g, command));
  }

  /** Команду зовут от имени плагина `only` (его вид, клик по его уведомлению): исполняет её только он. Имя в манифесте ничего не решает: `a` и `a.b` могут оба его объявить. */
  function onlyOwner(only: string | undefined, executor: string, command: string): void {
    if (only === undefined || only === executor) return;
    throw new CoreError('PermissionDenied', `${command}: команда плагина ${executor}, а не ${only}`);
  }

  /** `caller` - плагин, чья главная часть зовёт команду, его назвал канал хоста; без него зовёт пользователь: палитра, клавиши, меню. `only` - плагин, от имени которого зовёт его вид. */
  async function execute(command: string, args: unknown[], caller?: string, only?: string): Promise<unknown> {
    const { activation, pool } = ctx.parts;
    if (only !== undefined && isKernelCommand(command)) throw new CoreError('PermissionDenied', `${command}: команда ядра, а не плагина ${only}`);
    if (command === KERNEL_COMMANDS.revealWorkspace) return ctx.gateway.revealWorkspace();
    const declares = (id: string) => Object.hasOwn(ctx.manifestOf(id).commands, command);
    if (!owners.has(command)) {
      const sleeper = [...activation.waiting].find(declares);
      // Отказанный не будит спящего исполнителя: отказ не должен запускать чужой код.
      const known = sleeper ?? [...activation.activating.keys()].find(declares);
      if (caller !== undefined && known !== undefined) open(caller, known, command);
      if (known !== undefined) onlyOwner(only, known, command);
      if (sleeper !== undefined) await activation.wake(sleeper);
      else await [...activation.activating].find(([id]) => declares(id))?.[1];
    }
    const owner = owners.get(command);
    if (!owner) throw new CoreError('CommandNotFound', `команды ${command} нет`);
    const spec = ctx.manifestOf(owner).commands[command];
    if (!spec) throw new CoreError('CommandNotFound', `команда ${command} не объявлена у ${owner}`);
    onlyOwner(only, owner, command);
    if (caller !== undefined) open(caller, owner, command);
    checkArgs(command, spec, args);
    if (caller !== undefined && caller !== owner) await guard(caller, command, spec, args);
    return pool.call(pool.live(owner), owner, 'command', { pluginId: owner, name: command, args });
  }

  const run = (command: string, ...args: unknown[]) => execute(command, args);
  const runOwn = (pluginId: string, command: string, args: unknown[]) => execute(command, args, undefined, pluginId);

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
    onRequest('run', { caller: 'string', name: 'string', args: 'array' }, (p) => {
      const caller = mine(p.caller).id;
      if (isKernelCommand(p.name)) throw new CoreError('PermissionDenied', `${p.name}: команду ядра зовёт приложение, а не плагин`);
      return execute(p.name, p.args, caller);
    });
  }

  return {
    owners,
    attach,
    run,
    runOwn,
    dropFor(pluginId) {
      for (const [name, owner] of [...owners]) if (owner === pluginId) owners.delete(name);
    },
  };
}
