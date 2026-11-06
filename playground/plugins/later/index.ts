import type { PluginModule } from '@cyborg-harness/contracts';

// Ленивый плагин: ядро поднимает его по первой команде, а не при старте окна.
const later: PluginModule = {
  activate(ctx) {
    ctx.log(`проснулся в процессе ${process.pid}`);
    ctx.commands.register('later.hello', () => ctx.log('привет по команде'));
    ctx.window.onFocusChange((focused) => ctx.log(focused ? 'окно в фокусе' : 'окно без фокуса'));
    ctx.system.onSuspend(() => ctx.log('ОС засыпает'));
    ctx.system.onResume(() => ctx.log('ОС проснулась'));
    ctx.system.onScreenLock(() => ctx.log('экран заблокирован'));
    ctx.system.onIdle(300, () => ctx.log('пользователь не трогал машину 5 минут'));
    ctx.system.onBeforeQuit(() => ctx.log('приложение закрывается'));
    return undefined;
  },
};

export default later;
