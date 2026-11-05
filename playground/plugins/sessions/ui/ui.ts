// Вид sessions: кнопка на каждого поставщика cyborg.agent и терминал последней сессии по билету главной части.

import type { AgentFacts, Disposable, ItemEventDetail, UiContext, UiTerminal } from '@cyborg/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]|\\r`, 'g');

const ARROWS: Readonly<Record<string, string>> = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D' };

type AgentRow = AgentFacts & { readonly pluginId: string };
interface PreviousRow {
  readonly id: string;
  readonly title: string;
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const agents = el('div', { id: 'agents', className: 'agents' });
  const status = el('span', { id: 'session-state', className: 'state', textContent: 'нет сессии' });
  const header = el('header');
  header.append(el('strong', { textContent: 'Сессии' }), agents, status);
  const screen = el('pre', { id: 'screen', className: 'screen' });
  screen.setAttribute('aria-label', 'Вывод сессии');
  // Элементы ядра: оболочка вида определила их до mount.
  const line = el('cy-field', { id: 'line' });
  line.setAttribute('placeholder', 'Ввод в сессию, Enter - отправить');
  line.setAttribute('aria-label', 'Ввод в сессию');
  const empty = el('cy-empty', { id: 'no-session', textContent: 'Выберите агента - сессия откроется здесь' });
  empty.setAttribute('heading', 'Нет сессии');
  screen.append(empty);
  agents.append(el('cy-spinner', { id: 'agents-loading' }));
  // Документы прошлого запуска: ядро их сохранило, поднимает сессию человек - агент мог за это время пропасть.
  const previous = el('cy-list', { id: 'previous', hidden: true });
  previous.setAttribute('aria-label', 'Сессии прошлого запуска');
  root.append(el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href }), header, previous, screen, line);

  const state = (text: string) => (status.textContent = text);
  const print = (chunk: string) => {
    screen.textContent = (screen.textContent + chunk.replace(ESCAPES, '')).slice(-8000);
    screen.scrollTop = screen.scrollHeight;
  };
  const failed = (error: unknown) => state(`отказ: ${error instanceof Error ? error.message : String(error)}`);
  let term: UiTerminal | undefined;
  const open = async (title: string, command: string, arg: string) => {
    const ticket = await ctx.commands.run(command, arg);
    if (typeof ticket !== 'string') throw new Error(`${command} не вернул билет`);
    term?.close();
    const opened = await ctx.terminal.open(ticket);
    term = opened;
    screen.textContent = '';
    print(opened.backlog);
    opened.onData(print);
    opened.onExit((exit) => {
      state(`${title}: вышла с ${String(exit.code)}`);
      if (term === opened) term = undefined;
    });
    state(`${title}: pid ${String(opened.pid)}`);
    void listPrevious().catch(failed);
  };
  const listPrevious = async () => {
    const rows = (await ctx.commands.run('sessions.previous')) as PreviousRow[];
    previous.items = rows.map((r) => ({ id: r.id, label: r.title, detail: 'с прошлого запуска' }));
    previous.hidden = rows.length === 0;
  };
  previous.addEventListener('cy-activate', (event) => {
    const { id } = (event as CustomEvent<ItemEventDetail>).detail;
    const row = previous.items.find((r) => r.id === id);
    void open(row?.label ?? id, 'sessions.restore', id).catch(failed);
  });
  const list = async () => {
    const rows = (await ctx.commands.run('sessions.agents')) as AgentRow[];
    agents.replaceChildren(
      ...rows.map((agent) => {
        const b = el('cy-button', { textContent: agent.title, disabled: !agent.found });
        b.dataset.agent = agent.id;
        b.title = agent.found ? `Новая сессия: ${agent.title}${agent.version ? ` ${agent.version}` : ''}` : `${agent.title}: программа не найдена`;
        b.addEventListener('click', () => void open(agent.title, 'sessions.new', agent.pluginId).catch(failed));
        return b;
      }),
    );
  };
  line.addEventListener('keydown', (event) => {
    if (!term) return;
    // Пустое поле отдаёт стрелки сессии: выбор в диалоге агента (доверие к каталогу, разрешение) делается ими.
    const arrow = line.value === '' ? ARROWS[event.key] : undefined;
    if (arrow !== undefined) {
      event.preventDefault();
      void term.write(arrow).catch(failed);
      return;
    }
    if (event.key !== 'Enter') return;
    void term.write(`${line.value}\r`).catch(failed);
    line.value = '';
  });
  void list().catch(failed);
  void listPrevious().catch(failed);
  return { dispose: () => term?.close() };
}
