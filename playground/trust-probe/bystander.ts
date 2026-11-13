import type { PluginModule } from '@cyborg-harness/contracts';
import { VAULT_TOKEN } from './contracts.ts';

/** Встроенный сосед пробы (TR-01): поставщик `trust.vault`; `bystander.reprovide` отдаёт контракт заново, и ядро снова рассылает его описание хостам. */
const bystander: PluginModule = {
  activate(ctx) {
    const impl = { token: VAULT_TOKEN, read: async () => VAULT_TOKEN };
    let handle = ctx.contracts.provide('trust.vault', '1.0', impl);
    ctx.commands.register('bystander.reprovide', () => {
      handle.dispose();
      handle = ctx.contracts.provide('trust.vault', '1.0', impl);
    });
    ctx.commands.register('bystander.pid', () => process.pid);
    return undefined;
  },
};

export default bystander;
