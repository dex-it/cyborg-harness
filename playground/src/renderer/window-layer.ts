// Слой окна (SAD §3.8): диалоги видов поверх всех фреймов и экраны замков. Что показывать, решает ядро; окно только рисует снимок.

import type { ShownDialog, WindowSnapshot } from '@cyborg-harness/core';
import type { PluginRow, Reply } from '../shared/plugins.ts';
import { el } from './dom.ts';

export interface WindowPort {
  answerDialog(id: number, choice: string | undefined): Promise<Reply>;
}

interface Open {
  readonly id: number;
  readonly dialog: HTMLDialogElement;
  /** Ответ уже ушёл или диалог снят ядром: закрытие больше не отвечает. */
  done: boolean;
}

export class WindowLayerView {
  private readonly port: WindowPort;
  private readonly main: HTMLElement;
  private readonly lockLayer: HTMLElement;
  private readonly screens = new Map<string, HTMLElement>();
  private open: Open | undefined;

  constructor(port: WindowPort, main: HTMLElement, lockLayer: HTMLElement) {
    this.port = port;
    this.main = main;
    this.lockLayer = lockLayer;
  }

  sync(window: WindowSnapshot, plugins: readonly PluginRow[]): void {
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

  // Чужие фреймы не только перекрыты, а скрыты и inert: ни мышь, ни Tab, ни экранный диктор до них не доходят.
  private syncLock(window: WindowSnapshot, plugins: readonly PluginRow[]): void {
    const locked = window.locks.length > 0;
    document.body.dataset.locked = String(locked);
    this.main.inert = locked;
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
    const scope = d.view === 'overlay' ? this.lockLayer : this.main;
    return scope.querySelector(`[data-plugin="${CSS.escape(d.pluginId)}"] iframe`);
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
