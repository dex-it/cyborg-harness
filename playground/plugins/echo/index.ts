import type { PluginModule, PtyHandle } from '@cyborg-harness/contracts';

// Плагин на TypeScript без сборки: хост грузит его как есть, типы снимает Node.
const echo: PluginModule = {
  activate(ctx) {
    let marked = false;
    ctx.contracts.provide('demo.echo', '1.0', { say: async (text: string) => `${text} (эхо из ${process.pid})`, marked: async () => marked });
    // Пункт меню «Echo: отметка» читает marked у контракта: галочка следует состоянию (K-08).
    ctx.commands.register('echo.mark', () => void (marked = !marked));
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
    let shared: PtyHandle | undefined;
    // Вид просит билет командой: share() есть только у главной части, а pty с persist переживает перезапуск хоста.
    ctx.commands.register('echo.terminal', async () => {
      const pty = ctx.os.pty;
      if (!pty) throw new Error('у приложения нет pty');
      if (!shared) {
        const alive = (await pty.list()).find((p) => p.persist && !p.exit);
        shared = alive ? await pty.attach(alive.id) : await pty.spawn({ program: '/bin/sh', persist: true, cols: 80, rows: 12 });
        shared.onExit(() => (shared = undefined));
      }
      return shared.share();
    });
    ctx.log(`загружен в процесс ${process.pid}`);
    return undefined;
  },
};

export default echo;
