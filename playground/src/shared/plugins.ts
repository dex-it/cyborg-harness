import type { FeedLine, Reply } from '@cyborg/contracts';

export type { FeedLine, Reply };
// Окно playground: снимок, который главный процесс отдаёт интерфейсу (SAD2 §3.2, §3.5).

export type PluginState = 'active' | 'restarting' | 'stopped' | 'disabled';

export interface PluginRow {
  readonly id: string;
  readonly version?: string;
  /** Хост, в котором плагин работает или работал бы; у невключённых нет. */
  readonly host?: string;
  /** Процесс хоста; есть, пока хост жив и он отдельный процесс. */
  readonly pid?: number;
  readonly state: PluginState;
  /** Причина состояния словами из журнала. */
  readonly reason?: string;
  readonly revivable: boolean;
  /** Выгружен кнопкой, а не сбоем: на кнопке «Загрузить», а не «Включить снова». */
  readonly unloaded: boolean;
  /** Свои команды без обязательных аргументов: их можно вызвать кнопкой. */
  readonly commands: readonly string[];
  /** Права главной части словами - те же строки покажет окно согласия. */
  readonly permissions: readonly string[];
  /** Адрес вида для <iframe>: есть у активного плагина с каталогом view. */
  readonly view?: string;
}

export interface KeyRow {
  /** Как нажимать на этой платформе: `Ctrl+Shift+A`, на macOS `Meta+Shift+A`. */
  readonly key: string;
  readonly command: string;
  readonly pluginId: string;
  /** Владелец активен: ядро перехватит нажатие, окно его не получит. */
  readonly live: boolean;
  /** Проигравшие конфликт: сочетание у них объявлено, но им не достаётся. */
  readonly shadowed: readonly { readonly pluginId: string; readonly command: string }[];
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
  readonly keys: readonly KeyRow[];
  readonly feed: readonly FeedLine[];
  readonly journal: readonly PluginJournalLine[];
  /** «Повесить хост» - SIGSTOP, на Windows его нет. */
  readonly canHang: boolean;
}

