import type { JournalEntry, Keybinding, UserKeybinding } from './kernel-types.ts';
import { normalizeKey, resolveKey } from './keys.ts';
import type { PluginManifest } from './manifest.ts';
import { KERNEL_COMMANDS, KERNEL_OWNER, WINDOW_COMMANDS, WINDOW_OWNER } from './window-layer.ts';

// Встроенный побеждает сторонний, между равными - первый по id: исход не зависит от порядка каталогов на диске.
export function bindKeys(
  manifests: readonly PluginManifest[],
  bundled: ReadonlySet<string>,
  platform: string,
  record: (entry: JournalEntry) => void,
): Map<string, Keybinding> {
  const rank = (m: PluginManifest) => [bundled.has(m.id) ? 0 : 1, m.id] as const;
  const sorted = [...manifests].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1].localeCompare(rank(b)[1]));
  const table = new Map<string, Keybinding>();
  for (const [command, key] of Object.entries(WINDOW_COMMANDS)) table.set(key, { key, command, pluginId: WINDOW_OWNER, shadowed: [] });
  for (const m of sorted) {
    for (const k of m.keybindings) {
      const key = resolveKey(k.key, platform);
      const owner = table.get(key);
      if (!owner) {
        table.set(key, { key, command: k.command, pluginId: m.id, shadowed: [] });
        continue;
      }
      table.set(key, { ...owner, shadowed: [...owner.shadowed, { pluginId: m.id, command: k.command }] });
      record({ pluginId: m.id, kind: 'key-conflict', key, command: k.command, winner: owner.pluginId });
    }
  }
  return table;
}

/** Выбор пользователя сильнее манифестов: конфликт он уже разрешил, поэтому вытесненные - в shadowed без записи о конфликте. */
export function applyUserKeys(table: Map<string, Keybinding>, user: readonly UserKeybinding[], manifests: readonly PluginManifest[], platform: string, record: (entry: JournalEntry) => void): void {
  const ownerOf = new Map([...Object.keys(WINDOW_COMMANDS).map((c) => [c, WINDOW_OWNER] as const), ...Object.values(KERNEL_COMMANDS).map((c) => [c, KERNEL_OWNER] as const), ...manifests.flatMap((m) => Object.keys(m.commands).map((c) => [c, m.id] as const))]);
  for (const u of user) {
    const normalized = normalizeKey(u.key);
    if (normalized === undefined) {
      record({ kind: 'key-ignored', key: u.key, command: u.command, reason: 'сочетание не разобрано' });
      continue;
    }
    const key = resolveKey(normalized, platform);
    const was = table.get(key);
    const shadowed = was ? [...(was.user ? [] : [{ pluginId: was.pluginId, command: was.command }]), ...was.shadowed] : [];
    if (u.command === null) {
      table.delete(key);
      continue;
    }
    const pluginId = ownerOf.get(u.command);
    if (pluginId === undefined) {
      record({ kind: 'key-ignored', key: u.key, command: u.command, reason: 'команды нет ни у одного плагина' });
      continue;
    }
    table.set(key, { key, command: u.command, pluginId, user: true, shadowed: shadowed.filter((s) => s.command !== u.command) });
  }
}
