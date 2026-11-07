import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.lock', '1.2', { isLocked: async () => false });
    ctx.log('вторая блокировка экрана');
  },
};

export default plugin;
