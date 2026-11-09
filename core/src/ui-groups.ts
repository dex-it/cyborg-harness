import type { JournalEntry } from './kernel-types.ts';
import type { PluginManifest } from './manifest.ts';

const named = (groups: Readonly<Record<string, readonly string[]>>, id: string) => Object.entries(groups).find(([, ids]) => ids.includes(id))?.[0];

/**
 * Группа рендера плагина с видами: один origin `cyborg-plugin://<группа>/` и один процесс рендера на группу (SAD 3.8).
 * Просят группу `plugins.uiGroups` (выбор человека), затем `ui.group` манифеста (рекомендация автора), иначе группа - id плагина.
 * Граница доверия видов - группа: внутри неё DOM и хранилища origin общие, поэтому сторонний плагин остаётся один в своей группе;
 * исключение - воля владельца: группа в `plugins.uiGroups` слоя пользователя (ADR-CH-0015: слой воркспейса приходит из репозитория команды и сторонних в группу не сажает).
 * Плагин поставки не садится в группу, чьё имя - id стороннего плагина, оставшегося одним (его origin остаётся его одного).
 */
export function assignUiGroups(
  manifests: readonly PluginManifest[],
  groups: Readonly<Record<string, readonly string[]>>,
  userGroups: Readonly<Record<string, readonly string[]>>,
  bundled: ReadonlySet<string>,
  record: (entry: JournalEntry) => void,
): Map<string, string> {
  const withUi = manifests.filter((m) => m.ui !== undefined);
  const wanted = new Map(withUi.map((m) => [m.id, named(groups, m.id) ?? m.ui?.group ?? m.id]));
  const outsiders = withUi.filter((m) => !bundled.has(m.id));
  const result = new Map<string, string>();
  for (const m of outsiders) result.set(m.id, named(userGroups, m.id) ?? m.id);
  const alone = new Set(outsiders.filter((m) => result.get(m.id) === m.id).map((m) => m.id));
  for (const m of withUi) {
    if (!bundled.has(m.id)) continue;
    const group = wanted.get(m.id) ?? m.id;
    if (group !== m.id && alone.has(group)) {
      result.set(m.id, m.id);
      record({ pluginId: m.id, kind: 'group-isolated', group, renderGroup: m.id, reason: 'taken' });
    } else {
      result.set(m.id, group);
    }
  }
  for (const m of outsiders) {
    const group = result.get(m.id) ?? m.id;
    const mates = withUi.filter((other) => other.id !== m.id && result.get(other.id) === group).map((other) => other.id);
    const asked = wanted.get(m.id) ?? m.id;
    if (mates.length > 0) record({ pluginId: m.id, kind: 'group-shared', group, neighbours: mates });
    // Просьба о чужой группе записывается, только если в ней был бы кто-то ещё.
    else if (asked !== m.id && withUi.some((other) => other.id !== m.id && wanted.get(other.id) === asked)) {
      record({ pluginId: m.id, kind: 'group-isolated', group: asked, renderGroup: m.id, reason: 'third-party' });
    }
  }
  return result;
}
