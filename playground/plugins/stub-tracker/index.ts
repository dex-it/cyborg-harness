import type { PluginModule } from '@cyborg-harness/contracts';

// Заглушка трекеров Cyborg (PL-08): карточка «Статус», кнопки «Задачи» и «MR/PR» в панели инструментов, выезжающая панель задач и пункт меню «Расширения».
const tracker: PluginModule = {
  activate(ctx) {
    ctx.commands.register('stub-tracker.extensions', () => ctx.log('пункт меню «Расширения»: команда плагина выполнена'));
    return undefined;
  },
};

export default tracker;
