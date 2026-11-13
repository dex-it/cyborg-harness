import type { PluginModule } from '@cyborg-harness/contracts';

/** Эхо любого значения: что канал хоста клонирует туда и обратно (спайк TR-20, сверка structuredClone между utilityProcess и процессом Node). */
const clone: PluginModule = {
  activate(ctx) {
    ctx.commands.register('bench-clone.echo', (value) => value);
    return undefined;
  },
};

export default clone;
