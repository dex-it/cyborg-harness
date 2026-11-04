import type { PluginModule } from '../../../core/src/index.ts';

// Плагин на TypeScript без сборки: хост грузит его как есть, типы снимает Node.
const echo: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.echo', '1.0', { say: async (text: string) => `${text} (эхо из ${process.pid})` });
    ctx.commands.register('echo.ping', () => ctx.log(`echo жив, процесс ${process.pid}`));
    ctx.log(`загружен в процесс ${process.pid}`);
    return undefined;
  },
};

export default echo;
