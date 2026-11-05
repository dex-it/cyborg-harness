import type { PluginModule } from '@cyborg/contracts';

const disk = new Map([
  ['/work/cyborg/README.md', '# Cyborg'],
  ['/work/cyborg/core/src/loader.ts', 'export async function load() {}'],
  ['/work/notes/todo.txt', 'ядро, хосты, сторож'],
]);

const plugin: PluginModule = {
  config: { defaults: { failOnStart: false } },
  activate(ctx) {
    if (ctx.config?.get().failOnStart) throw new Error('диск недоступен');

    ctx.contracts.provide('cyborg.files', '1.4', {
      read: async (path: string) => disk.get(path),
      list: async () => [...disk.keys()],
    });
    ctx.contracts.provide('cyborg.files', '2.0', {
      readText: async (path: string) => {
        const text = disk.get(path);
        return text === undefined ? undefined : { path, text, size: text.length };
      },
    });
    ctx.log(`отдаю cyborg.files 1.4 и 2.0, файлов ${disk.size}`);
  },
};

export default plugin;
