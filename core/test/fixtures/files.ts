import type { PluginModule } from '../../src/plugin.ts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('test.files', '1.0', {
      read: async (path: string) => `data:${path}`,
      fail: async () => {
        throw new Error('нет файла');
      },
      leak: async () => ({ cb: () => 0 }),
      hang: () => {
        for (;;);
      },
      crash: () => process.exit(3),
    });
  },
};
export default plugin;
