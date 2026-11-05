// Вид sessions: кнопка на каждого поставщика cyborg.agent и терминал последней сессии по билету главной части.

import type { AgentFacts, Disposable, UiContext, UiTerminal } from '@cyborg/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]|\\r`, 'g');

type AgentRow = AgentFacts & { readonly pluginId: string };

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const agents = el('div', { id: 'agents', className: 'agents' });
  const status = el('span', { id: 'session-state', className: 'state', textContent: 'нет сессии' });
  const header = el('header');
  header.append(el('strong', { textContent: 'Сессии' }), agents, status);
  const screen = el('pre', { id: 'screen', className: 'screen' });
  screen.setAttribute('aria-label', 'Вывод сессии');
  const line = el('input', { id: 'line', placeholder: 'Ввод в сессию, Enter - отправить' });
  line.setAttribute('aria-label', 'Ввод в сессию');
  root.append(el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href }), header, screen, line);

  const state = (text: string) => (status.textContent = text);
  const print = (chunk: string) => {
    screen.textContent = (screen.textContent + chunk.replace(ESCAPES, '')).slice(-8000);
    screen.scrollTop = screen.scrollHeight;
  };
  const failed = (error: unknown) => state(`отказ: ${error instanceof Error ? error.message : String(error)}`);
  let term: UiTerminal | undefined;
  const open = async (agent: AgentRow) => {
    const ticket = await ctx.commands.run('sessions.new', agent.pluginId);
    if (typeof ticket !== 'string') throw new Error('sessions.new не вернул билет');
    term?.close();
    const opened = await ctx.terminal.open(ticket);
    term = opened;
    screen.textContent = '';
    print(opened.backlog);
    opened.onData(print);
    opened.onExit((exit) => {
      state(`${agent.title}: вышла с ${String(exit.code)}`);
      if (term === opened) term = undefined;
    });
    state(`${agent.title}: pid ${String(opened.pid)}`);
  };
  const list = async () => {
    const rows = (await ctx.commands.run('sessions.agents')) as AgentRow[];
    agents.replaceChildren(
      ...rows.map((agent) => {
        const b = el('button', { type: 'button', textContent: agent.title, disabled: !agent.found });
        b.dataset.agent = agent.id;
        b.title = agent.found ? `Новая сессия: ${agent.title}${agent.version ? ` ${agent.version}` : ''}` : `${agent.title}: программа не найдена`;
        b.addEventListener('click', () => void open(agent).catch(failed));
        return b;
      }),
    );
  };
  line.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !term) return;
    void term.write(`${line.value}\r`).catch(failed);
    line.value = '';
  });
  void list().catch(failed);
  return { dispose: () => term?.close() };
}
