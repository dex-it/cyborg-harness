// Вкладки колонки справа по образцу WAI-ARIA Tabs: стрелки ходят по вкладкам, Tab уводит в открытую панель.
// Вкладки видов боковой колонки (PL-08) добавляются и снимаются на ходу по раскладке ядра; свои панели окна (плагины, документы, журнал) стоят после них.

import { el } from './dom.ts';

/** Вид боковой колонки с подписью: своя вкладка. */
export interface SidePage {
  readonly key: string;
  readonly title: string;
}

interface Page {
  readonly tab: HTMLButtonElement;
  readonly panel: HTMLElement;
  readonly root: HTMLElement;
}

export class SideTabs {
  private readonly strip: HTMLElement;
  private readonly pages = new Map<string, Page>();
  private seq = 0;

  constructor(strip: HTMLElement) {
    this.strip = strip;
    strip.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[role="tab"]') : null;
      if (tab && strip.contains(tab)) this.select(tab, false);
    });
    strip.addEventListener('keydown', (event) => {
      const tabs = this.tabs();
      const at = tabs.indexOf(event.target as HTMLButtonElement);
      if (at === -1) return;
      const last = tabs.length - 1;
      const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
      const tab = to === undefined ? undefined : tabs[to];
      if (!tab) return;
      event.preventDefault();
      this.select(tab, true);
    });
    const tabs = this.tabs();
    const open = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
    if (open) this.select(open, false);
  }

  /**
   * Вкладки видов боковой колонки по порядку раскладки: новая встаёт на своё место, снятая уходит вместе с панелью, остальные не двигаются
   * (панель с фреймом переносить нельзя: перенос перезагружает документ). Отдаёт корень каждой панели, куда окно кладёт вид.
   */
  syncPages(pages: readonly SidePage[]): ReadonlyMap<string, HTMLElement> {
    const wanted = new Set(pages.map((p) => p.key));
    const selected = this.tabs().find((t) => t.getAttribute('aria-selected') === 'true');
    for (const [key, page] of this.pages) {
      if (wanted.has(key)) continue;
      page.tab.remove();
      page.panel.remove();
      this.pages.delete(key);
    }
    let after: Element | null = null;
    for (const spec of pages) {
      let page = this.pages.get(spec.key);
      if (!page) {
        page = this.create(spec);
        this.pages.set(spec.key, page);
      }
      page.tab.textContent = spec.title;
      // Вкладка и так на месте - не двигаем: перестановка кнопок роняет фокус с неё.
      const expected: Element | null = after ? after.nextElementSibling : this.strip.firstElementChild;
      if (expected !== page.tab) this.strip.insertBefore(page.tab, expected);
      after = page.tab;
    }
    const tabs = this.tabs();
    if (selected && !tabs.includes(selected)) {
      const fallback = tabs[0];
      if (fallback) this.select(fallback, false);
    }
    return new Map([...this.pages].map(([key, page]) => [key, page.root]));
  }

  /** Открыть вкладку панели, в которой лежит `node`. */
  reveal(node: Element): void {
    const tab = this.tabs().find((t) => this.panel(t)?.contains(node));
    if (tab) this.select(tab, false);
  }

  private tabs(): HTMLButtonElement[] {
    return [...this.strip.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  }

  private create(spec: SidePage): Page {
    const id = `side-page-${String(++this.seq)}`;
    const tab = el('button', 'side-page-tab', spec.title) as HTMLButtonElement;
    tab.type = 'button';
    tab.id = `tab-${id}`;
    tab.dataset.page = spec.key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${id}`);
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = -1;
    const root = el('div', 'views views-side-page');
    const panel = el('section', 'pane pane-side-page');
    panel.id = `panel-${id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;
    panel.append(root);
    // Панели колонки стоят сразу за полосой вкладок, до собственных панелей окна.
    this.strip.after(panel);
    return { tab, panel, root };
  }

  private panel(tab: HTMLButtonElement): HTMLElement | null {
    return document.getElementById(tab.getAttribute('aria-controls') ?? '');
  }

  private select(tab: HTMLButtonElement, focus: boolean): void {
    for (const other of this.tabs()) {
      const open = other === tab;
      other.setAttribute('aria-selected', String(open));
      other.tabIndex = open ? 0 : -1;
      const panel = this.panel(other);
      if (panel) panel.hidden = !open;
    }
    if (focus) tab.focus();
  }
}
