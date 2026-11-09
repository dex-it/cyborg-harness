import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('echo.say', (text) => `echo:${String(text)}`);
  },
};

export default plugin;
