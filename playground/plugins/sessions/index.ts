import type { AgentEvent, PluginModule } from '@cyborg/contracts';

const describe = (e: AgentEvent): string => {
  switch (e.type) {
    case 'cwd':
      return `каталог ${e.cwd}`;
    case 'activity':
      return e.tool ? `работает: ${e.tool}` : 'работает';
    case 'prompt':
      return 'запрос человека';
    case 'turnEnd':
      return e.background ? 'ход завершён, ждёт фоновую работу' : 'ход завершён';
    case 'waiting':
      return e.reason;
  }
};

// Потребитель cyborg.agent в playground: агент описывает запуск, pty запускает и держит этот плагин по своему праву.
const plugin: PluginModule = {
  async activate(ctx) {
    const pty = ctx.os.pty;
    if (!pty) throw new Error('у приложения нет pty');
    // Каталог данных - cwd сессий playground; ядро создаёт его лениво, а pty без существующего cwd выходит с 1.
    await ctx.os.fs.mkdir(ctx.os.paths.data);
    let next = 0;
    const agents = () => ctx.contracts.all('cyborg.agent', 1);
    ctx.commands.register('sessions.agents', () => Promise.all(agents().map(async (p) => ({ pluginId: p.pluginId, ...(await p.impl.facts()) }))));
    ctx.commands.register('sessions.new', async (pluginId) => {
      const provider = agents().find((p) => p.pluginId === pluginId);
      if (!provider) throw new Error(`агента ${String(pluginId)} нет`);
      const facts = await provider.impl.facts();
      if (!facts.found) throw new Error(`${facts.title}: программа не найдена`);
      const sessionId = `s${Date.now().toString(36)}-${String(next++)}`;
      const spec = await provider.impl.launch({ sessionId, cwd: ctx.os.paths.data });
      const handle = await pty.spawn({ ...spec, cols: 100, rows: 16, persist: true });
      const watch = facts.capabilities.events ? provider.impl.watch(sessionId, (e) => ctx.log(`${facts.id} ${sessionId}: ${describe(e)}`)) : undefined;
      handle.onExit((exit) => {
        void watch?.then((s) => s.dispose());
        void provider.impl.ended(sessionId, exit).then(
          (hint) => ctx.log(`${facts.id} ${sessionId}: вышла с ${String(exit.code)}${hint ? ` - ${hint.message}` : ''}`),
          () => ctx.log(`${facts.id} ${sessionId}: вышла с ${String(exit.code)}`),
        );
      });
      ctx.log(`${facts.title}: сессия ${sessionId}, pid ${String(handle.pid)}`);
      return handle.share();
    });
    return undefined;
  },
};

export default plugin;
