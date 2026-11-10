import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('schemed.greeting', () => String(ctx.config?.get().greeting ?? 'привет'));
    ctx.commands.register('schemed.counter', () => Number(ctx.state?.get().counter ?? 0));
  },
};

export default plugin;
