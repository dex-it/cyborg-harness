import type { PluginModule } from '@cyborg/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    const flaky = () => ctx.contracts.get('demo.flaky', 1);
    const describe = () => {
      const current = flaky();
      return current ? `flaky есть, процесс ${current.pid}` : 'flaky нет';
    };
    ctx.contracts.onChange('demo.flaky', () => ctx.log(`изменение: ${describe()}`));
    ctx.commands.register('monitor.status', () => `monitor в процессе ${process.pid}: ${describe()}`);
  },
};

export default plugin;
