// Данные свойств и событий элементов ядра; теги и атрибуты - README.md рядом.

/** Пункт `<cy-list>`. */
export interface ListItem {
  readonly id: string;
  readonly label: string;
  /** Вторая строка, приглушённая. */
  readonly detail?: string;
}

/** Узел `<cy-tree>`: с `children` - ветвь, без - лист. */
export interface TreeItem {
  readonly id: string;
  readonly label: string;
  readonly children?: readonly TreeItem[];
}

/** Вкладка `<cy-tabs>`. */
export interface TabItem {
  readonly id: string;
  readonly label: string;
}

/** `detail` событий `cy-select` и `cy-activate`. */
export interface ItemEventDetail {
  readonly id: string;
}

/** `detail` события `cy-toggle` дерева. */
export interface ToggleEventDetail {
  readonly id: string;
  readonly expanded: boolean;
}

export type ElementTag = 'cy-button' | 'cy-field' | 'cy-list' | 'cy-tree' | 'cy-tabs' | 'cy-empty' | 'cy-spinner';
