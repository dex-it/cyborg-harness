import type { PluginModule } from '../../src/plugin.ts';

type Files = Record<string, (...args: unknown[]) => Promise<unknown>>;

const plugin: PluginModule = {
  activate(ctx) {
    let changes = 0;
    ctx.contracts.onChange('cyborg.files', () => changes++);
    const files = () => ctx.contracts.get<Files>('cyborg.files');
    ctx.commands.register('consumer.call', (member: string, ...args: unknown[]) => {
      const api = files();
      if (!api) throw new Error('files нет');
      return api[member](...args);
    });
    ctx.commands.register('consumer.state', () => ({ changes, files: files() !== undefined, pid: process.pid }));
  },
};
export default plugin;
