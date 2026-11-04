import type { PluginModule } from '../../../src/index.ts';

const plugin: PluginModule = {
  activate(ctx) {
    const files = ctx.contracts.get('cyborg.files', 2);
    if (!files) throw new Error('cyborg.files в requires, но его нет');
    ctx.log('беру cyborg.files второй мажорной версии');
    ctx.contracts.provide('cyborg.tab', '1.0', {
      kind: 'редактор',
      open: async (path: string) => {
        const file = await files.readText(path);
        return file ? `редактор: ${path}, ${file.size} симв.` : `редактор: ${path} не найден`;
      },
    });
  },
};

export default plugin;
