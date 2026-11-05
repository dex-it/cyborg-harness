import type { AgentEvent, PluginContext, PluginModule, PtyHandle } from '@cyborg/contracts';

const describe = (e: AgentEvent): string => {
  switch (e.type) {
    case 'cwd':
      return `каталог ${e.cwd}`;
    case 'session':
      return `сессия агента ${e.resumeId}`;
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

const field = (data: unknown, key: string): string | undefined => {
  const value: unknown = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};

// Потребитель cyborg.agent в playground: агент описывает запуск, pty запускает и держит этот плагин по своему праву.
const plugin: PluginModule = {
  async activate(ctx: PluginContext) {
    const pty = ctx.os.pty;
    if (!pty) throw new Error('у приложения нет pty');
    // Каталог данных - cwd сессий playground; ядро создаёт его лениво, а pty без существующего cwd выходит с 1.
    await ctx.os.fs.mkdir(ctx.os.paths.data);
    let next = 0;
    // Вкладка документа - сессия этого запуска; документы без живой сессии остались от прошлого и ждут restore.
    const live = new Map<string, PtyHandle>();
    const agents = () => ctx.contracts.all('cyborg.agent', 1);
    // Порядок по id поставщика: тот же набор плагинов - тот же промпт; сломанный вклад не мешает запуску.
    const fragments = async (): Promise<string[]> => {
      const all = ctx.contracts.all('cyborg.session-prompt', 1).toSorted((a, b) => a.pluginId.localeCompare(b.pluginId));
      const texts = await Promise.all(
        all.map((p) =>
          p.impl.fragment().catch((e: unknown) => {
            ctx.log(`${p.pluginId}: фрагмент промпта - ${String(e)}`);
            return '';
          }),
        ),
      );
      return texts.filter((t) => t.trim() !== '');
    };

    const launch = async (pluginId: unknown, documentId?: string, resumeId?: string): Promise<string> => {
      const provider = agents().find((p) => p.pluginId === pluginId);
      if (!provider) throw new Error(`агента ${String(pluginId)} нет`);
      const facts = await provider.impl.facts();
      if (!facts.found) throw new Error(`${facts.title}: программа не найдена`);
      const sessionId = `s${Date.now().toString(36)}-${String(next++)}`;
      const resume = facts.capabilities.resume ? resumeId : undefined;
      const promptFragments = await fragments();
      const spec = await provider.impl.launch({ sessionId, cwd: ctx.os.paths.data, ...(resume !== undefined && { resumeId: resume }), ...(promptFragments.length > 0 && { promptFragments }) });
      const handle = await pty.spawn({ ...spec, cols: 100, rows: 16, persist: true, describedBy: provider.pluginId });
      const title = `${facts.title} ${sessionId}`;
      const agent = provider.pluginId;
      const doc = documentId ?? (await ctx.documents.open('session', { title, data: { agent } }));
      if (documentId !== undefined) await ctx.documents.save(doc, { title, data: { agent, ...(resume !== undefined && { resumeId: resume }) } });
      live.set(doc, handle);
      const watch = facts.capabilities.events
        ? provider.impl.watch(sessionId, (e) => {
            ctx.log(`${facts.id} ${sessionId}: ${describe(e)}`);
            // Документ закрыт человеком - сохранять некуда.
            if (e.type === 'session' && live.has(doc)) void ctx.documents.save(doc, { data: { agent, resumeId: e.resumeId } }).catch(() => undefined);
          })
        : undefined;
      handle.onExit((exit) => {
        if (live.get(doc) === handle) live.delete(doc);
        void watch?.then((s) => s.dispose());
        void provider.impl.ended(sessionId, exit).then(
          (hint) => ctx.log(`${facts.id} ${sessionId}: вышла с ${String(exit.code)}${hint ? ` - ${hint.message}` : ''}`),
          () => ctx.log(`${facts.id} ${sessionId}: вышла с ${String(exit.code)}`),
        );
      });
      ctx.log(`${facts.title}: сессия ${sessionId}, pid ${String(handle.pid)}`);
      return handle.share();
    };

    ctx.commands.register('sessions.agents', () => Promise.all(agents().map(async (p) => ({ pluginId: p.pluginId, ...(await p.impl.facts()) }))));
    ctx.commands.register('sessions.new', (pluginId) => launch(pluginId));
    ctx.commands.register('sessions.previous', async () => (await ctx.documents.list()).filter((d) => !live.has(d.id)).map((d) => ({ id: d.id, title: d.title, agent: field(d.data, 'agent'), resumable: field(d.data, 'resumeId') !== undefined })));
    ctx.commands.register('sessions.restore', async (id) => {
      const doc = (await ctx.documents.list()).find((d) => d.id === id);
      if (!doc) throw new Error(`документа ${String(id)} нет`);
      if (live.has(doc.id)) throw new Error(`${doc.title}: сессия уже идёт`);
      return launch(field(doc.data, 'agent'), doc.id, field(doc.data, 'resumeId'));
    });
    // Человек закрыл вкладку в окне: сессии за ней больше не на что показываться.
    ctx.documents.onClose((id) => {
      const handle = live.get(id);
      live.delete(id);
      void handle?.kill().catch(() => undefined);
    });
    const kept = await ctx.documents.list();
    if (kept.length > 0) ctx.log(`с прошлого запуска: ${String(kept.length)} сессий к восстановлению`);
    return undefined;
  },
};

export default plugin;
