import type { PluginModule } from '@cyborg-harness/contracts';

// Главной части делать нечего: плагин показывает, что один плагин ставит два вида в разные области.
const panels: PluginModule = {
  activate() {
    return undefined;
  },
};

export default panels;
