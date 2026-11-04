// Окно «Плагины Cyborg»: снимок, который главный процесс отдаёт интерфейсу (SAD2 §3.2, §3.5).

export type PluginState = 'active' | 'restarting' | 'stopped' | 'disabled';

export interface PluginRow {
  readonly id: string;
  readonly version?: string;
  /** Хост, в котором плагин работает или работал бы; у невключённых нет. */
  readonly host?: string;
  readonly state: PluginState;
  /** Причина состояния словами из журнала. */
  readonly reason?: string;
  readonly revivable: boolean;
}

export interface PluginJournalLine {
  /** Время записи, мс от эпохи. */
  readonly at: number;
  /** Чьё это: id плагина или «хост <id>». */
  readonly subject: string;
  /** Плагины, которых касается запись: по ним окно отбирает журнал одного плагина. */
  readonly plugins: readonly string[];
  readonly text: string;
  readonly level: 'info' | 'warn' | 'error';
}

export interface PluginsSnapshot {
  readonly phase: 'starting' | 'ready' | 'failed';
  readonly error?: string;
  /** Что не дошло до ядра: битый cyborg.json, непрочитанный манифест. */
  readonly problems: readonly string[];
  readonly plugins: readonly PluginRow[];
  readonly journal: readonly PluginJournalLine[];
}
