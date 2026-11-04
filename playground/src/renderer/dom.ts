/** Элемент разметки по id с проверкой класса: опечатка в index.html падает при запуске, а не тихим null. */
export function byId<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`#${id}: ожидался ${type.name}, найден ${node ? node.constructor.name : 'никто'}`);
  return node;
}

export function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
