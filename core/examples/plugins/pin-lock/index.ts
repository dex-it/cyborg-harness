import type { PluginModule } from '../../../src/index.ts';

const plugin: PluginModule = {
  config: {
    defaults: { minutes: 10, pin: '0000' },
    migrate: (from, data) => (from === 1 ? { minutes: data.idle, pin: data.code } : data),
  },
  activate(ctx) {
    let locked = false;
    if (!ctx.config) throw new Error('раздел config объявлен в манифесте, но не пришёл');
    const { minutes, pin } = ctx.config.get();
    ctx.log(`блокирую после ${String(minutes)} мин простоя`);

    ctx.contracts.provide('cyborg.lock', '1.0', { isLocked: async () => locked });
    ctx.commands.register('pin-lock.lock', () => {
      locked = true;
      return 'заблокировано';
    });
    ctx.commands.register('pin-lock.unlock', (entered) => {
      if (typeof entered !== 'string' || entered !== pin) return 'неверный пин';
      locked = false;
      return 'разблокировано';
    });
  },
};

export default plugin;
