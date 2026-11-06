import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.tab', '1.1', {
      kind: 'просмотр',
      icon: '👁 ',
      open: async (path: string) => `просмотр: ${path}`,
    });
  },
};

export default plugin;
