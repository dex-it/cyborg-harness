import type { PluginModule } from '../../../core/src/index.ts';

// Плагин на TypeScript без сборки: хост грузит его как есть, типы снимает Node.
const echo: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.echo', '1.0', { say: async (text: string) => `${text} из ${process.pid}` });
    ctx.log(`echo в ${process.pid}`);
  },
};

export default echo;
