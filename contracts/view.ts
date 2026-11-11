import type { ContractName, ContractType, Major } from './index.ts';
import type { PtyExit, PtyInfo, PtyTicket } from './os.ts';
import type { Disposable, ModalResize, ViewChannel } from './plugin.ts';

/** Строка ленты, которую ядро показывает виду его плагина. */
export interface FeedLine {
  /** Время строки, мс от начала эпохи. */
  readonly at: number;
  /** `log` - сообщение плагина, `key` - нажатие, перехваченное ядром, `window` - нажатие, дошедшее до страницы, `error` - отказ команды. */
  readonly kind: 'log' | 'key' | 'window' | 'error';
  /** О чём строка: имя команды, сочетание или источник. */
  readonly subject: string;
  /** Текст строки. */
  readonly text: string;
}

/** Ответ ядра на вызов из вида: либо `error`, либо `value`. */
export interface Reply {
  /** Текст отказа. */
  readonly error?: string;
  /** Ответ команды или метода контракта - данные, прошедшие structured clone. */
  readonly value?: unknown;
}

/** Путь, сброшенный в вид перетаскиванием. */
export interface ViewDrop {
  /** Плагин-источник перетаскивания. */
  readonly from: string;
  /** Сброшенный путь от корня рабочей папки. */
  readonly path: string;
}

/** CSS-переменные темы: ядро ставит их на `:root` документа вида до `mount` и обновляет при смене темы. */
export type ThemeTokens = Readonly<Record<`--cy-${string}`, string>>;

/** Контракт глазами вида: через границу фрейма идут только методы с данными; подписки и колбэки - у главной части плагина. */
export type UiRemote<T> = {
  readonly [P in keyof T as NonNullable<T[P]> extends (...args: never[]) => unknown ? P : never]: NonNullable<T[P]> extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** pty, который показала виду его главная часть: вывод и ввод идут через ядро мимо хоста, так что зависший хост терминал не останавливает. */
export interface UiTerminal extends PtyInfo {
  /** Хвост вывода на момент открытия; может начинаться посреди escape-последовательности. */
  readonly backlog: string;
  /** Вывод до первой подписки копится и отдаётся ей. */
  onData(listener: (chunk: string) => void): Disposable;
  /** Процесс завершился: слушатель получает код выхода. */
  onExit(listener: (exit: PtyExit) => void): Disposable;
  /** Ввод в терминал. */
  write(data: string): Promise<void>;
  /** Размер терминала в столбцах и строках. */
  resize(cols: number, rows: number): Promise<void>;
  /** Перестать смотреть; процесс живёт дальше - завершает его главная часть. */
  close(): void;
}

/** Пункт диалога: кнопка вопроса или строка меню. */
export interface DialogChoice {
  /** Идентификатор, который вернёт диалог при выборе. */
  readonly id: string;
  /** Подпись. */
  readonly label: string;
}

/** Вопрос с кнопками: то, что видам и главной части одинаково доступно (`ctx.dialogs.show`). */
export interface AskDialog {
  /** Вид диалога: вопрос с кнопками. */
  readonly kind: 'ask';
  /** Заголовок вопроса. */
  readonly title: string;
  /** Пояснение под заголовком. */
  readonly message?: string;
  /** Кнопки по порядку. */
  readonly buttons: readonly DialogChoice[];
}

/** Диалог в слое ядра поверх всех фреймов: `ask` - вопрос с кнопками, `menu` - меню у точки `at` в координатах вида. */
export type DialogSpec =
  | AskDialog
  | { readonly kind: 'menu'; readonly items: readonly DialogChoice[]; readonly at: { readonly x: number; readonly y: number } };

/** Модальное окно глазами его вида: данные от владельца и способ вернуть ему результат. */
export interface ViewModal {
  /** Данные, с которыми главная часть открыла окно (`ctx.views.modal(view, { data })`); не передала - `undefined`. */
  readonly data: unknown;
  /**
   * Просит окно подогнать высоту под содержимое вида: вид живёт в чужом по origin фрейме, и окно не знает высоту его содержимого, пока вид не скажет.
   * `height` - высота области вида в CSS-пикселях (без шапки окна), целое от 100 до 4096; окно не выше 80% высоты экрана, сверх этого область прокручивается.
   * Вид шлёт просьбу сам, когда содержимое изменилось; та же высота окно не тревожит. Размер автора (`ModalInit.size`) по ширине остаётся; высота области вида его высоту заменяет.
   * Неверная высота, окно, уже закрытое человеком или выгрузкой плагина, - исключение.
   */
  resize(size: ModalResize): Promise<void>;
  /** Закрывает окно и отдаёт результат владельцу: данные до 64 КиБ. Окно, уже закрытое человеком или выгрузкой плагина, - исключение. */
  close(result?: unknown): Promise<void>;
}

/** Урезанный `ctx` для UI плагина (SAD §3.8): права - те же, что у главной части, но `ctx.os` нет. */
export interface UiContext {
  /** Идентификатор плагина, которому принадлежит вид. */
  readonly pluginId: string;
  /** Имя вида из `ui.views` манифеста. */
  readonly view: string;
  /** Команды своего плагина. */
  readonly commands: {
    /** Свои команды плагина; чужую ядро отклонит. Отказ - исключение с текстом ядра. */
    run(command: string, ...args: unknown[]): Promise<unknown>;
  };
  /** Контракты, которые вид берёт через границу фрейма. */
  readonly contracts: {
    /** Контракт из `requires` или `optional` своего плагина; поставщика нет - undefined, контракта нет в манифесте - исключение. */
    get<K extends ContractName, M extends Major<K>>(contract: K, major: M): Promise<UiRemote<ContractType<K, M>> | undefined>;
  };
  /** Тема окна. */
  readonly theme: {
    /** Текущие CSS-переменные темы. */
    readonly tokens: ThemeTokens;
    /** Тема сменилась: слушатель получает новые переменные. */
    onChange(listener: (tokens: ThemeTokens) => void): Disposable;
  };
  /** Скрытая область не отмонтируется: DOM, прокрутка и выделение живут, а `document.visibilityState` фрейма об этом не знает. */
  readonly visible: boolean;
  /** Вид показали или скрыли. */
  onVisibilityChange(listener: (visible: boolean) => void): Disposable;
  /** Сообщения своего плагина, накопленные до открытия вида. */
  logs(): Promise<readonly FeedLine[]>;
  /** Новая строка ленты журнала своего плагина. */
  onLog(listener: (line: FeedLine) => void): Disposable;
  /** Терминалы, которые главная часть показала виду. */
  readonly terminal: {
    /** Билет от `PtyHandle.share()` своей главной части; чужой, просроченный или использованный - исключение. */
    open(ticket: PtyTicket): Promise<UiTerminal>;
  };
  /** Память вида в состоянии воркспейса. */
  readonly state: {
    /** Память вида в state воркспейса, какой её оставил прошлый документ; не писали - undefined. Схемы и миграций нет: формат - забота плагина. */
    readonly value: unknown;
    /** JSON до 64 КБ; undefined - забыть. У каждого воркспейса своя память, поэтому не localStorage origin плагина. */
    set(value: unknown): Promise<void>;
  };
  /** Диалоги ядра поверх всех фреймов. */
  readonly dialogs: {
    /** Окно показывает диалоги по одному, под замком чужие ждут; ответ - id выбранного пункта, отмена или выгрузка плагина - undefined. */
    show(spec: DialogSpec): Promise<string | undefined>;
  };
  /** Есть, только пока вид показан как модальное окно (`area: "modal"`, `ctx.views.modal` главной части); у остальных видов - `undefined`. */
  readonly modal: ViewModal | undefined;
  /** Канал с главной частью плагина по имени этого вида: сообщения, которые она шлёт виду, и ответы ей. Правила и лимит - у `ViewChannel`. */
  readonly channel: ViewChannel;
  /** Сочетания клавиш своих команд. */
  readonly keys: {
    /** Сочетание своей команды, как оно сейчас привязано (с правками человека, под платформу): `Ctrl+Shift+F`; не привязана - undefined. Нажатие ловит ядро, вид его не видит. */
    of(command: string): string | undefined;
  };
  /** Перетаскивание файлов между видами и приложением. */
  readonly drag: {
    /** Перетаскивание файла ведёт ядро: Chromium не пускает перетаскивание из страницы во фрейм другого процесса. Путь - от корня рабочей папки. */
    start(path: string): void;
    /** Путь, сброшенный в этот вид, и плагин-источник; сброс не из вида - null. */
    drop(): Promise<ViewDrop | null>;
  };
}

/**
 * Модуль из `ui.views`. `Root` - `HTMLElement`: контракты не тянут DOM в типы главной части.
 * `mount` зовётся один раз на документ вида, `dispose` - когда ядро снимает вид.
 */
export interface UiModule<Root> {
  /** Монтирует вид в `root`. Зовётся один раз на документ вида; возвращаемый `Disposable` снимается, когда ядро снимает вид. */
  mount(root: Root, ctx: UiContext): Disposable | undefined;
}
