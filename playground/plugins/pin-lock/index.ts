import type { PluginModule, UiLock } from '@cyborg/contracts';

// Демо: PIN зашит, настоящий плагин сверял бы его с хранилищем ОС.
const PIN = '0000';

const pinLock: PluginModule = {
  activate(ctx) {
    const ui = ctx.os.ui;
    if (!ui) throw new Error('нет права ui.lock');
    let held: UiLock | undefined;
    ctx.commands.register('pin-lock.lock', async () => {
      held ??= await ui.lock({ hideNotifications: true });
      ctx.log('окно закрыто');
    });
    ctx.commands.register('pin-lock.unlock', async (pin) => {
      if (pin !== PIN) {
        ctx.log('неверный PIN');
        return false;
      }
      await held?.release();
      held = undefined;
      ctx.log('окно открыто');
      return true;
    });
    return Promise.resolve(undefined);
  },
};

export default pinLock;
