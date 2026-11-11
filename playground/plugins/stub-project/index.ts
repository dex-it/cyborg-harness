import type { PluginModule } from '@cyborg-harness/contracts';

// Заглушка выбора проекта и переключателя уведомлений Cyborg (PL-08). Состояние держит плагин, а пункты меню окна и заголовок окна читают его
// через контракт и `ctx.window.setTitle`: ядро и приложение плагин по имени не знают.
const PROJECTS = ['Альфа', 'Бета'] as const;

const project: PluginModule = {
  activate(ctx) {
    let selected: number | undefined;
    let notifications = true;
    ctx.contracts.provide('demo.project', '1.0', { hasSelected: async () => selected !== undefined, notificationsOn: async () => notifications });
    // «Следующий проект»: Альфа, Бета, снова без проекта; заголовок окна получает название проекта.
    ctx.commands.register('stub-project.next', async () => {
      selected = selected === undefined ? 0 : selected + 1 < PROJECTS.length ? selected + 1 : undefined;
      await ctx.window.setTitle(selected === undefined ? undefined : PROJECTS[selected]);
      ctx.log(`проект: ${selected === undefined ? 'не выбран' : (PROJECTS[selected] ?? '')}`);
    });
    ctx.commands.register('stub-project.notifications', () => {
      notifications = !notifications;
      ctx.log(`уведомления: ${notifications ? 'включены' : 'выключены'}`);
    });
    ctx.commands.register('stub-project.properties', () => ctx.log(`свойства проекта ${selected === undefined ? '(проект не выбран)' : (PROJECTS[selected] ?? '')}`));
    return undefined;
  },
};

export default project;
