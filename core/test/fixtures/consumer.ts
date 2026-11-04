import type { PluginModule } from '../../src/plugin.ts';

type Untyped = Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>;

const plugin: PluginModule = {
  activate(ctx) {
    let changes = 0;
    ctx.contracts.onChange('test.files', () => changes++);
    const files = () => ctx.contracts.get('test.files', 1);
    ctx.commands.register('consumer.call', (member, ...args) => {
      if (typeof member !== 'string') throw new Error('member не строка');
      const api = files();
      if (!api) throw new Error('files нет');
      // Тест гоняет через границу члены по имени из аргумента команды, мимо типа контракта.
      const call = (api as Untyped)[member];
      if (!call) throw new Error(`у files нет ${member}`);
      return call(...args);
    });
    ctx.commands.register('consumer.state', () => ({ changes, files: files() !== undefined, pid: process.pid }));
  },
};
export default plugin;
