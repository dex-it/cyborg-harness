import type { PluginModule } from '@cyborg-harness/contracts';

/** Встроенный потребитель пробы (TR-01) в своём хосте: контракт `trust.vault` до него доходит, как бы ядро ни фильтровало рассылки. */
const friend: PluginModule = {
  activate(ctx) {
    ctx.commands.register('friend.read', async () => {
      const vault = ctx.contracts.get('trust.vault', 1);
      return vault === undefined ? null : await vault.read();
    });
    ctx.commands.register('friend.pid', () => process.pid);
    return undefined;
  },
};

export default friend;
