export const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
