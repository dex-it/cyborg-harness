import type { AgentEvent, AgentFacts, AgentToolsEndpoint, PluginContext, PluginModule, PtyHandle, SessionAction, SessionChange, SessionEvent } from '@cyborg-harness/contracts';
import { MCP_PATH, mcpHandler } from './mcp.ts';

interface Actions {
  list: readonly SessionAction[];
  ready: boolean;
  turnOver: boolean;
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

/** Событие агента глазами `cyborg.sessions`: новый запрос человека тоже «работает», `session` и `turnEnd` контракт пока не отдаёт. */
export function sessionChange(e: AgentEvent): SessionChange | undefined {
  switch (e.type) {
    case 'cwd':
      return { type: 'cwd', cwd: e.cwd };
    case 'activity':
      return { type: 'activity', ...(e.tool !== undefined && { tool: e.tool }) };
    case 'prompt':
      return { type: 'activity' };
    case 'waiting':
      return { type: 'waiting', reason: e.reason };
    case 'session':
    case 'turnEnd':
      return undefined;
  }
}

const field = (data: unknown, key: string): string | undefined => {
  const value: unknown = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : undefined;
};

/**
 * Данные документа сессии. `pty` («id:pid») по документу находит оставленный процесс при активации: id в таблице ядра считает с нуля при каждом запуске приложения,
 * и без pid документ прошлого запуска мог бы подхватить чужой процесс с тем же id.
 */
interface Saved {
  readonly agent: string;
  readonly sessionId: string;
  readonly pty: string;
  readonly resumeId?: string;
}

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
    // Вкладка сессии по id сессии: живёт, пока вкладку не закрыл человек, и после выхода процесса (вкладка ждёт restore).
    const tabs = new Map<string, string>();
    const agents = () => ctx.contracts.all('cyborg.agent', 1);
    type Provider = ReturnType<typeof agents>[number];
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

    // Билет вида называет сессию: по нему вид отличает кнопки, которые предложил агент этой сессии, от чужих.
    const tickets = new Map<string, string>();
    const actions = new Map<string, Actions>();
    const tokens = new Map<string, string>();
    // Кнопки и готовность агента уходят виду по каналу сразу, как изменились: вид не опрашивает (K-13).
    const channel = ctx.views.channel('main');
    const send = (message: Record<string, unknown>) => void channel.post(message).catch((e: unknown) => ctx.log(`канал к виду: ${String(e)}`));
    const publish = (sessionId: string) => {
      const ticket = tickets.get(sessionId);
      const a = actions.get(sessionId);
      if (ticket !== undefined && a) send({ ticket, actions: a.list, ready: a.ready });
    };
    const setActions = (sessionId: string, list: readonly SessionAction[]) => {
      const a = actions.get(sessionId);
      if (!a || (a.list.length === 0 && list.length === 0)) return;
      a.list = list;
      publish(sessionId);
    };
    const onEvent = (sessionId: string, e: AgentEvent) => {
      const a = actions.get(sessionId);
      if (!a) return;
      const ready = readyAfter(e, a.ready, a.turnOver);
      a.turnOver = e.type === 'turnEnd' && !e.background;
      if (ready === a.ready) return;
      a.ready = ready;
      publish(sessionId);
    };
    // cyborg.sessions: подписчики других плагинов; слушатель, бросивший исключение или упавший вместе со своим хостом, соседям не мешает.
    const listeners = new Set<(event: SessionEvent) => void>();
    const emit = (event: SessionEvent) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (e) {
          ctx.log(`слушатель cyborg.sessions: ${String(e)}`, 'warn');
        }
      }
    };
    ctx.contracts.provide('cyborg.sessions', '1.1', {
      onChange(listener) {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
      async reveal(sessionId) {
        const doc = tabs.get(sessionId);
        if (doc === undefined) throw new Error(`нет сессии ${sessionId}: вкладки нет`);
        await ctx.documents.reveal(doc);
      },
    });
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

    const dataOf = (saved: Saved) => ({ agent: saved.agent, sessionId: saved.sessionId, pty: saved.pty, ...(saved.resumeId !== undefined && { resumeId: saved.resumeId }) });
    // Билет вида на идущую сессию: вид после перезагрузки окна просит новый, прежний одноразовый и ушёл вместе с окном.
    const present = async (sessionId: string, handle: PtyHandle): Promise<string> => {
      const ticket = await handle.share();
      // Сессия могла выйти, пока выдавался билет: тогда сообщать по нему нечего. Что накопилось до билета, уходит виду теперь.
      if (actions.has(sessionId)) {
        tickets.set(sessionId, ticket);
        publish(sessionId);
      }
      return ticket;
    };
    /**
     * Сессия за вкладкой `doc`: вкладка, события агента, выход процесса. Общее у нового запуска и у подхвата оставленного pty.
     * Возвращает запуск слежения за событиями: он ждёт фактов поставщика, а подхват не должен ждать их, пока идёт льготный срок ядра.
     */
    const track = (s: { doc: string; sessionId: string; handle: PtyHandle; title: string; agent: string; provider: Provider | undefined; resumeId: string | undefined; forget: () => void }): ((facts: AgentFacts) => void) => {
      const { doc, sessionId, handle, title, agent, provider } = s;
      live.set(doc, handle);
      tabs.set(sessionId, doc);
      let name = agent;
      let over = false;
      let unwatch: (() => void) | undefined;
      handle.onExit((exit) => {
        over = true;
        if (live.get(doc) === handle) live.delete(doc);
        s.forget();
        emit({ sessionId, title, change: { type: 'exit', code: exit.code } });
        unwatch?.();
        if (!provider) return;
        void provider.impl.ended(sessionId, exit).then(
          (hint) => ctx.log(`${name} ${sessionId}: вышла с ${String(exit.code)}${hint ? ` - ${hint.message}` : ''}`),
          () => ctx.log(`${name} ${sessionId}: вышла с ${String(exit.code)}`),
        );
      });
      return (facts) => {
        name = facts.id;
        if (over || !provider || !facts.capabilities.events) return;
        const watch = provider.impl.watch(sessionId, (e) => {
          ctx.log(`${facts.id} ${sessionId}: ${describe(e)}`);
          onEvent(sessionId, e);
          const change = sessionChange(e);
          if (change) emit({ sessionId, title, change });
          // Человек написал сам или нажал кнопку: прежние предложения к новому ходу не относятся.
          if (e.type === 'prompt') setActions(sessionId, []);
          // Документ закрыт человеком - сохранять некуда.
          if (e.type === 'session' && live.has(doc)) {
            const saved: Saved = { agent, sessionId, pty: `${handle.id}:${String(handle.pid)}`, resumeId: e.resumeId };
            void ctx.documents.save(doc, { data: dataOf(saved) }).catch(() => undefined);
          }
        });
        unwatch = () => void watch.then((w) => w.dispose());
      };
    };
    // Сессия кончилась: вид снимает кнопки и забывает билет.
    const endedFor = (sessionId: string, tokenToDrop?: string) => () => {
      if (tokenToDrop !== undefined) tokens.delete(tokenToDrop);
      actions.delete(sessionId);
      const ticket = tickets.get(sessionId);
      tickets.delete(sessionId);
      if (ticket !== undefined) send({ ticket, actions: [], ready: false, ended: true });
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
      const forget = endedFor(sessionId, tools?.token);
      actions.set(sessionId, { list: [], ready: false, turnOver: false });
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
      const saved: Saved = { agent, sessionId, pty: `${handle.id}:${String(handle.pid)}`, ...(resume !== undefined && { resumeId: resume }) };
      const doc = documentId ?? (await ctx.documents.open('session', { title, data: dataOf(saved) }));
      if (documentId !== undefined) await ctx.documents.save(doc, { title, data: dataOf(saved) });
      track({ doc, sessionId, handle, title, agent, provider, resumeId: resume, forget })(facts);
      ctx.log(`${facts.title}: сессия ${sessionId}, pid ${String(handle.pid)}`);
      return present(sessionId, handle);
    };

    /**
     * Оставленные pty (хост плагина перезапущен или человек выключил плагин с «Оставить работать»): с активации идёт льготный срок ядра,
     * и не взятый через `attach` процесс по его концу завершается (K-02, #90). Документ сессии помнит свой pty, по нему сессия возвращается на вкладку.
     */
    const adopt = async (): Promise<void> => {
      const [docs, left] = await Promise.all([ctx.documents.list(), pty.list()]);
      for (const info of left) {
        const doc = docs.find((d) => field(d.data, 'pty') === `${info.id}:${String(info.pid)}`);
        const sessionId = field(doc?.data, 'sessionId');
        const agent = field(doc?.data, 'agent');
        if (doc === undefined || sessionId === undefined || agent === undefined) continue;
        const handle = await pty.attach(info.id);
        const provider = agents().find((p) => p.pluginId === agent);
        actions.set(sessionId, { list: [], ready: false, turnOver: false });
        const watching = track({ doc: doc.id, sessionId, handle, title: doc.title, agent, provider, resumeId: field(doc.data, 'resumeId'), forget: endedFor(sessionId) });
        ctx.log(`${doc.title}: подхвачена оставленная сессия, pid ${String(handle.pid)}`);
        void provider?.impl.facts().then(watching, (e: unknown) => ctx.log(`${agent}: факты подхваченной сессии - ${String(e)}`, 'warn'));
      }
    };

    ctx.commands.register('sessions.agents', () => Promise.all(agents().map(async (p) => ({ pluginId: p.pluginId, ...(await p.impl.facts()) }))));
    ctx.commands.register('sessions.new', (pluginId) => launch(pluginId));
    ctx.commands.register('sessions.previous', async () => (await ctx.documents.list()).filter((d) => !live.has(d.id)).map((d) => ({ id: d.id, title: d.title, agent: field(d.data, 'agent'), resumable: field(d.data, 'resumeId') !== undefined })));
    // Идущие сессии: окно после перезагрузки (и подхваченные при активации) открывает их заново по новому билету.
    ctx.commands.register('sessions.running', async () => (await ctx.documents.list()).filter((d) => live.has(d.id)).map((d) => ({ id: d.id, title: d.title, pid: live.get(d.id)?.pid })));
    ctx.commands.register('sessions.reopen', async (id) => {
      const handle = typeof id === 'string' ? live.get(id) : undefined;
      const sessionId = [...tabs].find(([, doc]) => doc === id)?.[0];
      if (handle === undefined || sessionId === undefined) throw new Error(`сессии ${String(id)} нет`);
      return present(sessionId, handle);
    });
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
      for (const [sessionId, doc] of tabs) if (doc === id) tabs.delete(sessionId);
      void handle?.kill().catch(() => undefined);
    });
    await adopt().catch((e: unknown) => ctx.log(`подхват оставленных сессий: ${String(e)}`, 'warn'));
    const kept = await ctx.documents.list();
    if (kept.length > 0) ctx.log(`с прошлого запуска: ${String(kept.length)} сессий к восстановлению`);
    return undefined;
  },
};

export default plugin;
