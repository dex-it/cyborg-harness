import type { JournalEntry } from './kernel-types.ts';
import type { PluginManifest } from './manifest.ts';

/**
 * Знак стороннего одиночки в имени группы рендера. Origin вида - `cyborg-plugin://<группа>`, а сессия приложения постоянная, поэтому веб-хранилище origin
 * переживает перезапуск: имя группы поставки (из `ui.group`, `plugins.uiGroups`) не должно совпасть с origin стороннего плагина ни в этой загрузке, ни в следующей.
 * Подчёркивания нет ни в id плагина, ни в имени группы (строчные латинские буквы, цифры, дефис, точка), поэтому пространства не пересекаются по синтаксису.
 */
export const SOLO_GROUP_PREFIX = 'solo_';

/**
 * Группа рендера плагина с видами: один origin `cyborg-plugin://<группа>/` и один процесс рендера на группу (SAD 3.8).
 * Просят группу `plugins.uiGroups` (выбор человека), затем `ui.group` манифеста (рекомендация автора), иначе группа - id плагина.
 * Граница доверия видов - группа: внутри неё DOM и хранилища origin общие, поэтому сторонний плагин не делит группу ни с кем
 * и живёт в отдельном пространстве имён (`solo_<id>`), которого у групп поставки нет.
 */
export function assignUiGroups(
  manifests: readonly PluginManifest[],
  groups: Readonly<Record<string, readonly string[]>>,
  bundled: ReadonlySet<string>,
  record: (entry: JournalEntry) => void,
): Map<string, string> {
  const withUi = manifests.filter((m) => m.ui !== undefined);
  const named = (id: string) => Object.entries(groups).find(([, ids]) => ids.includes(id))?.[0];
  const wanted = new Map(withUi.map((m) => [m.id, named(m.id) ?? m.ui?.group ?? m.id]));
  const result = new Map<string, string>();
  for (const m of withUi) {
    const group = wanted.get(m.id) ?? m.id;
    if (bundled.has(m.id)) {
      result.set(m.id, group);
      continue;
    }
    result.set(m.id, `${SOLO_GROUP_PREFIX}${m.id}`);
    // Просьба о группе записывается, только если в ней был бы кто-то ещё.
    if (group !== m.id && withUi.some((other) => other.id !== m.id && wanted.get(other.id) === group)) {
      record({ pluginId: m.id, kind: 'group-isolated', group, renderGroup: m.id, reason: 'third-party' });
    }
  }
  return result;
}
