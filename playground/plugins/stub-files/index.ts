import type { PluginModule } from '@cyborg-harness/contracts';

// Заглушка дерева файлов Cyborg (PL-08): место в боковой колонке задаёт манифест, содержимое - только подпись вида.
const files: PluginModule = {
  activate(ctx) {
    const channel = ctx.views.channel('tree');
    let searches = 0;
    ctx.commands.register('stub-files.search', () => channel.post({ search: ++searches }));
    return undefined;
  },
};

export default files;
