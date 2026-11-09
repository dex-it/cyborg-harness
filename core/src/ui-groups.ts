import type { JournalEntry } from './kernel-types.ts';
import type { PluginManifest } from './manifest.ts';

/**
 * Группа рендера плагина с видами: один origin `cyborg-plugin://<группа>/` и один процесс рендера на группу (SAD 3.8).
 * Просят группу `plugins.uiGroups` (выбор человека), затем `ui.group` манифеста (рекомендация автора), иначе группа - id плагина.
 * Граница доверия видов - группа: внутри неё DOM и хранилища origin общие, поэтому сторонний плагин не делит группу ни с кем,
 * а плагин поставки не садится в группу, чьё имя - id стороннего (его origin остаётся его одного).
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
  const solo = new Set(withUi.filter((m) => !bundled.has(m.id)).map((m) => m.id));
  for (const m of withUi) {
    const group = wanted.get(m.id) ?? m.id;
    if (solo.has(m.id)) {
      result.set(m.id, m.id);
      // Просьба о группе записывается, только если в ней был бы кто-то ещё.
      if (group !== m.id && withUi.some((other) => other.id !== m.id && wanted.get(other.id) === group)) {
        record({ pluginId: m.id, kind: 'group-isolated', group, renderGroup: m.id, reason: 'third-party' });
      }
    } else if (solo.has(group) && group !== m.id) {
      result.set(m.id, m.id);
      record({ pluginId: m.id, kind: 'group-isolated', group, renderGroup: m.id, reason: 'taken' });
    } else {
      result.set(m.id, group);
    }
  }
  return result;
}
