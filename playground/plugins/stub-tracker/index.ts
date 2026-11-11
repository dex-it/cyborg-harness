import type { PluginModule } from '@cyborg-harness/contracts';

// Заглушка трекеров Cyborg (PL-08): карточка «Статус», кнопки «Задачи» и «MR/PR» в панели инструментов, выезжающая панель задач.
const tracker: PluginModule = {
  activate() {
    return undefined;
  },
};

export default tracker;
