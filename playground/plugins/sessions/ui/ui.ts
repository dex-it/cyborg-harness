// Вид sessions: кнопка на каждого поставщика cyborg.agent и терминал последней сессии по билету главной части.

import type { AgentFacts, Disposable, ItemEventDetail, SessionAction, ThemeTokens, UiContext, UiTerminal } from '@cyborg/contracts';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

const ARROWS: Readonly<Record<string, string>> = { ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D' };

function palette(tokens: ThemeTokens): ITheme {
  const bg = tokens['--cy-surface'] ?? tokens['--cy-bg'] ?? '#000000';
  const fg = tokens['--cy-fg'] ?? '#ffffff';
  return { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selectionBackground: tokens['--cy-border'] ?? '#808080' };
}

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
  const screen = el('div', { id: 'screen', className: 'screen' });
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
  // Кнопки предлагает агент вызовом инструмента suggest_actions; человек нажимает - реплика уходит в сессию.
  const suggested = el('div', { id: 'actions', className: 'agents', hidden: true });
  const sheet = (href: string) => el('link', { rel: 'stylesheet', href: new URL(href, import.meta.url).href });
  root.append(sheet('./xterm.css'), sheet('./ui.css'), header, previous, screen, suggested, line);

  const xterm = new Terminal({ cursorBlink: true, scrollback: 5000, fontFamily: ctx.theme.tokens['--cy-font-mono'] ?? 'monospace', fontSize: 13, theme: palette(ctx.theme.tokens) });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  const themed = ctx.theme.onChange((tokens) => (xterm.options.theme = palette(tokens)));
  let shown = false;

  const state = (text: string) => (status.textContent = text);
  const failed = (error: unknown) => state(`отказ: ${error instanceof Error ? error.message : String(error)}`);
  let term: UiTerminal | undefined;
  let polling = 0;
  xterm.onData((data) => void term?.write(data).catch(failed));
  // Агент рисует под размер pty: экран вида вырос - pty растёт вместе с ним, иначе TUI займёт угол.
  xterm.onResize(({ cols, rows }) => void term?.resize(cols, rows).catch(failed));
  const resized = new ResizeObserver(() => {
    if (shown) fit.fit();
  });
  resized.observe(screen);
  const showActions = (list: readonly SessionAction[]) => {
    suggested.replaceChildren(
      ...list.map((a) => {
        const b = el('cy-button', { textContent: a.label, title: a.text });
        b.addEventListener('click', () => {
          if (!term) return;
          if (a.submit) {
            void term.write(`${a.text}\r`).catch(failed);
            xterm.focus();
            return;
          }
          line.value = a.text;
          line.focus();
        });
        return b;
      }),
    );
    suggested.hidden = list.length === 0;
  };
  const poll = async (ticket: string, generation: number) => {
    let since = -1;
    while (generation === polling) {
      const answer = (await ctx.commands.run('sessions.actions', ticket, since)) as { version: number; actions: SessionAction[] } | null;
      if (generation !== polling) return;
      if (!answer) break;
      since = answer.version;
      showActions(answer.actions);
    }
    showActions([]);
  };
  const open = async (title: string, command: string, arg: string) => {
    const ticket = await ctx.commands.run(command, arg);
    if (typeof ticket !== 'string') throw new Error(`${command} не вернул билет`);
    term?.close();
    const opened = await ctx.terminal.open(ticket);
    term = opened;
    const generation = ++polling;
    void poll(ticket, generation).catch(() => {
      if (generation === polling) showActions([]);
    });
    if (!shown) {
      shown = true;
      empty.remove();
      xterm.open(screen);
    }
    xterm.reset();
    fit.fit();
    void opened.resize(xterm.cols, xterm.rows).catch(failed);
    xterm.write(opened.backlog);
    opened.onData((chunk) => {
      if (term === opened) xterm.write(chunk);
    });
    opened.onExit((exit) => {
      state(`${title}: вышла с ${String(exit.code)}`);
      if (term === opened) term = undefined;
    });
    state(`${title}: pid ${String(opened.pid)}`);
    xterm.focus();
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
  return {
    dispose: () => {
      polling++;
      resized.disconnect();
      themed.dispose();
      term?.close();
      xterm.dispose();
    },
  };
}
