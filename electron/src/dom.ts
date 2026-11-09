/** Элемент с классом и текстом: помощник слоя окна. У приложения свой такой же рядом с его разметкой. */
export function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
