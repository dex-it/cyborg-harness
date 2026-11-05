/** Строка ленты, которую ядро показывает виду его плагина. */
export interface FeedLine {
  readonly at: number;
  /** `log` - сообщение плагина, `key` - нажатие, перехваченное ядром, `window` - нажатие, дошедшее до страницы, `error` - отказ команды. */
  readonly kind: 'log' | 'key' | 'window' | 'error';
  readonly subject: string;
  readonly text: string;
}

export interface Reply {
  readonly error?: string;
}

export interface ViewDrop {
  readonly from: string;
  readonly path: string;
}

/** Что видит вид плагина в `window.cyborgView`: только своё - главный процесс узнаёт плагин по origin фрейма, а не по словам вида. */
export interface ViewBridge {
  /** Свои команды плагина; чужую главный процесс отклонит. */
  run(command: string): Promise<Reply>;
  /** Сообщения своего плагина, накопленные до открытия вида. */
  logs(): Promise<readonly FeedLine[]>;
  onLog(listener: (line: FeedLine) => void): void;
  /** Перетаскивание файла ведёт ядро: Chromium не пускает перетаскивание из страницы во фрейм другого процесса той же страницы. Путь - от корня рабочей папки; файла вне её ядро не отдаст. */
  startDrag(path: string): void;
  /** Путь, сброшенный в этот вид, и плагин-источник; сброс в другой вид или не из вида - null. */
  drop(): Promise<ViewDrop | null>;
}
