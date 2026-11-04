import type { PluginModule } from '../../../src/index.ts';

interface Projects {
  current(): Promise<{ name: string } | undefined>;
}

interface Lock {
  isLocked(): Promise<boolean>;
}

const plugin: PluginModule = {
  state: { defaults: { open: [] } },
  activate(ctx) {
    const projects = ctx.contracts.get<Projects>('cyborg.projects')!;
    const lock = () => ctx.contracts.get<Lock>('cyborg.lock');
    ctx.log(lock() ? 'блокировка экрана есть, учитываю её' : 'блокировки экрана нет, работаю без неё');

    ctx.commands.register('sessions.restore', async () => {
      if (await lock()?.isLocked()) return 'окно заблокировано, восстановление отложено';
      const project = await projects.current();
      const open = ctx.state!.get().open as string[];
      await ctx.state!.set('workspace', { open: [] });
      return `в проекте «${project?.name ?? 'без проекта'}» восстановлены: ${open.join(', ') || 'нечего'}`;
    });
  },
};

export default plugin;
