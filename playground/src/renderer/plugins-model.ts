import type { PluginJournalLine, PluginRow, PluginsSnapshot, PluginState } from '../shared/plugins.ts';

export const STATE_LABEL: Record<PluginState, string> = {
  active: 'Работает',
  restarting: 'Перезапуск',
  stopped: 'Выключен',
  disabled: 'Не включён',
};

// Выключенные сверху: ради них окно и открывают.
const ORDER: Record<PluginState, number> = { stopped: 0, restarting: 1, active: 2, disabled: 3 };

export function sortedPlugins(rows: readonly PluginRow[]): PluginRow[] {
  return [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.id.localeCompare(b.id));
}

export function journalFor(lines: readonly PluginJournalLine[], pluginId: string | null): PluginJournalLine[] {
  return pluginId === null ? [...lines] : lines.filter((line) => line.plugins.includes(pluginId));
}

/** Строка под заголовком: что с ядром и сколько плагинов не работает. */
export function summary(snapshot: PluginsSnapshot): string {
  if (snapshot.phase === 'starting') return 'Ядро плагинов запускается…';
  if (snapshot.phase === 'failed') return `Ядро плагинов не запустилось: ${snapshot.error ?? 'причина неизвестна'}`;
  const enabled = snapshot.plugins.filter((p) => p.state !== 'disabled');
  if (enabled.length === 0) return 'Включённых плагинов нет: список включённых - plugins.enabled в cyborg.json в папке настроек Cyborg.';
  const count = (state: PluginState) => enabled.filter((p) => p.state === state).length;
  const parts = [`работает: ${count('active')} из ${enabled.length}`];
  if (count('restarting')) parts.push(`ждут перезапуска: ${count('restarting')}`);
  if (count('stopped')) parts.push(`выключено: ${count('stopped')}`);
  return parts.join(', ');
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
