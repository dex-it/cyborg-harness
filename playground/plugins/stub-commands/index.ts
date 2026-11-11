import type { PluginModule } from '@cyborg-harness/contracts';

// Заглушка полосы кнопок под терминалом (PL-08): в основной области она стоит после терминала по `order`.
const commands: PluginModule = {
  activate() {
    return undefined;
  },
};

export default commands;
