// Вид keys-pilot (PL-03): поле ввода и лента того, что дошло до страницы. Перехваченное ядром сочетание в ленту не попадает, а нажатие плагина приходит строкой лога.

import type { Disposable, UiContext } from '@cyborg-harness/contracts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const field = el('input', { id: 'field', placeholder: 'Фокус здесь - сочетания ядра не должны печатать символ' });
  field.setAttribute('aria-label', 'Поле keys-pilot');
  const log = el('ol', { id: 'log', className: 'log' });
  log.setAttribute('aria-label', 'Что дошло до страницы');
  root.append(el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href }), el('strong', { textContent: 'keys-pilot' }), field, log);
  const show = (text: string, at = Date.now()) => {
    const item = el('li', { textContent: `${new Date(at).toLocaleTimeString()} ${text}` });
    log.append(item);
    item.scrollIntoView({ block: 'nearest' });
  };
  // Сочетание, которое забрал главный процесс, сюда не доходит: строка «до вида дошло» без него - признак перехвата.
  const onKey = (event: KeyboardEvent): void => show(`до вида дошло: ${event.metaKey ? 'Meta+' : ''}${event.ctrlKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.code}`);
  field.addEventListener('keydown', onKey);
  const subs = [ctx.onLog((line) => show(line.text, line.at)), ctx.onVisibilityChange((visible) => show(visible ? 'вид снова показан' : 'вид скрыт, DOM жив'))];
  void ctx.logs().then((lines) => lines.forEach((line) => show(line.text, line.at)));
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
