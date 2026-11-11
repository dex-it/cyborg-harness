import type { ContractName, ContractType, Major, MajorOf, Remote, VersionOf } from './index.ts';
import type { PluginOs, PluginSecrets } from './os.ts';
import type { AskDialog } from './view.ts';

/** Снимаемая регистрация (подписка, команда, сочетание, сервер): `dispose()` снимает её. */
export interface Disposable {
  /** Снимает регистрацию; у объектов ядра повторный вызов ничего не делает. */
  dispose(): void;
}

/** Снимает добавленное в обратном порядке при выгрузке плагина. */
export interface DisposableStore extends Disposable {
  /** `true` после снятия набора, то есть после выгрузки плагина. */
  readonly disposed: boolean;
  /** Кладёт в набор снимаемые объекты; набор уже снят - объекты снимаются сразу. */
  add(...items: Disposable[]): void;
}

/** Аргументы уже сверены ядром со схемой из манифеста, но обработчик сужает их сам: тип с провода не выводится. */
export type CommandHandler = (...args: unknown[]) => unknown;

/** Слои от нижнего к верхнему: верхний перекрывает нижний. Для config - user и workspace. */
export type Layer = string;

/** Объявление раздела `config` или `state` в главной части: значения по умолчанию, миграция и проверка. Версия и схема раздела объявлены в манифесте. */
export interface SectionSpec {
  /** Версия формата раздела; совпадает с `config.version` или `state.version` манифеста. */
  readonly version: number;
  /** Значения, действующие, пока ни один слой ничего не задал. */
  readonly defaults?: Readonly<Record<string, unknown>>;
  /** Приводит данные слоя из `fromVersion` к `version`; бросок - отказ миграции. */
  readonly migrate?: (fromVersion: number, data: Record<string, unknown>) => Record<string, unknown>;
  /** Ошибки итогового значения; пустой список - значение годно. */
  readonly validate?: (value: Readonly<Record<string, unknown>>) => readonly string[];
}

/** Итог чтения раздела при активации: `ok`, `newer` (данные новее плагина), `migrate-error` (миграция бросила исключение) или `invalid` (значение не прошло схему или `validate`). */
export type SectionResult =
  | { readonly status: 'ok'; readonly value: Record<string, unknown>; readonly migrated: readonly Layer[] }
  | { readonly status: 'newer'; readonly layer: Layer; readonly found: number; readonly expected: number }
  | { readonly status: 'migrate-error'; readonly layer: Layer; readonly from: number; readonly error: string }
  | { readonly status: 'invalid'; readonly errors: readonly string[] };

/** Раздел `config` или `state` плагина: значения слоёв пользователя и воркспейса, сложенные в одно. */
export interface PluginSection {
  /** Итог чтения и миграции раздела при активации. */
  readonly result: SectionResult;
  /** Итоговое значение раздела: слои сложены, верхний перекрывает нижний. */
  get(): Record<string, unknown>;
  /** Записывает раздел в слой (для `config` - `user` или `workspace`) и возвращает итоговое значение. Поле хоста из `net: "config:<поле>"` меняет только человек (`PermissionDenied`). */
  set(layer: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Слушатель вызывается с новым итоговым значением, когда раздел изменился: правкой файла извне или записью через `set`. */
  onChange(listener: (value: Record<string, unknown>) => void): Disposable;
}

/** Поставщик контракта глазами потребителя: кто отдаёт и какую версию. */
export interface Provider<T> {
  /** Идентификатор плагина-поставщика. */
  readonly pluginId: string;
  /** Версия контракта, которую объявил поставщик. */
  readonly version: string;
  /** Реализация контракта в виде `Remote`: методы возвращают `Promise`. */
  readonly impl: T;
}

/** Код отказа ядра; отказ приходит плагину как `Error` с полем `code`. */
export type CoreErrorCode =
  | 'NotDeclared'
  | 'AlreadyProvided'
  | 'Unavailable'
  | 'NotCloneable'
  | 'Invalid'
  | 'CommandNotFound'
  | 'CommandConflict'
  | 'HostGone'
  | 'Timeout'
  | 'Cancelled'
  | 'Remote'
  | 'PermissionDenied'
  | 'NotFound';

/** Уровень строки `ctx.log`; те же три уровня у записей журнала ядра. */
export type LogLevel = 'info' | 'warn' | 'error';

/** Всё, что плагин видит от ядра; методы чужих контрактов всегда асинхронны - вызов идёт через границу хоста. */
export interface PluginContext {
  /** Идентификатор этого плагина (`id` манифеста). */
  readonly pluginId: string;
  /** Набор снимаемых объектов плагина: всё, что в нём лежит, снимается при выгрузке в обратном порядке. */
  readonly subscriptions: DisposableStore;
  /** Контракты: что плагин отдаёт другим и что берёт у них. Контракт должен быть объявлен в манифесте. */
  readonly contracts: {
    /** Мажорная часть версии выбирает тип impl из карты Contracts. */
    provide<K extends ContractName, V extends VersionOf<K>>(contract: K, version: V, impl: ContractType<K, MajorOf<V> & Major<K>>): Disposable;
    /** Мажорная версия обязательна: ядро сверяет её с диапазоном из манифеста, и тип ответа ей соответствует. */
    get<K extends ContractName, M extends Major<K>>(contract: K, major: M): Remote<ContractType<K, M>> | undefined;
    /** Все поставщики контракта мажорной версии `major` (кратность many) с их плагином и версией; список на момент вызова. */
    all<K extends ContractName, M extends Major<K>>(contract: K, major: M): Provider<Remote<ContractType<K, M>>>[];
    /** Слушатель вызывается, когда у контракта появился или исчез поставщик; потребитель перечитывает `get` или `all`. */
    onChange(contract: ContractName, listener: () => void): Disposable;
  };
  /** Команды плагина. */
  readonly commands: {
    /** Вешает обработчик на команду, объявленную в `commands` манифеста. Аргументы ядро сверяет со схемой манифеста до вызова обработчика. Повтор имени - `CommandConflict`. */
    register(name: string, handler: CommandHandler): Disposable;
    /** Запускает команду по имени и возвращает ответ обработчика. Чужая команда доступна, если её исполнитель открыл её плагинам (`callers: "plugins"`); иначе отказ и запись `denied` в журнале вызывающего. */
    run(name: string, ...args: unknown[]): Promise<unknown>;
  };
  /** Сочетания клавиш во время работы плагина; статические сочетания объявляет манифест (`keybindings`). */
  readonly keys: PluginKeys;
  /** Раздел настроек плагина; есть, если в манифесте объявлен `config`. */
  readonly config?: PluginSection;
  /** Раздел состояния плагина (память воркспейса); есть, если в манифесте объявлен `state`. */
  readonly state?: PluginSection;
  /** Доступ к ОС через шлюз ядра по правам из манифеста. */
  readonly os: PluginOs;
  /** Раскрытие ссылок на секреты (`{ "$secret": "..." }`) из настроек. */
  readonly secrets: PluginSecrets;
  /** Состояние и заголовок окна приложения. */
  readonly window: PluginWindow;
  /** События ОС: сон, пробуждение, блокировка экрана, простой, закрытие приложения. */
  readonly system: PluginSystem;
  /** Документы плагина в окне (вкладки типов из `documents` манифеста). */
  readonly documents: PluginDocuments;
  /** Связь главной части с видами своего плагина: канал сообщений и модальные окна. */
  readonly views: PluginViews;
  /** Диалоги ядра, которые главная часть показывает без собственного вида. */
  readonly dialogs: PluginDialogs;
  /**
   * Строка в журнал плагина с его id и уровнем (по умолчанию `info`); уровень вне `LogLevel` - `Invalid`.
   * Ядро вычёркивает из строки значения из хранилища секретов, обрезает строку длиннее 8 КиБ, строки сверх 100 за секунду в журнал по одной не кладёт
   * (вместо них в конце интервала одна сводная запись) и выключает плагин, чей поток выше предела не стихает 10 с; числа - `ResourceLimits` ядра.
   */
  log(message: string, level?: LogLevel): void;
}

/**
 * Условия срабатывания динамического сочетания: закрытый список, выражений нет. Поле не названо - действует умолчание.
 * Автоповтор, поле ввода и видимость вида ядру сообщает приложение; открытый диалог ядро знает само.
 */
export interface KeyWhen {
  /** Срабатывать на автоповтор удерживаемой клавиши. Умолчание: нет. */
  readonly repeat?: boolean;
  /** Срабатывать, пока на экране диалог вида. Умолчание: нет. */
  readonly dialog?: boolean;
  /** `not-text` - не срабатывать в поле ввода (терминал полем ввода не считается); `any` - везде. Умолчание: `not-text`. */
  readonly input?: 'any' | 'not-text';
  /** Срабатывать, только пока вид плагина виден; у плагина без вида - `Invalid`. Умолчание: нет. */
  readonly visible?: boolean;
}

/** Сочетание, которое плагин регистрирует во время работы; ту же команду манифест привязывает статически (`keybindings`). */
export interface KeyBinding {
  /** Запись как в манифесте: `CmdOrCtrl+Shift+K`, `F5`; без модификатора годится только F1-F24. */
  readonly key: string;
  /** Своя команда из `commands` манифеста. */
  readonly command: string;
  /** Аргументы команды при нажатии: JSON до 4 КиБ, проверяются по объявлению команды сразу. */
  readonly args?: readonly unknown[];
  /** Условия срабатывания; не названо - умолчания `KeyWhen`. */
  readonly when?: KeyWhen;
}

/** `dispose()` снимает регистрацию; выгрузка плагина и откат активации - тоже. */
export interface KeyRegistration extends Disposable {
  /** Нет - сочетание держит `winner`, нажатие получит он, а конфликт записан в журнал (`key-conflict`). */
  readonly active: boolean;
  /** Кто держит сочетание, если регистрация проиграла (`active: false`); тот же победитель назван в журнале записью `key-conflict`. */
  readonly winner?: string;
}

/** Динамические сочетания клавиш плагина. */
export interface PluginKeys {
  /**
   * Динамическое сочетание. Старшинство: `plugins.keybindings` человека (он может забрать и сочетание окна или меню, или освободить его через `null`), затем окно и меню приложения, манифесты и динамические по порядку регистрации.
   * Сочетание окна и меню занять нельзя - `CommandConflict`; проигрыш манифестному или другому динамическому - `active: false`.
   * Проигравший победителя не заменяет, если тот ушёл: регистрацию повторяет плагин. Не больше 128 регистраций на плагин.
   */
  register(binding: KeyBinding): Promise<KeyRegistration>;
}

/** Документ плагина в окне; тип - из `documents` манифеста. */
export interface DocumentInfo {
  /** Идентификатор документа, выданный ядром при `open`. */
  readonly id: string;
  /** Тип документа из `documents` манифеста. */
  readonly type: string;
  /** Заголовок вкладки. */
  readonly title: string;
  /** JSON до 64 КБ: с ним владелец поднимет документ после перезапуска. */
  readonly data?: unknown;
}

/** Что нужно, чтобы открыть документ. */
export interface DocumentInit {
  /** Заголовок вкладки. */
  readonly title: string;
  /** Данные документа: JSON до 64 КБ; сохраняются для типов с `restorable`. */
  readonly data?: unknown;
}

/** `data: undefined` - забыть данные; поле не названо - не трогать. */
export interface DocumentChange {
  /** Новый заголовок вкладки. */
  readonly title?: string;
  /** Новые данные документа. */
  readonly data?: unknown;
}

/** Документы, которые ядро держит в порядке окна; тип с `restorable` переживает перезапуск, остальные - нет. */
export interface PluginDocuments {
  /** Свои документы: открытые в этой работе и, после перезапуска, сохранённые прошлой - их плагин поднимает при активации. */
  list(): Promise<DocumentInfo[]>;
  /** Открывает документ объявленного типа и возвращает его `id`. Тип должен быть в `documents` манифеста. */
  open(type: string, init: DocumentInit): Promise<string>;
  /** Данные пишет владелец по ходу работы: после падения хоста опросить его некому. */
  save(id: string, change: DocumentChange): Promise<void>;
  /** Закрывает свой документ. */
  close(id: string): Promise<void>;
  /**
   * Просит окно сделать вкладку документа активной: выбрать её и показать. Окно не поднимается из свёрнутого и фона - это делает клик по уведомлению
   * или другое действие плагина. Только свой документ: чужой и закрытый - `NotFound`; под замком окна другого плагина - `Unavailable`. Права не нужно.
   * Просьба не схлопывается: повторный `reveal` возвращает человека на вкладку, с которой он ушёл. Приложение без вкладок молча ничего не делает.
   */
  reveal(id: string): Promise<void>;
  /** Документ закрыл человек из окна. */
  onClose(listener: (id: string) => void): Disposable;
}

/**
 * Канал между главной частью плагина и его видом по имени вида (`ui.views` манифеста). Сообщение - данные, переживающие `structuredClone`,
 * не больше 64 КиБ (`limits.viewMessage`): больше - `Invalid`, канал работает дальше, не данные - `NotCloneable`.
 * Канал не хранит сообщения: вид, которого ещё нет или который перезагружается, посланное ему не получит; нужное состояние вид спрашивает командой при открытии.
 * Сообщение главной части получают все открытые виды плагина с этим именем и никакие другие. После выгрузки плагина `post` отказывает `Unavailable`, слушатели сняты.
 */
export interface ViewChannel {
  /** Отправляет сообщение другой стороне канала (из главной части - видам, из вида - главной части). Данные должны переживать `structuredClone`. */
  post(message: unknown): Promise<void>;
  /** Слушатель, бросивший исключение, пишет в журнал плагина и не мешает соседям. */
  onMessage(listener: (message: unknown) => void): Disposable;
}

/** Размер модального окна в CSS-пикселях: от 100 до 4096 по стороне, целое; сторона без значения остаётся за умолчанием окна. Окно не выходит за 90% ширины и 80% высоты экрана. */
export interface ModalSize {
  /** Ширина окна в CSS-пикселях. */
  readonly width?: number;
  /** Высота окна в CSS-пикселях. */
  readonly height?: number;
}

/** Просьба вида подогнать окно под содержимое (`ctx.modal.resize`): высота области вида в CSS-пикселях, целое от 100 до 4096. Ширина остаётся за автором окна. */
export interface ModalResize {
  /** Высота области вида в CSS-пикселях. */
  readonly height: number;
}

/** Что главная часть передаёт модальному окну и как его назвать. */
export interface ModalInit {
  /** Название окна для читающих с экрана и для строки окна; до 200 символов. Умолчание: `title` вида в манифесте, затем id плагина. */
  readonly title?: string;
  /** Данные для вида (`ctx.modal.data`): те же правила и предел, что у сообщения канала. */
  readonly data?: unknown;
  /** Размер окна. Умолчание задаёт приложение (в стенде 520 x 360); высоту «по содержимому» просит сам вид (`ctx.modal.resize`) - она заменяет `size.height`. */
  readonly size?: ModalSize;
  /**
   * Кому принадлежит Escape. `"close"` (умолчание): ядро закрывает окно, вид нажатия не видит. `"view"`: ядро Escape не берёт, нажатие получает вид
   * (поповер, отмена ввода) и сам закрывает окно через `ctx.modal.close`; человеку остаётся кнопка закрытия окна, она отдаёт владельцу `undefined`.
   */
  readonly escape?: 'close' | 'view';
}

/** Связь главной части с видами своего плагина. */
export interface PluginViews {
  /** Вид должен быть в `ui.views` манифеста; чужого плагина и вида, которого нет, у плагина нет: `Invalid` при первом `post`. */
  channel(view: string): ViewChannel;
  /**
   * Модальное окно плагина: вид с `area: "modal"` в манифесте. Ядро показывает его слоем окна поверх всех фреймов, остальные виды под ним недоступны,
   * фокус заперт в окне, Escape закрывает (если `init.escape` не оставил его виду); размер задаёт `init.size`. Окна идут по одному в порядке просьб (у плагина в очереди не больше 8), под замком окна чужое ждёт.
   * Ответ - то, что вид передал в `ctx.modal.close(result)`; Escape, закрытие окна человеком и выгрузка плагина дают `undefined`.
   * Вид, не объявленный модальным, - `Invalid`.
   */
  modal(view: string, init?: ModalInit): Promise<unknown>;
}

/** Диалоги ядра для главной части: у безголового плагина (например, `git`) нет вида, из которого можно спросить. */
export interface PluginDialogs {
  /**
   * Вопрос с кнопками в слое ядра поверх всех фреймов, в той же очереди окна, что диалоги видов; ответ - `id` кнопки, Escape и выгрузка плагина - `undefined`.
   * Меню (`menu`) у главной части нет: оно привязано к точке в координатах вида, поэтому только `ask`.
   */
  show(spec: AskDialog): Promise<string | undefined>;
}

/** Окно приложения: фокус и заголовок. */
export interface PluginWindow {
  /** Только перемены; текущее состояние - `focused()`. Чтобы не пропустить перемену между вопросом и подпиской, сначала подпишитесь, потом спросите. */
  onFocusChange(listener: (focused: boolean) => void): Disposable;
  /**
   * Окно в фокусе сейчас. После первого события окна от приложения - последнее из них; до него - ответ приложения (`LoadOptions.windowFocused`),
   * без источника - `true` («активно»). Плагин, поднятый при окне без фокуса, узнаёт это здесь, а не ждёт перемены. Права не нужно.
   */
  focused(): Promise<boolean>;
  /** Свой фрагмент заголовка окна: ядро собирает «воркспейс - фрагменты по id плагина - приложение». `undefined` снимает фрагмент, выгрузка плагина - тоже. Управляющие символы ядро убирает, длиннее 80 символов - `Invalid`. Права не нужно. */
  setTitle(segment: string | undefined): Promise<void>;
}

/** События ОС; слушатель, бросивший исключение, пишет в журнал плагина и не мешает соседям. */
export interface PluginSystem {
  /** ОС уходит в сон. */
  onSuspend(listener: () => void): Disposable;
  /** ОС вернулась из сна. */
  onResume(listener: () => void): Disposable;
  /** Экран заблокирован. */
  onScreenLock(listener: () => void): Disposable;
  /** Один раз на каждый простой пользователя от `seconds` секунд; после активности срабатывает снова. */
  onIdle(seconds: number, listener: () => void): Disposable;
  /** Ядро ждёт слушателей не дольше бюджета приложения, потом хост завершается. */
  onBeforeQuit(listener: () => void | Promise<void>): Disposable;
}

/** Модуль главной части плагина: его `default` грузит хост. */
export interface PluginModule {
  /** Значения по умолчанию, миграция и проверка раздела `config`; версия и схема - в манифесте. */
  readonly config?: Omit<SectionSpec, 'version'>;
  /** То же для раздела `state`. */
  readonly state?: Omit<SectionSpec, 'version'>;
  /** Точка входа плагина; ядро вызывает её один раз после проверок и миграций, с ограничением по времени (по умолчанию 10 с). Возвращаемый `Disposable` снимается при выгрузке вместе с `ctx.subscriptions`. Исключение отказывает только этому плагину. */
  activate(ctx: PluginContext): Disposable | undefined | Promise<Disposable | undefined>;
}
