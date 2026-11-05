// Вкладки колонки справа по образцу WAI-ARIA Tabs: стрелки ходят по вкладкам, Tab уводит в открытую панель.

export class SideTabs {
  private readonly tabs: HTMLButtonElement[];

  constructor(strip: HTMLElement) {
    this.tabs = [...strip.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    for (const tab of this.tabs) tab.addEventListener('click', () => this.select(tab, false));
    strip.addEventListener('keydown', (event) => {
      const at = this.tabs.indexOf(event.target as HTMLButtonElement);
      if (at === -1) return;
      const last = this.tabs.length - 1;
      const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
      const tab = to === undefined ? undefined : this.tabs[to];
      if (!tab) return;
      event.preventDefault();
      this.select(tab, true);
    });
    const open = this.tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? this.tabs[0];
    if (open) this.select(open, false);
  }

  /** Открыть вкладку панели, в которой лежит `node`. */
  reveal(node: Element): void {
    const tab = this.tabs.find((t) => this.panel(t)?.contains(node));
    if (tab) this.select(tab, false);
  }

  private panel(tab: HTMLButtonElement): HTMLElement | null {
    return document.getElementById(tab.getAttribute('aria-controls') ?? '');
  }

  private select(tab: HTMLButtonElement, focus: boolean): void {
    for (const other of this.tabs) {
      const open = other === tab;
      other.setAttribute('aria-selected', String(open));
      other.tabIndex = open ? 0 : -1;
      const panel = this.panel(other);
      if (panel) panel.hidden = !open;
    }
    if (focus) tab.focus();
  }
}
