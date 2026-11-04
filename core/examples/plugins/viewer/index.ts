import type { PluginModule } from '../../../src/index.ts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.tab', '1.1', {
      kind: 'просмотр',
      open: async (path: string) => `просмотр: ${path}`,
    });
  },
};

export default plugin;
