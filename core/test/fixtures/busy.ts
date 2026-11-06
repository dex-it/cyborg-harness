import type { PluginModule } from '../../src/plugin.ts';

const hang = (): void => {
  for (;;);
};

const plugin: PluginModule = {
  activate(ctx) {
    let onFocus = false;
    ctx.window.onFocusChange(() => {
      if (onFocus) hang();
    });
    ctx.commands.register('busy.timer', () => void setTimeout(hang, 0));
    ctx.commands.register('busy.late', () => void setTimeout(hang, 200));
    ctx.commands.register('busy.exit', () => void setTimeout(() => process.exit(3), 0));
    ctx.commands.register('busy.focus', () => void (onFocus = true));
    // Ответ чужой команды приходит после того, как хост успел выполнить код соседа.
    ctx.commands.register('busy.after', () => void ctx.commands.run('calm.echo', 1).then(hang));
  },
};
export default plugin;
