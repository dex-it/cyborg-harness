// Логика элементов ядра без DOM: её проверяют тесты node, а DOM-часть - core/elements - только рисует и ловит события.

import type { ListItem, TreeItem } from '@cyborg/contracts';

/** Строка развёрнутого дерева в порядке показа. */
export interface TreeRow {
  readonly id: string;
  readonly label: string;
  /** С нуля. */
  readonly depth: number;
  readonly parent: string | undefined;
  readonly branch: boolean;
  readonly expanded: boolean;
}

const MAX_ITEMS = 10_000;

/** Пункты от плагина: id - непустая уникальная строка, подпись - строка; иначе TypeError с местом. */
export function checkItems(tag: string, items: unknown): readonly ListItem[] {
  if (!Array.isArray(items)) throw new TypeError(`${tag}: items - массив`);
  if (items.length > MAX_ITEMS) throw new TypeError(`${tag}: больше ${String(MAX_ITEMS)} пунктов`);
  const seen = new Set<string>();
  for (const [i, item] of (items as unknown[]).entries()) checkOne(tag, `[${String(i)}]`, item, seen);
  return items as ListItem[];
}

/** Узлы дерева: те же правила, id уникален во всём дереве. */
export function checkTree(tag: string, items: unknown): readonly TreeItem[] {
  if (!Array.isArray(items)) throw new TypeError(`${tag}: items - массив`);
  const seen = new Set<string>();
  const walk = (list: readonly unknown[], at: string) => {
    for (const [i, item] of list.entries()) {
      const where = `${at}[${String(i)}]`;
      checkOne(tag, where, item, seen);
      if (seen.size > MAX_ITEMS) throw new TypeError(`${tag}: больше ${String(MAX_ITEMS)} узлов`);
      const children = (item as { children?: unknown }).children;
      if (children === undefined) continue;
      if (!Array.isArray(children)) throw new TypeError(`${tag}: ${where}.children - массив`);
      walk(children as unknown[], `${where}.children`);
    }
  };
  walk(items as unknown[], '');
  return items as TreeItem[];
}

function checkOne(tag: string, where: string, item: unknown, seen: Set<string>): void {
  const { id, label } = (typeof item === 'object' && item !== null ? item : {}) as { id?: unknown; label?: unknown };
  if (typeof id !== 'string' || id === '') throw new TypeError(`${tag}: ${where}.id - непустая строка`);
  if (typeof label !== 'string') throw new TypeError(`${tag}: ${where}.label - строка`);
  if (seen.has(id)) throw new TypeError(`${tag}: id "${id}" повторяется`);
  seen.add(id);
}

/** Видимые строки: дети свёрнутой ветви не показываются. */
export function visibleRows(items: readonly TreeItem[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (list: readonly TreeItem[], depth: number, parent: string | undefined) => {
    for (const item of list) {
      const children = item.children;
      const open = children !== undefined && expanded.has(item.id);
      rows.push({ id: item.id, label: item.label, depth, parent, branch: children !== undefined, expanded: open });
      if (open) walk(children, depth + 1, item.id);
    }
  };
  walk(items, 0, undefined);
  return rows;
}

/** Ход по линейному списку: индекс следующего выделения или undefined, если клавиша не про ход. Без выделения вниз - первый, вверх - последний. */
export function stepIndex(index: number, count: number, key: string): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case 'ArrowDown':
      return index < 0 ? 0 : Math.min(index + 1, count - 1);
    case 'ArrowUp':
      return index < 0 ? count - 1 : Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/** Ход вкладок по кругу: вправо после последней - первая. */
export function stepTab(index: number, count: number, key: string): number | undefined {
  if (count === 0) return undefined;
  if (key === 'ArrowRight') return (index + 1 + count) % count;
  if (key === 'ArrowLeft') return index < 0 ? count - 1 : (index - 1 + count) % count;
  return key === 'Home' || key === 'End' ? stepIndex(index, count, key) : undefined;
}

export type TreeMove = { readonly select: string } | { readonly toggle: string; readonly expanded: boolean };

/** Клавиша в дереве по WAI-ARIA: вправо раскрывает ветвь, потом идёт в первого ребёнка; влево сворачивает, потом идёт к родителю. */
export function treeKey(rows: readonly TreeRow[], selected: string | undefined, key: string): TreeMove | undefined {
  const at = rows.findIndex((r) => r.id === selected);
  const row = rows[at];
  if (key === 'ArrowRight' && row?.branch) {
    if (!row.expanded) return { toggle: row.id, expanded: true };
    const child = rows[at + 1];
    return child?.parent === row.id ? { select: child.id } : undefined;
  }
  if (key === 'ArrowLeft' && row) {
    if (row.expanded) return { toggle: row.id, expanded: false };
    return row.parent === undefined ? undefined : { select: row.parent };
  }
  const next = stepIndex(at, rows.length, key);
  const target = next === undefined ? undefined : rows[next];
  return target === undefined || target.id === selected ? undefined : { select: target.id };
}
