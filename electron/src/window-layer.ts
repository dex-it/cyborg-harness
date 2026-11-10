// Слой окна (SAD §3.8): диалоги видов поверх всех фреймов и экраны замков. Что показывать, решает ядро; окно только рисует снимок.

import type { ShownDialog, ShownModal, WindowSnapshot } from '@cyborg-harness/core/window';
import type { LayoutRow, PluginRow, Reply } from './snapshot.ts';
import { el } from './dom.ts';

export interface WindowPort {
  answerDialog(id: number, choice: string | undefined): Promise<Reply>;
  /** Человек закрыл модальное окно плагина в самом окне (крестик, закрытие диалога); владелец получает undefined. */
  cancelModal(id: number): Promise<Reply>;
}

interface Open {
  readonly id: number;
  readonly dialog: HTMLDialogElement;
  /** Ответ уже ушёл или диалог снят ядром: закрытие больше не отвечает. */
  done: boolean;
}

interface OpenModal {
  readonly id: number;
  readonly dialog: HTMLDialogElement;
  readonly pluginId: string;
  readonly view: string;
  readonly frame: HTMLIFrameElement | undefined;
  /** Закрытие уже ушло ядру или окно снято ядром: закрытие диалога больше не отвечает. */
  done: boolean;
}

export class WindowLayerView {
  private readonly port: WindowPort;
  private readonly main: HTMLElement;
  private readonly lockLayer: HTMLElement;
  private readonly screens = new Map<string, HTMLElement>();
  private open: Open | undefined;
  private modal: OpenModal | undefined;

  constructor(port: WindowPort, main: HTMLElement, lockLayer: HTMLElement) {
    this.port = port;
    this.main = main;
    this.lockLayer = lockLayer;
  }

  /** `layout` - раскладка ядра: адрес вида модального окна берётся из неё, как адрес любого вида. */
  sync(window: WindowSnapshot, plugins: readonly PluginRow[], layout: readonly LayoutRow[] = []): void {
    this.syncModal(window.modal, layout);
    this.syncLock(window, plugins);
    const shown = window.dialog;
    if (this.open && this.open.id !== shown?.id) {
      this.open.done = true;
      this.open.dialog.close();
      this.open.dialog.remove();
      this.open = undefined;
    }
    if (shown && !this.open) this.show(shown);
  }

  // Модальное окно плагина (K-13): <dialog> в слое поверх страницы, во фрейме его вид. showModal() запирает фокус и делает остальной документ inert;
  // `main` помечается явно, чтобы не зависеть от того, как движок считает фреймы под диалогом. Escape закрывает окно в главном процессе (`dismissModal`):
  // нажатие во фрейме вида до документа окна не доходит.
  private syncModal(shown: ShownModal | undefined, layout: readonly LayoutRow[]): void {
    if (this.modal && this.modal.id !== shown?.id) {
      this.modal.done = true;
      this.modal.dialog.close();
      this.modal.dialog.remove();
      this.modal = undefined;
    }
    if (shown && !this.modal) this.showModal(shown, layout.find((e) => e.kind === 'view' && e.pluginId === shown.pluginId && e.name === shown.view)?.url);
    this.main.inert = document.body.dataset.locked === 'true' || this.modal !== undefined;
  }

  private showModal(m: ShownModal, url: string | undefined): void {
    const dialog = el('dialog', 'layer-modal') as HTMLDialogElement;
    dialog.dataset.plugin = m.pluginId;
    dialog.dataset.view = m.view;
    dialog.dataset.modal = String(m.id);
    dialog.setAttribute('aria-label', m.title);
    const frame = url === undefined ? undefined : document.createElement('iframe');
    const open: OpenModal = { id: m.id, dialog, pluginId: m.pluginId, view: m.view, frame, done: false };
    const close = el('button', 'layer-modal-close', 'Закрыть') as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    const head = el('div', 'layer-modal-head');
    head.append(el('h3', '', m.title), el('span', 'layer-from', m.pluginId), close);
    // Фокус не уходит из окна: showModal() запирает его только в пределах документа, а Tab с последнего элемента фрейма (или Shift+Tab с первого)
    // выводит фокус за страницу (на macOS activeElement становится body). Краевые ловушки возвращают его внутрь.
    const edge = (toFirst: boolean): HTMLElement => {
      const trap = el('span', 'layer-modal-trap');
      trap.tabIndex = 0;
      trap.setAttribute('aria-hidden', 'true');
      trap.addEventListener('focus', () => (toFirst ? close : (frame ?? close)).focus());
      return trap;
    };
    dialog.append(edge(false), head);
    if (frame && url !== undefined) {
      frame.src = url;
      frame.title = `${m.pluginId}/${m.view}`;
      dialog.append(frame);
    } else dialog.append(el('p', 'layer-modal-missing', 'Вид окна недоступен'));
    dialog.append(edge(true));
    // Закрытие (кнопка, Escape в документе окна) - отмена: владелец получает undefined. Результат отдаёт сам вид через ctx.modal.close.
    dialog.addEventListener('close', () => {
      if (open.done) return;
      open.done = true;
      void this.port.cancelModal(m.id);
    });
    document.body.append(dialog);
    dialog.showModal();
    this.modal = open;
    (frame ?? close).focus();
  }

  // Чужие фреймы не только перекрыты, а скрыты и inert: ни мышь, ни Tab, ни экранный диктор до них не доходят.
  private syncLock(window: WindowSnapshot, plugins: readonly PluginRow[]): void {
    const locked = window.locks.length > 0;
    document.body.dataset.locked = String(locked);
    this.main.inert = locked || this.modal !== undefined;
    this.lockLayer.hidden = !locked;
    const wanted = new Map(window.locks.map((l) => [l.pluginId, plugins.find((p) => p.id === l.pluginId)?.overlay ?? ''] as const));
    for (const [key, screen] of this.screens) {
      const [id = '', url = ''] = key.split('\n');
      if (wanted.get(id) === url) continue;
      screen.remove();
      this.screens.delete(key);
    }
    for (const [id, url] of wanted) {
      const key = `${id}\n${url}`;
      if (this.screens.has(key)) continue;
      const screen = el('section', 'lock-screen');
      screen.dataset.plugin = id;
      if (url) {
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.title = `Замок ${id}`;
        screen.append(frame);
      } else screen.append(el('p', 'lock-wait', `Окно закрыто плагином ${id}: ждём его возвращения`));
      this.lockLayer.append(screen);
      this.screens.set(key, screen);
    }
  }

  private frameOf(d: ShownDialog): HTMLIFrameElement | null {
    // Диалог из вида модального окна встаёт у фрейма окна, а не у фрейма боковой колонки.
    if (this.modal?.pluginId === d.pluginId && this.modal.view === d.view && this.modal.frame) return this.modal.frame;
    const scope = d.view === 'overlay' ? this.lockLayer : this.main;
    // Плагин с несколькими видами: диалог ставится у фрейма своего вида (`data-view` у обёртки вида), а не у первого.
    const plugin = `[data-plugin="${CSS.escape(d.pluginId)}"]`;
    return scope.querySelector(`${plugin}[data-view="${CSS.escape(d.view)}"] iframe`) ?? scope.querySelector(`${plugin} iframe`);
  }

  private show(d: ShownDialog): void {
    const dialog = el('dialog', `layer-dialog layer-${d.spec.kind}`) as HTMLDialogElement;
    dialog.dataset.plugin = d.pluginId;
    dialog.dataset.dialog = String(d.id);
    const open: Open = { id: d.id, dialog, done: false };
    const answer = (choice: string | undefined) => {
      if (open.done) return;
      open.done = true;
      dialog.close();
      void this.port.answerDialog(d.id, choice);
    };
    const button = (id: string, label: string) => {
      const b = el('button', '', label) as HTMLButtonElement;
      b.type = 'button';
      b.dataset.choice = id;
      b.addEventListener('click', () => answer(id));
      return b;
    };
    if (d.spec.kind === 'ask') {
      dialog.setAttribute('aria-label', d.spec.title);
      const actions = el('div', 'layer-actions');
      actions.append(...d.spec.buttons.map((c) => button(c.id, c.label)));
      dialog.append(el('h3', '', d.spec.title), ...(d.spec.message === undefined ? [] : [el('p', '', d.spec.message)]), el('p', 'layer-from', `Спрашивает ${d.pluginId}`), actions);
    } else {
      dialog.setAttribute('aria-label', `Меню ${d.pluginId}`);
      const list = el('div', 'layer-items');
      list.setAttribute('role', 'menu');
      for (const c of d.spec.items) list.append(Object.assign(button(c.id, c.label), { role: 'menuitem' }));
      dialog.append(list);
      // Клик мимо меню попадает в сам <dialog> (его ::backdrop): это отмена, а не выбор.
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) answer(undefined);
      });
    }
    dialog.addEventListener('close', () => answer(undefined));
    document.body.append(dialog);
    dialog.showModal();
    if (d.spec.kind === 'menu') this.place(dialog, d.spec.at, this.frameOf(d));
    dialog.querySelector('button')?.focus();
    this.open = open;
  }

  private place(dialog: HTMLDialogElement, at: { readonly x: number; readonly y: number }, frame: HTMLIFrameElement | null): void {
    const base = frame?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const box = dialog.getBoundingClientRect();
    const left = Math.max(0, Math.min(base.left + at.x, window.innerWidth - box.width));
    const top = Math.max(0, Math.min(base.top + at.y, window.innerHeight - box.height));
    dialog.style.left = `${String(left)}px`;
    dialog.style.top = `${String(top)}px`;
  }
}
