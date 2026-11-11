// Модель раскладки окна (PL-08, SAD §3.8): что стоит в каждой области окна и в каком порядке.
// Место и порядок вида и типа документа задаёт снимок ядра (`Kernel.layout`); окно знает только свои области и плагины по именам не называет.

import type { LayoutRow, PluginRow, PluginsSnapshot } from '@cyborg-harness/electron/window';
import { viewSlots, type ViewSlot } from './plugins-model.ts';

/** Вкладка полосы сессий: документ основной области. */
export interface StripTab {
  readonly id: string;
  readonly title: string;
  readonly pluginId: string;
  /** Владелец не работает: вкладка остаётся и показана недоступной. */
  readonly available: boolean;
}

export interface WindowPlan {
  /** Панель инструментов основной области. */
  readonly toolbar: readonly ViewSlot[];
  /** Основная область: виды друг под другом, порядок задаёт `order`. */
  readonly main: readonly ViewSlot[];
  /** Выезжающая панель. */
  readonly popup: readonly ViewSlot[];
  /** Боковая колонка: виды с `title` - каждый своей вкладкой, подписью служит `title`. */
  readonly sideTabs: readonly ViewSlot[];
  /** Боковая колонка: виды без `title` делят одну общую сетку. */
  readonly sidebar: readonly ViewSlot[];
  /** Полоса сессий: вкладки документов основной области. */
  readonly strip: readonly StripTab[];
}

/** Документы идут по `order` своего типа, внутри типа - по порядку открытия; тип, которого в снимке нет (плагин не загружен), встаёт в конец. */
function stripTabs(layout: readonly LayoutRow[], documents: PluginsSnapshot['documents']): StripTab[] {
  const types = new Map(layout.filter((e) => e.kind === 'document').map((e) => [`${e.pluginId}/${e.name}`, e]));
  const placed = documents.flatMap((d, opened) => {
    const entry = types.get(`${d.pluginId}/${d.type}`);
    if (entry !== undefined && entry.area !== 'main') return [];
    return [{ tab: { id: d.id, title: d.title, pluginId: d.pluginId, available: d.available }, order: entry?.order ?? Number.POSITIVE_INFINITY, opened }];
  });
  // Не `a.order - b.order`: бесконечность минус бесконечность - NaN.
  return placed.sort((a, b) => (a.order === b.order ? a.opened - b.opened : a.order < b.order ? -1 : 1)).map((p) => p.tab);
}

export function windowPlan(plugins: readonly PluginRow[], layout: readonly LayoutRow[], documents: PluginsSnapshot['documents']): WindowPlan {
  const slots = viewSlots(plugins, layout);
  const inArea = (area: LayoutRow['area']) => slots.filter((s) => s.entry.area === area);
  const sidebar = inArea('sidebar');
  return {
    toolbar: inArea('toolbar'),
    main: inArea('main'),
    popup: inArea('popup'),
    sideTabs: sidebar.filter((s) => s.entry.title !== undefined),
    sidebar: sidebar.filter((s) => s.entry.title === undefined),
    strip: stripTabs(layout, documents),
  };
}
