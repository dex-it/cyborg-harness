import type { PluginModule } from '../../../src/index.ts';

interface Flaky {
  pid: number;
}

const plugin: PluginModule = {
  activate(ctx) {
    const flaky = () => ctx.contracts.get<Flaky>('demo.flaky');
    const describe = () => (flaky() ? `flaky есть, процесс ${flaky()!.pid}` : 'flaky нет');
    ctx.contracts.onChange('demo.flaky', () => ctx.log(`изменение: ${describe()}`));
    ctx.commands.register('monitor.status', () => `monitor в процессе ${process.pid}: ${describe()}`);
  },
};

export default plugin;
