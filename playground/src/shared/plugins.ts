import type { FeedLine, Reply } from '@cyborg-harness/contracts';
import type { WindowSnapshot } from '../../../core/src/window-layer.ts';
import type { DocumentRow } from '../../../core/src/documents.ts';

export type { FeedLine, Reply };
// Окно playground: снимок, который главный процесс отдаёт интерфейсу (SAD §3.2, §3.5).

export type PluginState = 'active' | 'waiting' | 'restarting' | 'stopped' | 'disabled';

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
  /** Адрес вида для <iframe>: есть у включённого плагина с `ui` в манифесте; у снятого окно рисует заглушку вместо фрейма. */
  readonly view?: string;
  /** Адрес экрана замка `ui.overlay`: окно показывает его, пока замок плагина стоит. */
  readonly overlay?: string;
  /** Процессы, оставленные человеком при выключении: без строки в окне их не видно до выхода. */
  readonly kept?: readonly KeptPtyRow[];
}

export interface KeptPtyRow {
  readonly id: string;
  readonly pid: number;
  /** Программа с аргументами. */
  readonly command: string;
  /** Когда оставлен, мс от эпохи. */
  readonly keptAt: number;
  /** Код выхода, если процесс завершился сам. */
  readonly exitCode?: number;
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

export interface WorkspaceInfo {
  /** null - окно без воркспейса: плагины не загружены. */
  readonly current: string | null;
  /** «Недавние» без текущего, последний открытый первым. */
  readonly recent: readonly string[];
}

export interface PluginsSnapshot {
  readonly phase: 'starting' | 'ready' | 'failed' | 'no-workspace';
  readonly error?: string;
  /** Что не дошло до ядра: битый cyborg.json, непрочитанный манифест. */
  readonly problems: readonly string[];
  readonly plugins: readonly PluginRow[];
  readonly keys: readonly KeyRow[];
  readonly feed: readonly FeedLine[];
  readonly journal: readonly PluginJournalLine[];
  /** «Повесить хост» - SIGSTOP, на Windows его нет. */
  readonly canHang: boolean;
  /** Диалог на экране и замки окна. */
  readonly window: WindowSnapshot;
  /** Открытые документы плагинов в порядке окна. */
  readonly documents: readonly DocumentRow[];
  readonly workspace: WorkspaceInfo;
}

