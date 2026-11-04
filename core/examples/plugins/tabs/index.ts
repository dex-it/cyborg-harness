import type { PluginModule } from '../../../src/index.ts';

interface Tab {
  kind: string;
  open(path: string): Promise<string>;
}

const plugin: PluginModule = {
  activate(ctx) {
    const kinds = () => ctx.contracts.all<Tab>('cyborg.tab').map((p) => `${p.impl.kind} (${p.pluginId}@${p.version})`);
    ctx.log(`видов вкладок сейчас: ${kinds().length}`);
    ctx.contracts.onChange('cyborg.tab', () => ctx.log(`виды вкладок изменились: ${kinds().join(', ') || 'нет'}`));

    ctx.commands.register('tabs.open', async (path) => {
      const all = ctx.contracts.all<Tab>('cyborg.tab');
      return Promise.all(all.map((p) => p.impl.open(path as string)));
    });
  },
};

export default plugin;
