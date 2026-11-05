// Вид bob: принимает путь файла из чужого фрейма через ядро, зовёт эхо через контракт и показывает отказ на чужую команду.

import type { Disposable, UiContext, UiModule } from '@cyborg/contracts';
import type {} from '../../contracts.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const button = (id: string, text: string, title = '') => el('button', { type: 'button', id, textContent: text, title });
  const header = el('header');
  const [hello, status, echo, foreign] = [
    button('hello', 'Привет, alice'),
    button('status', 'Статус'),
    button('echo', 'Эхо', 'Метод контракта demo.echo прямо из вида'),
    button('foreign', 'alice.hello', 'Чужая команда: главный процесс её отклонит'),
  ];
  header.append(el('strong', { textContent: 'bob' }), hello, status, echo, foreign);
  const field = el('input', { id: 'field', placeholder: 'Фокус здесь - сочетания ядра всё равно работают' });
  field.setAttribute('aria-label', 'Поле bob');
  const drop = el('div', { id: 'drop', className: 'drop', textContent: 'Бросьте сюда файл из вида alice' });
  const log = el('ol', { id: 'log', className: 'log' });
  log.setAttribute('aria-label', 'Сообщения bob');
  root.append(el('link', { rel: 'stylesheet', href: new URL('./ui.css', import.meta.url).href }), header, field, drop, log);

  const refused = (error: unknown) => show(`отказ: ${error instanceof Error ? error.message : String(error)}`);
  const show = (text: string, at = Date.now()) => {
    const item = el('li', { textContent: `${new Date(at).toLocaleTimeString()} ${text}` });
    log.append(item);
    item.scrollIntoView({ block: 'nearest' });
  };
  const run = (command: string) => () => void ctx.commands.run(command).catch(refused);
  hello.addEventListener('click', run('bob.hello'));
  status.addEventListener('click', run('bob.status'));
  foreign.addEventListener('click', run('alice.hello'));
  echo.addEventListener('click', () => {
    void (async () => {
      const remote = await ctx.contracts.get('demo.echo', 1);
      show(remote ? `вид: ${await remote.say('из вида bob')}` : 'вид: эха нет');
    })().catch(refused);
  });

  drop.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    void ctx.drag.drop().then((got) => show(got ? `получен путь: ${got.path} из вида ${got.from}` : 'сброшен файл не из вида'));
  });

  const subs = [ctx.onLog((line) => show(line.text, line.at)), ctx.onVisibilityChange((visible) => show(visible ? 'вид снова показан' : 'вид скрыт, DOM жив'))];
  void ctx.logs().then((lines) => lines.forEach((line) => show(line.text, line.at)));
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}

mount satisfies UiModule<HTMLElement>['mount'];
