import type { PluginModule } from '@cyborg/contracts';

// Плагин на TypeScript без сборки: хост грузит его как есть, типы снимает Node.
const echo: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.echo', '1.0', { say: async (text: string) => `${text} (эхо из ${process.pid})` });
    ctx.commands.register('echo.ping', () => ctx.log(`echo жив, процесс ${process.pid}`));
    ctx.commands.register('echo.files', async () => {
      await ctx.os.fs.writeText(`${ctx.os.paths.data}/seen.txt`, new Date().toISOString());
      ctx.log(`свой каталог: ${(await ctx.os.fs.list(ctx.os.paths.data)).map((e) => e.name).join(', ')}`);
      // Путь вне прав: ядро отклонит его и запишет отказ в журнал.
      await ctx.os.fs.readText('/etc/hostname').then(
        () => ctx.log('/etc/hostname прочитан - так быть не должно'),
        (error: unknown) => ctx.log(`/etc/hostname: ${error instanceof Error && 'code' in error ? String(error.code) : 'ошибка'}`),
      );
    });
    ctx.commands.register('echo.tty', async () => {
      const sh = ctx.os.pty?.spawn({ program: '/bin/sh', cols: 100, rows: 10 });
      if (!sh) return;
      const pty = await sh;
      let out = '';
      pty.onData((chunk) => (out += chunk));
      pty.onExit(({ code }) => ctx.log(`pty ${String(pty.pid)} вышел с ${String(code)}: ${out.replace(/\s+/g, ' ').trim()}`));
      await pty.write('tty; stty size; exit\r');
    });
    ctx.log(`загружен в процесс ${process.pid}`);
    return undefined;
  },
};

export default echo;
