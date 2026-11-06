// Вид echo: терминал /bin/sh по билету главной части; вывод и ввод идут через ядро мимо хоста плагина.

import type { Disposable, UiContext, UiModule, UiTerminal } from '@cyborg-harness/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

// Экран без эмулятора: escape-последовательности и возврат каретки срезаются, остаётся текст.
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]|\\r`, 'g');

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const reconnect = el('button', { type: 'button', id: 'connect', textContent: 'Новый билет', title: 'Взять у главной части новый билет и открыть терминал заново' });
  const header = el('header');
  const status = el('span', { id: 'term-state', className: 'state', textContent: 'нет терминала' });
  header.append(el('strong', { textContent: 'echo' }), status, reconnect);
  const screen = el('pre', { id: 'screen', className: 'screen' });
  screen.setAttribute('aria-label', 'Вывод терминала echo');
  const line = el('input', { id: 'line', placeholder: 'Команда для /bin/sh, Enter - отправить' });
  line.setAttribute('aria-label', 'Ввод терминала echo');
  root.append(el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href }), header, screen, line);

  const state = (text: string) => (status.textContent = text);
  const print = (chunk: string) => {
    screen.textContent = (screen.textContent + chunk.replace(ESCAPES, '')).slice(-8000);
    screen.scrollTop = screen.scrollHeight;
  };
  let term: UiTerminal | undefined;
  const connect = async () => {
    term?.close();
    term = undefined;
    const ticket = await ctx.commands.run('echo.terminal');
    if (typeof ticket !== 'string') throw new Error('echo.terminal не вернул билет');
    const opened = await ctx.terminal.open(ticket);
    term = opened;
    screen.textContent = '';
    print(opened.backlog);
    opened.onData(print);
    opened.onExit((exit) => {
      state(`вышел с ${String(exit.code)}`);
      if (term === opened) term = undefined;
    });
    state(`pty ${String(opened.pid)}`);
  };
  const failed = (error: unknown) => state(`отказ: ${error instanceof Error ? error.message : String(error)}`);
  reconnect.addEventListener('click', () => void connect().catch(failed));
  line.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !term) return;
    void term.write(`${line.value}\r`).catch(failed);
    line.value = '';
  });
  void connect().catch(failed);
  return { dispose: () => term?.close() };
}

mount satisfies UiModule<HTMLElement>['mount'];
