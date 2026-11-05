import type { PluginModule } from '@cyborg/contracts';

/** Пустой плагин: цена хоста без работы плагина. */
const idle: PluginModule = {
  activate: () => undefined,
};

export default idle;
