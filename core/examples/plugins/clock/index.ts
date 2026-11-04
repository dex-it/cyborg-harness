import type { PluginModule } from '../../../src/index.ts';

// Нарочно испытывает границу хоста: синхронный метод, колбэк в аргументе, функция в ответе команды.
const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.clock', '1.0', {
      nowSync: () => Date.now(),
      now: async () => new Date(0),
      onTick: async (callback: () => void) => callback,
    });
    ctx.commands.register('clock.now', () => ({ at: new Date(0), format: () => 'x' }));
  },
};

export default plugin;
