import type { PluginModule } from '@cyborg-harness/contracts';

// Заглушка списка сессий и кнопки «Новая сессия» (PL-08): две области одного плагина, команд у него нет.
const sessions: PluginModule = {
  activate() {
    return undefined;
  },
};

export default sessions;
