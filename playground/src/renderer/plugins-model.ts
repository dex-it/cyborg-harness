import type { FeedLine, KeyRow, LayoutRow, PluginJournalLine, PluginRow, PluginsSnapshot, PluginState } from '../shared/plugins.ts';

export const STATE_LABEL: Record<PluginState, string> = {
  active: 'Работает',
  waiting: 'Ждёт вызова',
  restarting: 'Перезапуск',
  stopped: 'Выключен',
  disabled: 'Не включён',
};

// Выключенные сверху: ради них окно и открывают.
const ORDER: Record<PluginState, number> = { stopped: 0, restarting: 1, active: 2, waiting: 3, disabled: 4 };

export function sortedPlugins(rows: readonly PluginRow[]): PluginRow[] {
  return [...rows].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.id.localeCompare(b.id));
}

/** Что показать на месте вида: фрейм, фрейм под плашкой или заглушку. */
export function viewMode(row: PluginRow, entry: LayoutRow): 'frame' | 'restarting' | 'placeholder' | undefined {
  if (entry.url === undefined) return undefined;
  if (entry.mark !== undefined || row.state === 'stopped') return 'placeholder';
  return row.state === 'restarting' ? 'restarting' : 'frame';
}

export interface ViewSlot {
  /** Плагин и вид: у плагина их может быть несколько. */
  readonly key: string;
  readonly row: PluginRow;
  readonly entry: LayoutRow;
  readonly mode: NonNullable<ReturnType<typeof viewMode>>;
}

/** Виды раскладки в порядке ядра; документы, виды без адреса и плагины, которых нет в списке, окно не рисует. */
export function viewSlots(plugins: readonly PluginRow[], layout: readonly LayoutRow[]): ViewSlot[] {
  const rows = new Map(plugins.map((p) => [p.id, p]));
  return layout.flatMap((entry) => {
    const row = rows.get(entry.pluginId);
    const mode = row && entry.kind === 'view' ? viewMode(row, entry) : undefined;
    return row && mode ? [{ key: `${entry.pluginId}/${entry.name}`, row, entry, mode }] : [];
  });
}

export type Action = 'run' | 'disable' | 'enable' | 'crash' | 'hang' | 'journal';

export interface ActionButton {
  readonly action: Action;
  readonly label: string;
  /** Команда для `run`. */
  readonly command?: string;
  readonly primary?: boolean;
}

/** Кнопки строки плагина по его состоянию: у работающего - команды и то, чем его снять, у выключенного - чем вернуть. */
export function actionsFor(row: PluginRow, canHang: boolean): ActionButton[] {
  const journal: ActionButton = { action: 'journal', label: 'Журнал' };
  if (row.state === 'active') {
    const hosted = row.pid !== undefined;
    return [
      ...row.commands.map((command): ActionButton => ({ action: 'run', label: command, command })),
      { action: 'disable', label: 'Выгрузить' },
      ...(hosted ? [{ action: 'crash', label: 'Уронить хост' } as const] : []),
      ...(hosted && canHang ? [{ action: 'hang', label: 'Повесить хост' } as const] : []),
      journal,
    ];
  }
  // Команда будит ленивый плагин: ядро активирует его перед вызовом.
  if (row.state === 'waiting') return [...row.commands.map((command): ActionButton => ({ action: 'run', label: command, command })), { action: 'disable', label: 'Выгрузить' }, journal];
  if (row.state === 'stopped' && row.revivable) return [{ action: 'enable', label: row.unloaded ? 'Загрузить' : 'Включить снова', primary: true }, journal];
  return [journal];
}

/** Что будет с нажатием: ядро заберёт, окно получит, потому что владелец не работает. */
export function keyStatus(row: KeyRow): string {
  return row.live ? 'перехват' : `${row.pluginId} не работает - нажатие уйдёт в окно`;
}

export function conflictText(row: KeyRow): string | undefined {
  if (row.shadowed.length === 0) return undefined;
  return `конфликт: ${row.shadowed.map((s) => `${s.command} (${s.pluginId})`).join(', ')} не получает сочетание`;
}

/** Лента: строки ядра и нажатия, дошедшие до окна, по времени. */
export function mergeFeed(core: readonly FeedLine[], local: readonly FeedLine[]): FeedLine[] {
  return [...core, ...local].sort((a, b) => a.at - b.at);
}

export function journalFor(lines: readonly PluginJournalLine[], pluginId: string | null): PluginJournalLine[] {
  return pluginId === null ? [...lines] : lines.filter((line) => line.plugins.includes(pluginId));
}

/** Строка под заголовком: что с ядром и сколько плагинов не работает. */
export function summary(snapshot: PluginsSnapshot): string {
  if (snapshot.phase === 'no-workspace') return 'Воркспейс не открыт: выберите его в «Недавних» или кнопкой «Открыть…».';
  if (snapshot.phase === 'starting') return 'Ядро плагинов запускается…';
  if (snapshot.phase === 'failed') return `Ядро плагинов не запустилось: ${snapshot.error ?? 'причина неизвестна'}`;
  const enabled = snapshot.plugins.filter((p) => p.state !== 'disabled');
  if (snapshot.safeMode) return `Безопасный режим: включённых плагинов ${enabled.length}, их код не запускается.`;
  if (enabled.length === 0) return 'Включённых плагинов нет: список включённых - plugins.enabled в cyborg.json в папке настроек Cyborg.';
  const count = (state: PluginState) => enabled.filter((p) => p.state === state).length;
  const parts = [`работает: ${count('active')} из ${enabled.length}`];
  if (count('waiting')) parts.push(`ждут вызова: ${count('waiting')}`);
  if (count('restarting')) parts.push(`ждут перезапуска: ${count('restarting')}`);
  if (count('stopped')) parts.push(`выключено: ${count('stopped')}`);
  return parts.join(', ');
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
