// Вид alice: модуль с mount, разметку строит сам; до ядра - только через UiContext.

import type { Disposable, FeedLine, UiContext, UiModule } from '@cyborg/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const style = el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href });
  const hello = el('button', { type: 'button', id: 'hello', textContent: 'Привет, bob' });
  const memory = ctx.state.value as { greeted?: unknown } | undefined;
  let greeted = typeof memory?.greeted === 'number' ? memory.greeted : 0;
  const counter = el('span', { id: 'greeted', textContent: `приветов: ${String(greeted)}` });
  const file = el('div', { id: 'file', className: 'file', draggable: true, title: 'Перетащите в вид bob', textContent: 'notes.md' });
  const log = el('ol', { id: 'log', className: 'log' });
  log.setAttribute('aria-label', 'Сообщения alice');
  const header = el('header');
  header.append(el('strong', { textContent: 'alice' }), hello, counter);
  root.append(style, header, file, log);

  const show = (line: Pick<FeedLine, 'at' | 'text'>) => {
    const item = el('li', { textContent: `${new Date(line.at).toLocaleTimeString()} ${line.text}` });
    log.append(item);
    item.scrollIntoView({ block: 'nearest' });
  };

  hello.addEventListener('click', () => {
    greeted += 1;
    counter.textContent = `приветов: ${String(greeted)}`;
    void ctx.state.set({ greeted }).catch((error: unknown) => show({ at: Date.now(), text: `память: ${error instanceof Error ? error.message : String(error)}` }));
    ctx.commands.run('alice.hello').catch((error: unknown) => show({ at: Date.now(), text: `отказ: ${error instanceof Error ? error.message : String(error)}` }));
  });
  file.addEventListener('dragstart', (event) => {
    event.preventDefault();
    ctx.drag.start('notes.md');
  });
  const subs = [
    ctx.onLog(show),
    ctx.theme.onChange((tokens) => show({ at: Date.now(), text: `тема: ${tokens['--cy-scheme'] ?? '?'}` })),
  ];
  void ctx.logs().then((lines) => lines.forEach(show));
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}

mount satisfies UiModule<HTMLElement>['mount'];
