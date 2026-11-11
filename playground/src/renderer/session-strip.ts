// Полоса сессий (PL-08): вкладки документов основной области над панелью инструментов, WAI-ARIA Tabs.
// Состав и порядок вкладок дают документы ядра и `order` их типов (`windowPlan`); окно только рисует и ходит по ним стрелками.

import { el } from './dom.ts';
import type { StripTab } from './window-plan.ts';

export class SessionStrip {
  private readonly strip: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private active: string | undefined;
  private readonly onSelect: (id: string) => void;

  constructor(strip: HTMLElement, onSelect: (id: string) => void) {
    this.strip = strip;
    this.onSelect = onSelect;
    strip.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
      if (tab?.dataset.document !== undefined) this.choose(tab.dataset.document, false);
    });
    strip.addEventListener('keydown', (event) => {
      const tabs = [...this.buttons.values()];
      const at = tabs.indexOf(event.target as HTMLButtonElement);
      if (at === -1) return;
      const last = tabs.length - 1;
      const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
      const id = to === undefined ? undefined : tabs[to]?.dataset.document;
      if (id === undefined) return;
      event.preventDefault();
      this.choose(id, true);
    });
  }

  /** Вкладки по плану: существующие кнопки не пересоздаются (иначе перерисовка по каждому снимку роняла бы фокус), новые встают на своё место. */
  sync(tabs: readonly StripTab[], active: string | null): void {
    const wanted = new Set(tabs.map((t) => t.id));
    for (const [id, button] of this.buttons) {
      if (wanted.has(id)) continue;
      button.remove();
      this.buttons.delete(id);
    }
    let after: Element | null = null;
    for (const tab of tabs) {
      let button = this.buttons.get(tab.id);
      if (!button) {
        button = el('button', 'strip-tab') as HTMLButtonElement;
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.dataset.document = tab.id;
        this.buttons.set(tab.id, button);
      }
      button.textContent = tab.title;
      button.dataset.available = String(tab.available);
      button.title = `${tab.pluginId}${tab.available ? '' : ': владелец не работает'}`;
      const expected: Element | null = after ? after.nextElementSibling : this.strip.firstElementChild;
      if (expected !== button) this.strip.insertBefore(button, expected);
      after = button;
    }
    // Выбор человека, иначе просьба плагина, иначе первая вкладка.
    this.active = tabs.some((t) => t.id === this.active) ? this.active : tabs.some((t) => t.id === active) ? (active ?? undefined) : tabs[0]?.id;
    this.mark();
    this.strip.hidden = tabs.length === 0;
  }

  /** Просьба плагина сделать вкладку активной. */
  reveal(id: string): void {
    if (this.buttons.has(id)) {
      this.active = id;
      this.mark();
    }
  }

  /** Вкладка, на которую встанет фокус при обходе областей (`F6`). */
  focusTarget(): HTMLElement | undefined {
    return this.buttons.get(this.active ?? '') ?? [...this.buttons.values()][0];
  }

  private choose(id: string, focus: boolean): void {
    this.active = id;
    this.mark();
    if (focus) this.buttons.get(id)?.focus();
    this.onSelect(id);
  }

  private mark(): void {
    for (const [id, button] of this.buttons) {
      const open = id === this.active;
      button.setAttribute('aria-selected', String(open));
      button.tabIndex = open ? 0 : -1;
    }
  }
}
