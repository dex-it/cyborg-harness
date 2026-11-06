import type { PluginModule } from '../../src/plugin.ts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('calm.echo', (value) => value);
    ctx.commands.register('calm.pid', () => process.pid);
  },
};
export default plugin;
