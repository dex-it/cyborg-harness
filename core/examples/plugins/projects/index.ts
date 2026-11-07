import type { PluginModule } from '@cyborg-harness/contracts';
import type { Project } from '../../contracts.ts';

const plugin: PluginModule = {
  config: {
    defaults: { list: [], current: null },
    // v1 - старый формат приложения {projects, lastProjectId}: id назначался индексом.
    migrate(from, data) {
      if (from !== 1) throw new Error(`неизвестная версия ${from}`);
      const old = (data.projects ?? []) as { name: string; path: string }[];
      const list = old.map((p, i) => ({ id: `p${i + 1}`, name: p.name, path: p.path }));
      const last = typeof data.lastProjectId === 'number' ? list[data.lastProjectId] : undefined;
      return { list, current: last?.id ?? null };
    },
    validate: (v) => (Array.isArray(v.list) ? [] : ['list не массив']),
  },
  async activate(ctx) {
    const files = ctx.contracts.get('demo.files', 1);
    if (!files || !ctx.config) throw new Error('demo.files и раздел config объявлены, но не пришли');
    const value = ctx.config.get();
    const list = value.list as Project[];
    const known = await files.list();
    for (const p of list) {
      const count = known.filter((f) => f.startsWith(`${p.path}/`)).length;
      ctx.log(`проект ${p.id} «${p.name}» ${p.path}: файлов ${count}`);
    }

    const current = async () => list.find((p) => p.id === value.current);
    ctx.contracts.provide('demo.projects', '1.0', { list: async () => list, current });
    ctx.commands.register('projects.current', current);
  },
};

export default plugin;
