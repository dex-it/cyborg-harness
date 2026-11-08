import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    const files = ctx.contracts.get('demo.files', 2);
    if (!files) throw new Error('demo.files в requires, но его нет');
    ctx.log('беру demo.files второй мажорной версии');
    ctx.contracts.provide('demo.tab', '1.0', {
      kind: 'редактор',
      open: async (path: string) => {
        const file = await files.readText(path);
        return file ? `редактор: ${path}, ${file.size} симв.` : `редактор: ${path} не найден`;
      },
    });
  },
};

export default plugin;
