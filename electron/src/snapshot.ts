import type { FeedLine, Reply } from '@cyborg-harness/contracts';
import type { DocumentRow, LayoutEntry, WindowSnapshot } from '@cyborg-harness/core/window';

export type { FeedLine, Reply };
// Окно playground: снимок, который главный процесс отдаёт интерфейсу (SAD §3.2, §3.5).

export type PluginState = 'active' | 'waiting' | 'restarting' | 'stopped' | 'disabled';

export type PluginOrigin = 'bundled' | 'user';

export interface PluginRow {
  readonly id: string;
  readonly version?: string;
  /** Откуда плагин: `bundled` - каталог поставки, `user` - каталог пользователя (сторонний, код не проверен). Нет у id, которого не нашли ни в одном каталоге. */
  readonly origin?: PluginOrigin;
  /** Хост, в котором плагин работает или работал бы; у невключённых нет. */
  readonly host?: string;
  /** Группа рендера плагина с видами: хост адреса его видов, виды группы делят процесс рендера. Нет у плагина без видов и у невключённого. */
  readonly group?: string;
  /** Предупреждение о группе словами записи журнала: `group-isolated` - сторонний плагин просил общую группу, ядро дало ему свою; `group-shared` - владелец посадил его в общую, он видит DOM соседей. */
  readonly groupWarning?: string;
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

/** Строка раскладки ядра (`Kernel.layout`); у вида `url` - адрес для <iframe>: нет у метки `not-enabled` (плагин не включён в настройках); у снятого (`disabled`) и отвергнутого графом (`out-of-graph`) окно рисует заглушку вместо фрейма. */
export type LayoutRow = LayoutEntry & { readonly url?: string | undefined };

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
  /** Запуск с `--safe-mode`: код плагинов не запускается. */
  readonly safeMode: boolean;
  /** Запуск с `--user-plugins`: каталог плагинов пользователя читается, его плагины сторонние. */
  readonly userPlugins: boolean;
  readonly error?: string;
  /** Что не дошло до ядра: битый cyborg.json, непрочитанный манифест. */
  readonly problems: readonly string[];
  readonly plugins: readonly PluginRow[];
  /** Виды и типы документов по `order`: окно рисует области по этому списку и не называет плагины по именам. */
  readonly layout: readonly LayoutRow[];
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

/** Что окно может просить у главного процесса. */
export interface WindowApi {
  pluginsSnapshot(): Promise<PluginsSnapshot>;
  enablePlugin(id: string): Promise<Reply>;
  disablePlugin(id: string, keepPty?: boolean): Promise<Reply>;
  disablePreview(id: string): Promise<Reply>;
  endKeptPty(id: string): Promise<Reply>;
  crashHost(id: string): Promise<Reply>;
  hangHost(id: string): Promise<Reply>;
  runCommand(command: string): Promise<Reply>;
  onPluginsChanged(listener: () => void): void;
  onWindowCommand(listener: (command: string) => void): void;
  setViewVisible(id: string, view: string, visible: boolean): Promise<void>;
  answerDialog(id: number, choice: string | undefined): Promise<Reply>;
  closeDocument(id: string): Promise<Reply>;
  openWorkspace(file?: string): Promise<Reply>;
  setSafeMode(on: boolean): Promise<Reply>;
}
