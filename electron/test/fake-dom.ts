// Минимальный DOM для проверки слоя окна без Electron и без браузера: ровно то, к чему обращается window-layer.ts.
// Подделка не повторяет движок (событие `close` у <dialog> здесь синхронное, фокус - просто запись): она даёт тесту видеть, что слой построил и что вызвал.

export interface FakeEvent {
  readonly type: string;
  target: FakeElement | undefined;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type Listener = (event: FakeEvent) => void;

export class FakeElement {
  readonly tagName: string;
  readonly document: FakeDocument;
  className = '';
  textContent = '';
  hidden = false;
  inert = false;
  tabIndex = -1;
  src = '';
  title = '';
  type = '';
  role = '';
  open = false;
  /** Сколько раз вызвали `showModal` и `close`: слой не должен делать лишнего. */
  showModalCalls = 0;
  closeCalls = 0;
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  children: (FakeElement | string)[] = [];
  parent: FakeElement | undefined;
  rect = { left: 0, top: 0, width: 100, height: 50 };
  readonly #listeners = new Map<string, Listener[]>();

  constructor(tagName: string, document: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.document = document;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node !== 'string') {
        node.remove();
        node.parent = this;
      }
      this.children.push(node);
    }
  }

  remove(): void {
    const parent = this.parent;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  /** Событие движка: слушатели зовутся по порядку, возвращается само событие, чтобы тест видел `defaultPrevented`. */
  dispatch(type: string, target: FakeElement | undefined = this): FakeEvent {
    const event: FakeEvent = {
      type,
      target,
      defaultPrevented: false,
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
    return event;
  }

  focus(): void {
    this.document.activeElement = this;
    this.dispatch('focus');
  }

  showModal(): void {
    this.showModalCalls++;
    this.open = true;
  }

  /** Закрытый диалог шлёт `close`; повторное закрытие закрытого - ничего. */
  close(): void {
    this.closeCalls++;
    if (!this.open) return;
    this.open = false;
    this.dispatch('close');
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }

  /** Поиск окна по меню: слой ставит меню у фрейма вида, а в этих проверках фреймов вида нет. */
  querySelector(): FakeElement | null {
    return null;
  }

  /** Все потомки (в глубину) с таким тегом. */
  all(tag: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (child.tagName === tag.toUpperCase()) found.push(child);
      found.push(...child.all(tag));
    }
    return found;
  }

  /** Потомки с классом. */
  withClass(name: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (child.className.split(' ').includes(name)) found.push(child);
      found.push(...child.withClass(name));
    }
    return found;
  }
}

export class FakeDocument {
  readonly body = new FakeElement('body', this);
  activeElement: FakeElement | undefined;

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
}

/** Ставит подделку на globalThis (`document`, `window`, `CSS`), как их видит код окна; возвращает документ и снятие. */
export function installFakeDom(): { readonly document: FakeDocument; readonly restore: () => void } {
  const document = new FakeDocument();
  const saved = (['document', 'window', 'CSS'] as const).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const set = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  set('document', document);
  set('window', { innerWidth: 1000, innerHeight: 800 });
  set('CSS', { escape: (value: string) => value });
  return {
    document,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
