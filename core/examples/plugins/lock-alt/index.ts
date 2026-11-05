import type { PluginModule } from '@cyborg/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.lock', '1.2', { isLocked: async () => false });
    ctx.log('вторая блокировка экрана');
  },
};

export default plugin;
