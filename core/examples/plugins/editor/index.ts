import type { PluginModule } from '../../../src/index.ts';

interface FilesV2 {
  readText(path: string): Promise<{ text: string; size: number } | undefined>;
}

const plugin: PluginModule = {
  activate(ctx) {
    const files = ctx.contracts.get<FilesV2>('cyborg.files')!;
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
