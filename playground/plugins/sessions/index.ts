import type { AgentEvent, AgentToolsEndpoint, PluginContext, PluginModule, PtyHandle, SessionAction } from '@cyborg-harness/contracts';
import { MCP_PATH, mcpHandler } from './mcp.ts';

// Вид спрашивает снова сразу после ответа: ожидание короче, чем человек замечает задержку закрытого вида.
export const ACTIONS_WAIT_MS = 20_000;

interface Actions {
  version: number;
  list: readonly SessionAction[];
  ready: boolean;
  turnOver: boolean;
  readonly waiters: Set<() => void>;
}

/** Агент ждёт новой реплики: ход кончился, и с тех пор агент ничего не начал. */
export function readyAfter(event: AgentEvent, ready: boolean, turnOver: boolean): boolean {
  switch (event.type) {
    case 'turnEnd':
      return !event.background;
    // Ход кончился и ничего не началось - агент не работает, значит и не спрашивает: это «ждёт ответа» после хода.
    case 'waiting':
      return turnOver;
    case 'prompt':
      return false;
    case 'activity':
      return event.tool === undefined && ready;
    case 'cwd':
    case 'session':
      return ready;
  }
}

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

    // Билет вида называет сессию: по нему вид спрашивает кнопки, которые предложил её агент.
    const byTicket = new Map<string, string>();
    const actions = new Map<string, Actions>();
    const tokens = new Map<string, string>();
    const changed = (a: Actions) => {
      a.version++;
      for (const wake of a.waiters) wake();
      a.waiters.clear();
    };
    const setActions = (sessionId: string, list: readonly SessionAction[]) => {
      const a = actions.get(sessionId);
      if (!a || (a.list.length === 0 && list.length === 0)) return;
      a.list = list;
      changed(a);
    };
    const onEvent = (sessionId: string, e: AgentEvent) => {
      const a = actions.get(sessionId);
      if (!a) return;
      const ready = readyAfter(e, a.ready, a.turnOver);
      a.turnOver = e.type === 'turnEnd' && !e.background;
      if (ready === a.ready) return;
      a.ready = ready;
      changed(a);
    };
    const toolSources = () => ctx.contracts.all('cyborg.agent-tool', 1);
    let server: Promise<string> | undefined;
    // Сервер один на плагин и поднимается с первой сессией, которой есть что предложить агенту.
    const mcpUrl = (): Promise<string> | undefined => {
      const serve = ctx.os.serve;
      if (!serve || toolSources().length === 0) return undefined;
      server ??= serve.http(mcpHandler({ sessionOf: (t) => tokens.get(t), sources: toolSources, onActions: setActions, log: (m) => ctx.log(m) })).then((s) => `${s.url}${MCP_PATH}`);
      server.catch(() => (server = undefined));
      return server;
    };
    const endpoint = async (sessionId: string): Promise<AgentToolsEndpoint | undefined> => {
      const url = await mcpUrl()?.catch((e: unknown) => {
        ctx.log(`сервер инструментов агента не поднялся: ${String(e)}`);
        return undefined;
      });
      if (url === undefined) return undefined;
      const token = crypto.randomUUID();
      tokens.set(token, sessionId);
      return { url, token };
    };

    const launch = async (pluginId: unknown, documentId?: string, resumeId?: string): Promise<string> => {
      const provider = agents().find((p) => p.pluginId === pluginId);
      if (!provider) throw new Error(`агента ${String(pluginId)} нет`);
      const facts = await provider.impl.facts();
      if (!facts.found) throw new Error(`${facts.title}: программа не найдена`);
      // Файлы событий агента лежат в общем `plugin-data` (K-20): счётчик и время двух окон могут совпасть, поэтому в id есть случайная часть.
      const sessionId = `s${Date.now().toString(36)}-${String(next++)}-${crypto.randomUUID().slice(0, 8)}`;
      const resume = facts.capabilities.resume ? resumeId : undefined;
      const promptFragments = await fragments();
      const tools = await endpoint(sessionId);
      const forget = () => {
        if (tools) tokens.delete(tools.token);
        const a = actions.get(sessionId);
        actions.delete(sessionId);
        for (const wake of a?.waiters ?? []) wake();
      };
      actions.set(sessionId, { version: 0, list: [], ready: false, turnOver: false, waiters: new Set() });
      let handle: PtyHandle;
      try {
        const spec = await provider.impl.launch({ sessionId, cwd: ctx.os.paths.data, ...(resume !== undefined && { resumeId: resume }), ...(promptFragments.length > 0 && { promptFragments }), ...(tools && { tools }) });
        handle = await pty.spawn({ ...spec, cols: 120, rows: 32, persist: true, describedBy: provider.pluginId });
      } catch (error) {
        forget();
        throw error;
      }
      const title = `${facts.title} ${sessionId}`;
      const agent = provider.pluginId;
      const doc = documentId ?? (await ctx.documents.open('session', { title, data: { agent } }));
      if (documentId !== undefined) await ctx.documents.save(doc, { title, data: { agent, ...(resume !== undefined && { resumeId: resume }) } });
      live.set(doc, handle);
      const watch = facts.capabilities.events
        ? provider.impl.watch(sessionId, (e) => {
            ctx.log(`${facts.id} ${sessionId}: ${describe(e)}`);
            onEvent(sessionId, e);
            // Человек написал сам или нажал кнопку: прежние предложения к новому ходу не относятся.
            if (e.type === 'prompt') setActions(sessionId, []);
            // Документ закрыт человеком - сохранять некуда.
            if (e.type === 'session' && live.has(doc)) void ctx.documents.save(doc, { data: { agent, resumeId: e.resumeId } }).catch(() => undefined);
          })
        : undefined;
      handle.onExit((exit) => {
        if (live.get(doc) === handle) live.delete(doc);
        for (const [t, id] of byTicket) if (id === sessionId) byTicket.delete(t);
        forget();
        void watch?.then((s) => s.dispose());
        void provider.impl.ended(sessionId, exit).then(
          (hint) => ctx.log(`${facts.id} ${sessionId}: вышла с ${String(exit.code)}${hint ? ` - ${hint.message}` : ''}`),
          () => ctx.log(`${facts.id} ${sessionId}: вышла с ${String(exit.code)}`),
        );
      });
      ctx.log(`${facts.title}: сессия ${sessionId}, pid ${String(handle.pid)}`);
      const ticket = await handle.share();
      // Сессия могла выйти, пока выдавался билет: тогда спрашивать по нему нечего.
      if (actions.has(sessionId)) byTicket.set(ticket, sessionId);
      return ticket;
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
    // Долгий опрос: вид не получает толчков от плагина и ждёт здесь смены версии или срока.
    ctx.commands.register('sessions.actions', async (ticket, since) => {
      const sessionId = byTicket.get(String(ticket)) ?? '';
      const a = actions.get(sessionId);
      // null - сессии нет: вид прекращает опрос, а не крутит его вхолостую.
      if (!a) return null;
      if (a.version === since) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            a.waiters.delete(wake);
            resolve();
          }, ACTIONS_WAIT_MS);
          const wake = () => {
            clearTimeout(timer);
            resolve();
          };
          a.waiters.add(wake);
        });
      }
      return actions.get(sessionId) === a ? { version: a.version, actions: a.list, ready: a.ready } : null;
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
