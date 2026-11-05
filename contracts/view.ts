import type { ContractName, ContractType, Major } from './index.ts';
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
