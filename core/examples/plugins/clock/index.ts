import type { PluginModule } from '@cyborg-harness/contracts';

// Нарочно испытывает границу хоста: синхронный метод, подписка с колбэком, функция в ответе команды.
const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.clock', '1.0', {
      nowSync: () => Date.now(),
      now: async () => new Date(0),
      onTick(callback) {
        let tick = 0;
        const timer = setInterval(() => callback(++tick), 5);
        return { dispose: () => clearInterval(timer) };
      },
    });
    ctx.commands.register('clock.now', () => ({ at: new Date(0), format: () => 'x' }));
  },
};

export default plugin;
