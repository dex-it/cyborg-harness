import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  activate(ctx) {
    const kinds = () => ctx.contracts.all('cyborg.tab', 1).map((p) => `${p.impl.icon ?? ''}${p.impl.kind} (${p.pluginId}@${p.version})`);
    ctx.log(`видов вкладок сейчас: ${kinds().length}`);
    ctx.contracts.onChange('cyborg.tab', () => ctx.log(`виды вкладок изменились: ${kinds().join(', ') || 'нет'}`));

    ctx.commands.register('tabs.open', async (path) => {
      if (typeof path !== 'string') throw new Error('путь не строка');
      const all = ctx.contracts.all('cyborg.tab', 1);
      return Promise.all(all.map((p) => p.impl.open(path)));
    });
  },
};

export default plugin;
