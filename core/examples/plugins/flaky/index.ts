import type { PluginModule } from '@cyborg/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.log(`поднят в процессе ${process.pid}`);
    ctx.contracts.provide('demo.flaky', '1.0', { pid: process.pid });
    ctx.commands.register('flaky.ping', () => `pong из процесса ${process.pid}`);
    ctx.commands.register('flaky.hang', () => {
      for (;;);
    });
    ctx.commands.register('flaky.crash', () => process.exit(7));
  },
};

export default plugin;
