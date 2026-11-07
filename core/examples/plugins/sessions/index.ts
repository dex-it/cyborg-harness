import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  state: { defaults: { open: [] } },
  activate(ctx) {
    const projects = ctx.contracts.get('demo.projects', 1);
    const state = ctx.state;
    if (!projects || !state) throw new Error('demo.projects и раздел state объявлены, но не пришли');
    const lock = () => ctx.contracts.get('demo.lock', 1);
    ctx.log(lock() ? 'блокировка экрана есть, учитываю её' : 'блокировки экрана нет, работаю без неё');

    ctx.commands.register('sessions.restore', async () => {
      if (await lock()?.isLocked()) return 'окно заблокировано, восстановление отложено';
      const project = await projects.current();
      const open = state.get().open as string[];
      await state.set('workspace', { open: [] });
      return `в проекте «${project?.name ?? 'без проекта'}» восстановлены: ${open.join(', ') || 'нечего'}`;
    });
  },
};

export default plugin;
