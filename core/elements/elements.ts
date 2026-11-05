// Элементы ядра (SAD2 §3.8): оболочка вида определяет их до mount, так что плагин не подменит cy-* своим классом.

import type { ItemEventDetail, ListItem, TabItem, ToggleEventDetail, TreeItem } from '@cyborg/contracts';
import { checkItems, checkTree, stepIndex, stepTab, treeKey, visibleRows, type TreeRow } from '../src/elements-model.ts';

// Сконструированные таблицы CSSOM не зависят от style-src окна: строгий CSP без 'unsafe-inline' резал бы <style> в тени.
function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}

const BASE = sheet(`
  :host { font: inherit; color: var(--cy-fg, CanvasText); box-sizing: border-box; }
  :host([hidden]) { display: none; }
  *, *::before, *::after { box-sizing: inherit; }
  :focus-visible { outline: 2px solid var(--cy-accent, Highlight); outline-offset: 1px; }
`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

abstract class CyElement extends HTMLElement {
  protected readonly root: ShadowRoot;

  protected constructor(css: string, delegatesFocus: boolean) {
    super();
    this.root = this.attachShadow({ mode: 'open', delegatesFocus });
    this.root.adoptedStyleSheets = [BASE, sheet(css)];
  }

  protected fire(type: string, detail: ItemEventDetail | ToggleEventDetail): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  protected flag(name: string, on: boolean): void {
    this.toggleAttribute(name, on);
  }
}

class CyButton extends CyElement {
  static readonly observedAttributes = ['disabled'];
  readonly #button = el('button', { type: 'button' });

  constructor() {
    super(
      `:host { display: inline-block; }
       button { font: inherit; color: inherit; padding: 3px 10px; border: 1px solid var(--cy-border, ButtonBorder); border-radius: var(--cy-radius, 4px);
         background: var(--cy-surface, ButtonFace); cursor: pointer; }
       button:hover:not(:disabled) { border-color: var(--cy-accent, Highlight); }
       button:disabled { opacity: .5; cursor: default; }
       :host([variant="primary"]) button { background: var(--cy-accent, Highlight); color: var(--cy-bg, Canvas); border-color: transparent; }
       :host([variant="danger"]) button { color: var(--cy-danger, #cf222e); }`,
      true,
    );
    this.#button.part.add('button');
    this.#button.append(el('slot'));
    this.root.append(this.#button);
    // Нажатие без пути через внутреннюю кнопку (host.click()) не должно обходить disabled.
    this.addEventListener('click', (event) => {
      if (!this.disabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(on: boolean) {
    this.flag('disabled', on);
  }

  attributeChangedCallback(): void {
    this.#button.disabled = this.disabled;
  }
}

class CyField extends CyElement {
  static readonly observedAttributes = ['label', 'placeholder', 'value', 'type', 'disabled'];
  readonly #caption = el('span');
  readonly #input = el('input');

  constructor() {
    super(
      `:host { display: block; }
       label { display: flex; flex-direction: column; gap: 2px; }
       span { color: var(--cy-muted, GrayText); }
       span:empty { display: none; }
       input { font: inherit; color: inherit; padding: 3px 6px; background: var(--cy-bg, Field); border: 1px solid var(--cy-border, ButtonBorder);
         border-radius: var(--cy-radius, 4px); }
       input:focus-visible { outline: none; border-color: var(--cy-accent, Highlight); }`,
      true,
    );
    this.#input.part.add('input');
    const label = el('label');
    label.append(this.#caption, this.#input);
    this.root.append(label);
    // change не composed: снаружи тени его не видно без пересылки.
    this.#input.addEventListener('change', () => this.dispatchEvent(new Event('change', { bubbles: true })));
  }

  get value(): string {
    return this.#input.value;
  }

  set value(text: string) {
    this.#input.value = text;
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled');
  }

  set disabled(on: boolean) {
    this.flag('disabled', on);
  }

  attributeChangedCallback(name: string, _old: string | null, next: string | null): void {
    if (name === 'label') this.#caption.textContent = next ?? '';
    else if (name === 'placeholder') this.#input.placeholder = next ?? '';
    else if (name === 'value') this.#input.value = next ?? '';
    else if (name === 'type') this.#input.type = next === 'search' || next === 'password' ? next : 'text';
    else this.#input.disabled = next !== null;
  }
}

const ROWS_CSS = `
  :host { display: block; overflow: auto; }
  [role="listbox"], [role="tree"] { margin: 0; padding: 0; list-style: none; outline: none; min-height: 100%; }
  [role="option"], [role="treeitem"] { display: flex; gap: var(--cy-gap, 6px); align-items: baseline; padding: 2px 8px; cursor: default; border-radius: var(--cy-radius, 4px); }
  [aria-selected="true"] { background: var(--cy-surface, SelectedItem); }
  :focus-within [aria-selected="true"] { background: var(--cy-accent, Highlight); color: var(--cy-bg, Canvas); }
  :focus-within [aria-selected="true"] small { color: inherit; }
  small { color: var(--cy-muted, GrayText); }
  .twisty { width: 1em; flex: none; text-align: center; color: var(--cy-muted, GrayText); }
`;

/** Общая часть списка и дерева: одно выделение, фокус на контейнере, активный пункт - aria-activedescendant. */
abstract class RowsElement extends CyElement {
  static readonly observedAttributes = ['selected', 'label'];
  protected readonly box: HTMLUListElement;

  protected constructor(role: 'listbox' | 'tree') {
    super(ROWS_CSS, true);
    this.box = el('ul', { tabIndex: 0 });
    this.box.setAttribute('role', role);
    this.root.append(this.box);
    this.box.addEventListener('keydown', (event) => {
      if (this.onKey(event.key)) event.preventDefault();
    });
  }

  get selected(): string | undefined {
    return this.getAttribute('selected') ?? undefined;
  }

  set selected(id: string | undefined) {
    if (id === undefined) this.removeAttribute('selected');
    else this.setAttribute('selected', id);
  }

  attributeChangedCallback(name: string, _old: string | null, next: string | null): void {
    if (name === 'label') {
      if (next === null) this.box.removeAttribute('aria-label');
      else this.box.setAttribute('aria-label', next);
    } else this.render();
  }

  /** Выделение человеком: атрибут и событие; программное `selected` события не шлёт. */
  protected choose(id: string): void {
    if (id === this.selected) return;
    this.selected = id;
    this.fire('cy-select', { id });
  }

  protected row(id: string, index: number): HTMLLIElement {
    const li = el('li', { id: `row-${String(index)}` });
    li.dataset.id = id;
    const on = id === this.selected;
    li.setAttribute('aria-selected', String(on));
    if (on) {
      this.box.setAttribute('aria-activedescendant', li.id);
      queueMicrotask(() => li.scrollIntoView({ block: 'nearest' }));
    }
    li.addEventListener('click', () => this.choose(id));
    li.addEventListener('dblclick', () => this.fire('cy-activate', { id }));
    return li;
  }

  protected abstract render(): void;
  protected abstract onKey(key: string): boolean;
}

class CyList extends RowsElement {
  #items: readonly ListItem[] = [];

  constructor() {
    super('listbox');
    this.root.append(el('slot', { name: 'empty' }));
  }

  get items(): readonly ListItem[] {
    return this.#items;
  }

  set items(items: readonly ListItem[]) {
    this.#items = checkItems('cy-list', items);
    this.render();
  }

  protected render(): void {
    this.box.removeAttribute('aria-activedescendant');
    this.box.replaceChildren(
      ...this.#items.map((item, i) => {
        const li = this.row(item.id, i);
        li.setAttribute('role', 'option');
        li.append(el('span', { textContent: item.label }));
        if (item.detail !== undefined) li.append(el('small', { textContent: item.detail }));
        return li;
      }),
    );
    this.box.hidden = this.#items.length === 0;
  }

  protected onKey(key: string): boolean {
    const at = this.#items.findIndex((i) => i.id === this.selected);
    if (key === 'Enter') {
      const item = this.#items[at];
      if (item) this.fire('cy-activate', { id: item.id });
      return item !== undefined;
    }
    const next = stepIndex(at, this.#items.length, key);
    const item = next === undefined ? undefined : this.#items[next];
    if (item) this.choose(item.id);
    return next !== undefined;
  }
}

class CyTree extends RowsElement {
  #items: readonly TreeItem[] = [];
  #expanded = new Set<string>();
  #rows: TreeRow[] = [];

  constructor() {
    super('tree');
  }

  get items(): readonly TreeItem[] {
    return this.#items;
  }

  set items(items: readonly TreeItem[]) {
    this.#items = checkTree('cy-tree', items);
    this.render();
  }

  get expanded(): readonly string[] {
    return [...this.#expanded];
  }

  set expanded(ids: readonly string[]) {
    this.#expanded = new Set(ids);
    this.render();
  }

  #toggle(id: string, open: boolean): void {
    if (open) this.#expanded.add(id);
    else this.#expanded.delete(id);
    this.render();
    this.fire('cy-toggle', { id, expanded: open });
  }

  protected render(): void {
    this.#rows = visibleRows(this.#items, this.#expanded);
    this.box.removeAttribute('aria-activedescendant');
    this.box.replaceChildren(
      ...this.#rows.map((r, i) => {
        const li = this.row(r.id, i);
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-level', String(r.depth + 1));
        if (r.branch) li.setAttribute('aria-expanded', String(r.expanded));
        li.style.paddingInlineStart = `calc(${String(r.depth)} * 1.2em + 8px)`;
        const twisty = el('span', { className: 'twisty', textContent: r.branch ? (r.expanded ? '▾' : '▸') : '' });
        twisty.setAttribute('aria-hidden', 'true');
        if (r.branch) twisty.addEventListener('click', () => this.#toggle(r.id, !r.expanded));
        li.append(twisty, el('span', { textContent: r.label }));
        return li;
      }),
    );
  }

  protected onKey(key: string): boolean {
    if (key === 'Enter') {
      const id = this.selected;
      if (id !== undefined && this.#rows.some((r) => r.id === id)) this.fire('cy-activate', { id });
      return id !== undefined;
    }
    const move = treeKey(this.#rows, this.selected, key);
    if (move === undefined) return ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key);
    if ('select' in move) this.choose(move.select);
    else this.#toggle(move.toggle, move.expanded);
    return true;
  }
}

class CyTabs extends CyElement {
  static readonly observedAttributes = ['selected', 'label'];
  readonly #strip = el('div');
  #tabs: readonly TabItem[] = [];

  constructor() {
    super(
      `:host { display: block; border-bottom: 1px solid var(--cy-border, ButtonBorder); }
       div { display: flex; gap: 2px; overflow-x: auto; }
       button { font: inherit; color: var(--cy-muted, GrayText); background: none; border: 0; border-bottom: 2px solid transparent; padding: 4px 10px; cursor: pointer; }
       button[aria-selected="true"] { color: inherit; border-bottom-color: var(--cy-accent, Highlight); }`,
      true,
    );
    this.#strip.setAttribute('role', 'tablist');
    this.root.append(this.#strip);
    this.#strip.addEventListener('keydown', (event) => {
      const at = this.#tabs.findIndex((t) => t.id === this.#current());
      const next = stepTab(at, this.#tabs.length, event.key);
      const tab = next === undefined ? undefined : this.#tabs[next];
      if (!tab) return;
      event.preventDefault();
      this.#choose(tab.id);
      this.#strip.querySelector<HTMLButtonElement>(`[data-id="${CSS.escape(tab.id)}"]`)?.focus();
    });
  }

  get tabs(): readonly TabItem[] {
    return this.#tabs;
  }

  set tabs(tabs: readonly TabItem[]) {
    this.#tabs = checkItems('cy-tabs', tabs);
    this.#render();
  }

  get selected(): string | undefined {
    return this.getAttribute('selected') ?? undefined;
  }

  set selected(id: string | undefined) {
    if (id === undefined) this.removeAttribute('selected');
    else this.setAttribute('selected', id);
  }

  attributeChangedCallback(name: string, _old: string | null, next: string | null): void {
    if (name === 'label') {
      if (next === null) this.#strip.removeAttribute('aria-label');
      else this.#strip.setAttribute('aria-label', next);
    } else this.#render();
  }

  /** Без выбранной вкладки выделена первая: ход стрелкой идёт от неё. */
  #current(): string | undefined {
    return this.#tabs.some((t) => t.id === this.selected) ? this.selected : this.#tabs[0]?.id;
  }

  #choose(id: string): void {
    if (id === this.#current()) return;
    this.selected = id;
    this.fire('cy-select', { id });
  }

  #render(): void {
    const current = this.#current();
    this.#strip.replaceChildren(
      ...this.#tabs.map((tab) => {
        const on = tab.id === current;
        const b = el('button', { type: 'button', textContent: tab.label, tabIndex: on ? 0 : -1 });
        b.dataset.id = tab.id;
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(on));
        b.addEventListener('click', () => this.#choose(tab.id));
        return b;
      }),
    );
  }
}

class CyEmpty extends CyElement {
  static readonly observedAttributes = ['heading'];
  readonly #heading = el('strong');

  constructor() {
    super(
      `:host { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 16px; text-align: center; color: var(--cy-muted, GrayText); }
       strong { color: var(--cy-fg, CanvasText); font-weight: 600; }
       strong:empty { display: none; }`,
      false,
    );
    this.root.append(this.#heading, el('slot'));
  }

  attributeChangedCallback(_name: string, _old: string | null, next: string | null): void {
    this.#heading.textContent = next ?? '';
  }
}

class CySpinner extends CyElement {
  static readonly observedAttributes = ['label'];
  readonly #label = el('span', { className: 'label', textContent: 'Загрузка' });

  constructor() {
    super(
      `:host { display: inline-flex; align-items: center; gap: var(--cy-gap, 6px); color: var(--cy-muted, GrayText); }
       .ring { width: 1em; height: 1em; border: 2px solid var(--cy-border, GrayText); border-top-color: var(--cy-accent, Highlight); border-radius: 50%;
         animation: spin .8s linear infinite; }
       @keyframes spin { to { transform: rotate(1turn); } }
       @media (prefers-reduced-motion: reduce) { .ring { animation-duration: 3s; } }`,
      false,
    );
    const ring = el('span', { className: 'ring' });
    ring.setAttribute('aria-hidden', 'true');
    this.root.append(ring, this.#label);
  }

  connectedCallback(): void {
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
  }

  attributeChangedCallback(_name: string, _old: string | null, next: string | null): void {
    this.#label.textContent = next ?? 'Загрузка';
  }
}

const ELEMENTS = { 'cy-button': CyButton, 'cy-field': CyField, 'cy-list': CyList, 'cy-tree': CyTree, 'cy-tabs': CyTabs, 'cy-empty': CyEmpty, 'cy-spinner': CySpinner } as const;

/** Определяет элементы ядра; повторный вызов ничего не меняет. */
export function defineElements(registry: CustomElementRegistry = customElements): void {
  for (const [tag, cls] of Object.entries(ELEMENTS)) if (!registry.get(tag)) registry.define(tag, cls);
}

declare global {
  interface HTMLElementTagNameMap {
    'cy-button': CyButton;
    'cy-field': CyField;
    'cy-list': CyList;
    'cy-tree': CyTree;
    'cy-tabs': CyTabs;
    'cy-empty': CyEmpty;
    'cy-spinner': CySpinner;
  }
}
