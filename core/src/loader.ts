import { createActivation } from './activation.ts';
import { createCommands } from './commands.ts';
import { createContext } from './context-build.ts';
import { createContractCalls } from './contract-calls.ts';
import { createBridge } from './host-bridge.ts';
import { createHostPool } from './host-pool.ts';
import { createIdleWatch } from './idle-watch.ts';
import { buildKernel } from './kernel-api.ts';
import type { KernelContext, Parts } from './kernel-context.ts';
import type { Kernel, LoadOptions } from './kernel-types.ts';
import { createLifecycle } from './lifecycle.ts';
import { createMenus } from './menus.ts';
import { createKeyRegistry } from './keybindings.ts';
import { createOsRequests } from './os-requests.ts';
import { createPluginLog } from './plugin-log.ts';
import { createSections } from './sections.ts';
import { createViewsState } from './views-state.ts';

export type { DisableOptions, DisablePreview, EnabledChange, JournalEntry, Kernel, Keybinding, KeyPress, LoadOptions, UninstallReport, UserKeybinding, WatchdogOptions } from './kernel-types.ts';

/** Части ядра, у каждой своё состояние; зовут друг друга через `ctx.parts` в момент вызова. Раскладка по файлам - в SAD, раздел 3.2. */
const createParts = (ctx: KernelContext): Parts => ({
  pool: createHostPool(ctx),
  lifecycle: createLifecycle(ctx),
  activation: createActivation(ctx),
  contracts: createContractCalls(ctx),
  commands: createCommands(ctx),
  keyRegistry: createKeyRegistry(ctx),
  menus: createMenus(ctx),
  idleWatch: createIdleWatch(ctx),
  sections: createSections(ctx),
  osRequests: createOsRequests(ctx),
  views: createViewsState(ctx),
  logs: createPluginLog(ctx),
  bridge: createBridge(ctx),
});

export async function load(options: LoadOptions): Promise<Kernel> {
  const ctx = await createContext(options, createParts);
  await ctx.parts.activation.start();
  await ctx.parts.menus.start();
  return buildKernel(ctx);
}
