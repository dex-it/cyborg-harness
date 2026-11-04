import type { PluginModule } from '../../../src/index.ts';

const plugin: PluginModule = {
  config: {
    defaults: { minutes: 10, pin: '0000' },
    migrate: (from, data) => (from === 1 ? { minutes: data.idle, pin: data.code } : data),
  },
  activate(ctx) {
    let locked = false;
    const { minutes, pin } = ctx.config!.get();
    ctx.log(`блокирую после ${minutes} мин простоя`);

    ctx.contracts.provide('cyborg.lock', '1.0', { isLocked: async () => locked });
    ctx.commands.register('pin-lock.lock', () => {
      locked = true;
      return 'заблокировано';
    });
    ctx.commands.register('pin-lock.unlock', (entered) => {
      if (entered !== pin) return 'неверный пин';
      locked = false;
      return 'разблокировано';
    });
  },
};

export default plugin;
