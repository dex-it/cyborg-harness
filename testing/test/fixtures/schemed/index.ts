import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('schemed.greeting', () => {
      const greeting = ctx.config?.get().greeting;
      return typeof greeting === 'string' ? greeting : 'привет';
    });
    ctx.commands.register('schemed.counter', () => {
      const counter = ctx.state?.get().counter;
      return typeof counter === 'number' ? counter : 0;
    });
  },
};

export default plugin;
