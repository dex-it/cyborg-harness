import type { ContractName, ContractType, Major } from './index.ts';
import type { PtyExit, PtyInfo, PtyTicket } from './os.ts';
import type { Disposable } from './plugin.ts';

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
  /** Ответ команды или метода контракта - данные, прошедшие structured clone. */
  readonly value?: unknown;
}

export interface ViewDrop {
  readonly from: string;
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
  onExit(listener: (exit: PtyExit) => void): Disposable;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** Перестать смотреть; процесс живёт дальше - завершает его главная часть. */
  close(): void;
}

export interface DialogChoice {
  readonly id: string;
  readonly label: string;
}

/** Диалог в слое ядра поверх всех фреймов: `ask` - вопрос с кнопками, `menu` - меню у точки `at` в координатах вида. */
export type DialogSpec =
  | { readonly kind: 'ask'; readonly title: string; readonly message?: string; readonly buttons: readonly DialogChoice[] }
  | { readonly kind: 'menu'; readonly items: readonly DialogChoice[]; readonly at: { readonly x: number; readonly y: number } };

/** Урезанный `ctx` для UI плагина (SAD2 §3.8): права - те же, что у главной части, но `ctx.os` нет. */
export interface UiContext {
  readonly pluginId: string;
  /** Имя вида из `ui.views` манифеста. */
  readonly view: string;
  readonly commands: {
    /** Свои команды плагина; чужую ядро отклонит. Отказ - исключение с текстом ядра. */
    run(command: string, ...args: unknown[]): Promise<unknown>;
  };
  readonly contracts: {
    /** Контракт из `requires` или `optional` своего плагина; поставщика нет - undefined, контракта нет в манифесте - исключение. */
    get<K extends ContractName, M extends Major<K>>(contract: K, major: M): Promise<UiRemote<ContractType<K, M>> | undefined>;
  };
  readonly theme: {
    readonly tokens: ThemeTokens;
    onChange(listener: (tokens: ThemeTokens) => void): Disposable;
  };
  /** Скрытая область не отмонтируется: DOM, прокрутка и выделение живут, а `document.visibilityState` фрейма об этом не знает. */
  readonly visible: boolean;
  onVisibilityChange(listener: (visible: boolean) => void): Disposable;
  /** Сообщения своего плагина, накопленные до открытия вида. */
  logs(): Promise<readonly FeedLine[]>;
  onLog(listener: (line: FeedLine) => void): Disposable;
  readonly terminal: {
    /** Билет от `PtyHandle.share()` своей главной части; чужой, просроченный или использованный - исключение. */
    open(ticket: PtyTicket): Promise<UiTerminal>;
  };
  readonly state: {
    /** Память вида в state воркспейса, какой её оставил прошлый документ; не писали - undefined. Схемы и миграций нет: формат - забота плагина. */
    readonly value: unknown;
    /** JSON до 64 КБ; undefined - забыть. У каждого воркспейса своя память, поэтому не localStorage origin плагина. */
    set(value: unknown): Promise<void>;
  };
  readonly dialogs: {
    /** Окно показывает диалоги по одному, под замком чужие ждут; ответ - id выбранного пункта, отмена или выгрузка плагина - undefined. */
    show(spec: DialogSpec): Promise<string | undefined>;
  };
  readonly keys: {
    /** Сочетание своей команды, как оно сейчас привязано (с правками человека, под платформу): `Ctrl+Shift+F`; не привязана - undefined. Нажатие ловит ядро, вид его не видит. */
    of(command: string): string | undefined;
  };
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
  mount(root: Root, ctx: UiContext): Disposable | undefined;
}
