import type { PluginManifest } from './manifest.ts';
import type { Area } from './manifest-layout.ts';

/*
 * Раскладка окна по манифестам (SAD 3.8): что ядро знает о месте видов и типов документов. Приложение рисует области по этому снимку
 * и не называет плагины по именам; как именно выглядит область, решает приложение, ядро задаёт род области и порядок.
 */

/** Не объявлено в манифесте: вид встаёт в боковую колонку, документ - в основную область. */
const DEFAULT_AREA = { view: 'sidebar', document: 'main' } as const satisfies Record<'view' | 'document', Area>;
/** Конец диапазона встроенных плагинов (0-1000 с шагом 100, D-00 строка 2): не объявившие порядок идут за ними. */
export const DEFAULT_ORDER = 1000;

/** `disabled` - плагин не включён, выключен человеком или сторожем; `out-of-graph` - граф контрактов его отверг. */
export type LayoutMark = 'disabled' | 'out-of-graph';

export interface LayoutEntry {
  readonly pluginId: string;
  readonly kind: 'view' | 'document';
  /** Имя вида из `ui.views` или тип документа. */
  readonly name: string;
  readonly area: Area;
  readonly order: number;
  readonly title?: string;
  /** Есть, когда места вида пустовать не должно, а плагин не работает: окно ставит заглушку. */
  readonly mark?: LayoutMark;
}

/** Сначала `order`, при равенстве id плагина, затем род (вид раньше документа) и имя: порядок не зависит от порядка манифестов. */
const compare = (a: LayoutEntry, b: LayoutEntry): number =>
  a.order - b.order || cmp(a.pluginId, b.pluginId) || KIND_RANK[a.kind] - KIND_RANK[b.kind] || cmp(a.name, b.name);

const KIND_RANK = { view: 0, document: 1 } as const satisfies Record<LayoutEntry['kind'], number>;

// Не localeCompare: порядок не должен зависеть от языка и ICU машины.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Снимок по разобранным манифестам; `markOf` говорит, почему плагин сейчас не работает. */
export function buildLayout(manifests: readonly PluginManifest[], markOf: (pluginId: string) => LayoutMark | undefined): LayoutEntry[] {
  const out: LayoutEntry[] = [];
  for (const m of manifests) {
    const mark = markOf(m.id);
    const base = { pluginId: m.id, ...(mark && { mark }) };
    for (const name of Object.keys(m.ui?.views ?? {})) {
      const place = m.ui?.placement?.[name];
      out.push({ ...base, kind: 'view', name, area: place?.area ?? DEFAULT_AREA.view, order: place?.order ?? DEFAULT_ORDER, ...(place?.title !== undefined && { title: place.title }) });
    }
    for (const [name, doc] of Object.entries(m.documents ?? {})) {
      out.push({ ...base, kind: 'document', name, area: doc.area ?? DEFAULT_AREA.document, order: doc.order ?? DEFAULT_ORDER });
    }
  }
  return out.sort(compare);
}
