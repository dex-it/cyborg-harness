---
title: "Справочник ctx и UiContext"
description: "Все члены ctx главной части, ctx вида и ctx.os: подписи и описания, собранные из TSDoc пакета контрактов."
---

:::note[Страница сгенерирована]
Версия API: 1.0.0-rc.3. Дата: 2026-11-12 (запись версии в `contracts/CHANGELOG.md`). Источник - TSDoc файлов `contracts/plugin.ts`, `contracts/view.ts`, `contracts/os.ts`; правьте описания там, а страницу пересоберите командой `npm run docs:api`. CI падает, если страница устарела. Правила стабильности членов - раздел «Что стабильно, а что нет» в [README пакета контрактов](https://github.com/dex-it/cyborg-harness/blob/master/contracts/README.md).
:::

Справочник отвечает на вопрос «что делает этот член и что он принимает». Как ими пользоваться, написано в [главной части](/authors/main-api/), [виде](/authors/view-api/) и [рецептах](/authors/recipes/); права `ctx.os` - в [справочнике прав](/reference/permissions/).

## Главная часть: PluginModule и ctx

Файл `contracts/plugin.ts`.

### PluginModule

Модуль главной части плагина: его `default` грузит хост.

- `config?: Omit<SectionSpec, 'version'>` - Значения по умолчанию, миграция и проверка раздела `config`; версия и схема - в манифесте.
- `state?: Omit<SectionSpec, 'version'>` - То же для раздела `state`.
- `activate(ctx: PluginContext): Disposable | undefined | Promise<Disposable | undefined>` - Точка входа плагина; ядро вызывает её один раз после проверок и миграций, с ограничением по времени (по умолчанию 10 с). Возвращаемый `Disposable` снимается при выгрузке вместе с `ctx.subscriptions`. Исключение отказывает только этому плагину.

### PluginContext

Всё, что плагин видит от ядра; методы чужих контрактов всегда асинхронны - вызов идёт через границу хоста.

- `ctx.pluginId: string` - Идентификатор этого плагина (`id` манифеста).
- `ctx.subscriptions: DisposableStore` - Набор снимаемых объектов плагина: всё, что в нём лежит, снимается при выгрузке в обратном порядке. Тип: [DisposableStore](#disposablestore).
- `ctx.contracts: {...}` - Контракты: что плагин отдаёт другим и что берёт у них. Контракт должен быть объявлен в манифесте.
- `ctx.contracts.provide<K extends ContractName, V extends VersionOf<K>>(contract: K, version: V, impl: ContractType<K, MajorOf<V> & Major<K>>): Disposable` - Мажорная часть версии выбирает тип impl из карты Contracts.
- `ctx.contracts.get<K extends ContractName, M extends Major<K>>(contract: K, major: M): Remote<ContractType<K, M>> | undefined` - Мажорная версия обязательна: ядро сверяет её с диапазоном из манифеста, и тип ответа ей соответствует.
- `ctx.contracts.all<K extends ContractName, M extends Major<K>>(contract: K, major: M): Provider<Remote<ContractType<K, M>>>[]` - Все поставщики контракта мажорной версии `major` (кратность many) с их плагином и версией; список на момент вызова.
- `ctx.contracts.onChange(contract: ContractName, listener: () => void): Disposable` - Слушатель вызывается, когда у контракта появился или исчез поставщик; потребитель перечитывает `get` или `all`.
- `ctx.commands: {...}` - Команды плагина.
- `ctx.commands.register(name: string, handler: CommandHandler): Disposable` - Вешает обработчик на команду, объявленную в `commands` манифеста. Аргументы ядро сверяет со схемой манифеста до вызова обработчика. Повтор имени - `CommandConflict`.
- `ctx.commands.run(name: string, ...args: unknown[]): Promise<unknown>` - Запускает команду по имени и возвращает ответ обработчика. Чужая команда доступна, если её исполнитель открыл её плагинам (`callers: "plugins"`); иначе отказ и запись `denied` в журнале вызывающего.
- `ctx.keys: PluginKeys` - Сочетания клавиш во время работы плагина; статические сочетания объявляет манифест (`keybindings`). Тип: [PluginKeys](#pluginkeys).
- `ctx.config?: PluginSection` - Раздел настроек плагина; есть, если в манифесте объявлен `config`. Тип: [PluginSection](#pluginsection).
- `ctx.state?: PluginSection` - Раздел состояния плагина (память воркспейса); есть, если в манифесте объявлен `state`. Тип: [PluginSection](#pluginsection).
- `ctx.os: PluginOs` - Доступ к ОС через шлюз ядра по правам из манифеста. Тип: [PluginOs](#pluginos).
- `ctx.secrets: PluginSecrets` - Раскрытие ссылок на секреты (`{ "$secret": "..." }`) из настроек. Тип: [PluginSecrets](#pluginsecrets).
- `ctx.window: PluginWindow` - Состояние и заголовок окна приложения. Тип: [PluginWindow](#pluginwindow).
- `ctx.system: PluginSystem` - События ОС: сон, пробуждение, блокировка экрана, простой, закрытие приложения. Тип: [PluginSystem](#pluginsystem).
- `ctx.documents: PluginDocuments` - Документы плагина в окне (вкладки типов из `documents` манифеста). Тип: [PluginDocuments](#plugindocuments).
- `ctx.views: PluginViews` - Связь главной части с видами своего плагина: канал сообщений и модальные окна. Тип: [PluginViews](#pluginviews).
- `ctx.dialogs: PluginDialogs` - Диалоги ядра, которые главная часть показывает без собственного вида. Тип: [PluginDialogs](#plugindialogs).
- `ctx.log(message: string, level?: LogLevel): void` - Строка в журнал плагина с его id и уровнем (по умолчанию `info`); уровень вне `LogLevel` - `Invalid`. Ядро вычёркивает из строки значения из хранилища секретов, обрезает строку длиннее 8 КиБ, строки сверх 100 за секунду в журнал по одной не кладёт (вместо них в конце интервала одна сводная запись) и выключает плагин, чей поток выше предела не стихает 10 с; числа - `ResourceLimits` ядра.

### Disposable

Снимаемая регистрация (подписка, команда, сочетание, сервер): `dispose()` снимает её.

- `dispose(): void` - Снимает регистрацию; у объектов ядра повторный вызов ничего не делает.

### DisposableStore

Снимает добавленное в обратном порядке при выгрузке плагина.

`extends Disposable`

- `disposed: boolean` - `true` после снятия набора, то есть после выгрузки плагина.
- `add(...items: Disposable[]): void` - Кладёт в набор снимаемые объекты; набор уже снят - объекты снимаются сразу.

### CommandHandler

Аргументы уже сверены ядром со схемой из манифеста, но обработчик сужает их сам: тип с провода не выводится.

```ts
type CommandHandler = (...args: unknown[]) => unknown;
```

### Layer

Слои от нижнего к верхнему: верхний перекрывает нижний. Для config - user и workspace.

```ts
type Layer = string;
```

### SectionSpec

Объявление раздела `config` или `state` в главной части: значения по умолчанию, миграция и проверка. Версия и схема раздела объявлены в манифесте.

- `version: number` - Версия формата раздела; совпадает с `config.version` или `state.version` манифеста.
- `defaults?: Readonly<Record<string, unknown>>` - Значения, действующие, пока ни один слой ничего не задал.
- `migrate?: (fromVersion: number, data: Record<string, unknown>) => Record<string, unknown>` - Приводит данные слоя из `fromVersion` к `version`; бросок - отказ миграции.
- `validate?: (value: Readonly<Record<string, unknown>>) => readonly string[]` - Ошибки итогового значения; пустой список - значение годно.

### SectionResult

Итог чтения раздела при активации: `ok`, `newer` (данные новее плагина), `migrate-error` (миграция бросила исключение) или `invalid` (значение не прошло схему или `validate`).

```ts
type SectionResult = | { readonly status: 'ok'; readonly value: Record<string, unknown>; readonly migrated: readonly Layer[] } | { readonly status: 'newer'; readonly layer: Layer; readonly found: number; readonly expected: number } | { readonly status: 'migrate-error'; readonly layer: Layer; readonly from: number; readonly error: string } | { readonly status: 'invalid'; readonly errors: readonly string[] };
```

### PluginSection

Раздел `config` или `state` плагина: значения слоёв пользователя и воркспейса, сложенные в одно.

- `result: SectionResult` - Итог чтения и миграции раздела при активации. Тип: [SectionResult](#sectionresult).
- `get(): Record<string, unknown>` - Итоговое значение раздела: слои сложены, верхний перекрывает нижний.
- `set(layer: string, data: Record<string, unknown>): Promise<Record<string, unknown>>` - Записывает раздел в слой (для `config` - `user` или `workspace`) и возвращает итоговое значение. Поле хоста из `net: "config:<поле>"` меняет только человек (`PermissionDenied`).
- `onChange(listener: (value: Record<string, unknown>) => void): Disposable` - Слушатель вызывается с новым итоговым значением, когда раздел изменился: правкой файла извне или записью через `set`.

### Provider

Поставщик контракта глазами потребителя: кто отдаёт и какую версию.

- `pluginId: string` - Идентификатор плагина-поставщика.
- `version: string` - Версия контракта, которую объявил поставщик.
- `impl: T` - Реализация контракта в виде `Remote`: методы возвращают `Promise`.

### CoreErrorCode

Код отказа ядра; отказ приходит плагину как `Error` с полем `code`.

```ts
type CoreErrorCode = | 'NotDeclared' | 'AlreadyProvided' | 'Unavailable' | 'NotCloneable' | 'Invalid' | 'CommandNotFound' | 'CommandConflict' | 'HostGone' | 'Timeout' | 'Cancelled' | 'Remote' | 'PermissionDenied' | 'NotFound';
```

### LogLevel

Уровень строки `ctx.log`; те же три уровня у записей журнала ядра.

```ts
type LogLevel = 'info' | 'warn' | 'error';
```

### KeyWhen

Условия срабатывания динамического сочетания: закрытый список, выражений нет. Поле не названо - действует умолчание. Автоповтор, поле ввода и видимость вида ядру сообщает приложение; открытый диалог ядро знает само.

- `repeat?: boolean` - Срабатывать на автоповтор удерживаемой клавиши. Умолчание: нет.
- `dialog?: boolean` - Срабатывать, пока на экране диалог вида. Умолчание: нет.
- `input?: 'any' | 'not-text'` - `not-text` - не срабатывать в поле ввода (терминал полем ввода не считается); `any` - везде. Умолчание: `not-text`.
- `visible?: boolean` - Срабатывать, только пока вид плагина виден; у плагина без вида - `Invalid`. Умолчание: нет.

### KeyBinding

Сочетание, которое плагин регистрирует во время работы; ту же команду манифест привязывает статически (`keybindings`).

- `key: string` - Запись как в манифесте: `CmdOrCtrl+Shift+K`, `F5`; без модификатора годится только F1-F24.
- `command: string` - Своя команда из `commands` манифеста.
- `args?: readonly unknown[]` - Аргументы команды при нажатии: JSON до 4 КиБ, проверяются по объявлению команды сразу.
- `when?: KeyWhen` - Условия срабатывания; не названо - умолчания `KeyWhen`. Тип: [KeyWhen](#keywhen).

### KeyRegistration

`dispose()` снимает регистрацию; выгрузка плагина и откат активации - тоже.

`extends Disposable`

- `active: boolean` - Нет - сочетание держит `winner`, нажатие получит он, а конфликт записан в журнал (`key-conflict`).
- `winner?: string` - Кто держит сочетание, если регистрация проиграла (`active: false`); тот же победитель назван в журнале записью `key-conflict`.

### PluginKeys

Динамические сочетания клавиш плагина.

- `register(binding: KeyBinding): Promise<KeyRegistration>` - Динамическое сочетание. Старшинство: `plugins.keybindings` человека (он может забрать и сочетание окна или меню, или освободить его через `null`), затем окно и меню приложения, манифесты и динамические по порядку регистрации. Сочетание окна и меню занять нельзя - `CommandConflict`; проигрыш манифестному или другому динамическому - `active: false`. Проигравший победителя не заменяет, если тот ушёл: регистрацию повторяет плагин. Не больше 128 регистраций на плагин.

### DocumentInfo

Документ плагина в окне; тип - из `documents` манифеста.

- `id: string` - Идентификатор документа, выданный ядром при `open`.
- `type: string` - Тип документа из `documents` манифеста.
- `title: string` - Заголовок вкладки.
- `data?: unknown` - JSON до 64 КБ: с ним владелец поднимет документ после перезапуска.

### DocumentInit

Что нужно, чтобы открыть документ.

- `title: string` - Заголовок вкладки.
- `data?: unknown` - Данные документа: JSON до 64 КБ; сохраняются для типов с `restorable`.

### DocumentChange

`data: undefined` - забыть данные; поле не названо - не трогать.

- `title?: string` - Новый заголовок вкладки.
- `data?: unknown` - Новые данные документа.

### PluginDocuments

Документы, которые ядро держит в порядке окна; тип с `restorable` переживает перезапуск, остальные - нет.

- `list(): Promise<DocumentInfo[]>` - Свои документы: открытые в этой работе и, после перезапуска, сохранённые прошлой - их плагин поднимает при активации.
- `open(type: string, init: DocumentInit): Promise<string>` - Открывает документ объявленного типа и возвращает его `id`. Тип должен быть в `documents` манифеста.
- `save(id: string, change: DocumentChange): Promise<void>` - Данные пишет владелец по ходу работы: после падения хоста опросить его некому.
- `close(id: string): Promise<void>` - Закрывает свой документ.
- `reveal(id: string): Promise<void>` - Просит окно сделать вкладку документа активной: выбрать её и показать. Окно не поднимается из свёрнутого и фона - это делает клик по уведомлению или другое действие плагина. Только свой документ: чужой и закрытый - `NotFound`; под замком окна другого плагина - `Unavailable`. Права не нужно. Просьба не схлопывается: повторный `reveal` возвращает человека на вкладку, с которой он ушёл. Приложение без вкладок молча ничего не делает.
- `onClose(listener: (id: string) => void): Disposable` - Документ закрыл человек из окна.

### ViewChannel

Канал между главной частью плагина и его видом по имени вида (`ui.views` манифеста). Сообщение - данные, переживающие `structuredClone`, не больше 64 КиБ (`limits.viewMessage`): больше - `Invalid`, канал работает дальше, не данные - `NotCloneable`. Канал не хранит сообщения: вид, которого ещё нет или который перезагружается, посланное ему не получит; нужное состояние вид спрашивает командой при открытии. Сообщение главной части получают все открытые виды плагина с этим именем и никакие другие. После выгрузки плагина `post` отказывает `Unavailable`, слушатели сняты.

- `post(message: unknown): Promise<void>` - Отправляет сообщение другой стороне канала (из главной части - видам, из вида - главной части). Данные должны переживать `structuredClone`.
- `onMessage(listener: (message: unknown) => void): Disposable` - Слушатель, бросивший исключение, пишет в журнал плагина и не мешает соседям.

### ModalSize

Размер модального окна в CSS-пикселях: от 100 до 4096 по стороне, целое; сторона без значения остаётся за умолчанием окна. Окно не выходит за 90% ширины и 80% высоты экрана.

- `width?: number` - Ширина окна в CSS-пикселях.
- `height?: number` - Высота окна в CSS-пикселях.

### ModalResize

Просьба вида подогнать окно под содержимое (`ctx.modal.resize`): высота области вида в CSS-пикселях, целое от 100 до 4096. Ширина остаётся за автором окна.

- `height: number` - Высота области вида в CSS-пикселях.

### ModalInit

Что главная часть передаёт модальному окну и как его назвать.

- `title?: string` - Название окна для читающих с экрана и для строки окна; до 200 символов. Умолчание: `title` вида в манифесте, затем id плагина.
- `data?: unknown` - Данные для вида (`ctx.modal.data`): те же правила и предел, что у сообщения канала.
- `size?: ModalSize` - Размер окна. Умолчание задаёт приложение (в стенде 520 x 360); высоту «по содержимому» просит сам вид (`ctx.modal.resize`) - она заменяет `size.height`. Тип: [ModalSize](#modalsize).
- `escape?: 'close' | 'view'` - Кому принадлежит Escape. `"close"` (умолчание): ядро закрывает окно, вид нажатия не видит. `"view"`: ядро Escape не берёт, нажатие получает вид (поповер, отмена ввода) и сам закрывает окно через `ctx.modal.close`; человеку остаётся кнопка закрытия окна, она отдаёт владельцу `undefined`.

### PluginViews

Связь главной части с видами своего плагина.

- `channel(view: string): ViewChannel` - Вид должен быть в `ui.views` манифеста; чужого плагина и вида, которого нет, у плагина нет: `Invalid` при первом `post`.
- `modal(view: string, init?: ModalInit): Promise<unknown>` - Модальное окно плагина: вид с `area: "modal"` в манифесте. Ядро показывает его слоем окна поверх всех фреймов, остальные виды под ним недоступны, фокус заперт в окне, Escape закрывает (если `init.escape` не оставил его виду); размер задаёт `init.size`. Окна идут по одному в порядке просьб (у плагина в очереди не больше 8), под замком окна чужое ждёт. Ответ - то, что вид передал в `ctx.modal.close(result)`; Escape, закрытие окна человеком и выгрузка плагина дают `undefined`. Вид, не объявленный модальным, - `Invalid`.

### PluginDialogs

Диалоги ядра для главной части: у безголового плагина (например, `git`) нет вида, из которого можно спросить.

- `show(spec: AskDialog): Promise<string | undefined>` - Вопрос с кнопками в слое ядра поверх всех фреймов, в той же очереди окна, что диалоги видов; ответ - `id` кнопки, Escape и выгрузка плагина - `undefined`. Меню (`menu`) у главной части нет: оно привязано к точке в координатах вида, поэтому только `ask`.

### PluginWindow

Окно приложения: фокус и заголовок.

- `onFocusChange(listener: (focused: boolean) => void): Disposable` - Только перемены; текущее состояние - `focused()`. Чтобы не пропустить перемену между вопросом и подпиской, сначала подпишитесь, потом спросите.
- `focused(): Promise<boolean>` - Окно в фокусе сейчас. После первого события окна от приложения - последнее из них; до него - ответ приложения (`LoadOptions.windowFocused`), без источника - `true` («активно»). Плагин, поднятый при окне без фокуса, узнаёт это здесь, а не ждёт перемены. Права не нужно.
- `setTitle(segment: string | undefined): Promise<void>` - Свой фрагмент заголовка окна: ядро собирает «воркспейс - фрагменты по id плагина - приложение». `undefined` снимает фрагмент, выгрузка плагина - тоже. Управляющие символы ядро убирает, длиннее 80 символов - `Invalid`. Права не нужно.

### PluginSystem

События ОС; слушатель, бросивший исключение, пишет в журнал плагина и не мешает соседям.

- `onSuspend(listener: () => void): Disposable` - ОС уходит в сон.
- `onResume(listener: () => void): Disposable` - ОС вернулась из сна.
- `onScreenLock(listener: () => void): Disposable` - Экран заблокирован.
- `onIdle(seconds: number, listener: () => void): Disposable` - Один раз на каждый простой пользователя от `seconds` секунд; после активности срабатывает снова.
- `onBeforeQuit(listener: () => void | Promise<void>): Disposable` - Ядро ждёт слушателей не дольше бюджета приложения, потом хост завершается.

## Вид: UiModule и ctx вида

Файл `contracts/view.ts`.

### UiModule

Модуль из `ui.views`. `Root` - `HTMLElement`: контракты не тянут DOM в типы главной части. `mount` зовётся один раз на документ вида, `dispose` - когда ядро снимает вид.

- `mount(root: Root, ctx: UiContext): Disposable | undefined` - Монтирует вид в `root`. Зовётся один раз на документ вида; возвращаемый `Disposable` снимается, когда ядро снимает вид.

### UiContext

Урезанный `ctx` для UI плагина (SAD §3.8): права - те же, что у главной части, но `ctx.os` нет.

- `ctx.pluginId: string` - Идентификатор плагина, которому принадлежит вид.
- `ctx.view: string` - Имя вида из `ui.views` манифеста.
- `ctx.commands: {...}` - Команды своего плагина.
- `ctx.commands.run(command: string, ...args: unknown[]): Promise<unknown>` - Свои команды плагина; чужую ядро отклонит. Отказ - исключение с текстом ядра.
- `ctx.contracts: {...}` - Контракты, которые вид берёт через границу фрейма.
- `ctx.contracts.get<K extends ContractName, M extends Major<K>>(contract: K, major: M): Promise<UiRemote<ContractType<K, M>> | undefined>` - Контракт из `requires` или `optional` своего плагина; поставщика нет - undefined, контракта нет в манифесте - исключение.
- `ctx.theme: {...}` - Тема окна.
- `ctx.theme.tokens: ThemeTokens` - Текущие CSS-переменные темы. Тип: [ThemeTokens](#themetokens).
- `ctx.theme.onChange(listener: (tokens: ThemeTokens) => void): Disposable` - Тема сменилась: слушатель получает новые переменные.
- `ctx.visible: boolean` - Скрытая область не отмонтируется: DOM, прокрутка и выделение живут, а `document.visibilityState` фрейма об этом не знает.
- `ctx.onVisibilityChange(listener: (visible: boolean) => void): Disposable` - Вид показали или скрыли.
- `ctx.logs(): Promise<readonly FeedLine[]>` - Сообщения своего плагина, накопленные до открытия вида.
- `ctx.onLog(listener: (line: FeedLine) => void): Disposable` - Новая строка ленты журнала своего плагина.
- `ctx.terminal: {...}` - Терминалы, которые главная часть показала виду.
- `ctx.terminal.open(ticket: PtyTicket): Promise<UiTerminal>` - Билет от `PtyHandle.share()` своей главной части; чужой, просроченный или использованный - исключение.
- `ctx.state: {...}` - Память вида в состоянии воркспейса.
- `ctx.state.value: unknown` - Память вида в state воркспейса, какой её оставил прошлый документ; не писали - undefined. Схемы и миграций нет: формат - забота плагина.
- `ctx.state.set(value: unknown): Promise<void>` - JSON до 64 КБ; undefined - забыть. У каждого воркспейса своя память, поэтому не localStorage origin плагина.
- `ctx.dialogs: {...}` - Диалоги ядра поверх всех фреймов.
- `ctx.dialogs.show(spec: DialogSpec): Promise<string | undefined>` - Окно показывает диалоги по одному, под замком чужие ждут; ответ - id выбранного пункта, отмена или выгрузка плагина - undefined.
- `ctx.modal: ViewModal | undefined` - Есть, только пока вид показан как модальное окно (`area: "modal"`, `ctx.views.modal` главной части); у остальных видов - `undefined`. Тип: [ViewModal](#viewmodal).
- `ctx.channel: ViewChannel` - Канал с главной частью плагина по имени этого вида: сообщения, которые она шлёт виду, и ответы ей. Правила и лимит - у `ViewChannel`. Тип: [ViewChannel](#viewchannel).
- `ctx.keys: {...}` - Сочетания клавиш своих команд.
- `ctx.keys.of(command: string): string | undefined` - Сочетание своей команды, как оно сейчас привязано (с правками человека, под платформу): `Ctrl+Shift+F`; не привязана - undefined. Нажатие ловит ядро, вид его не видит.
- `ctx.drag: {...}` - Перетаскивание файлов между видами и приложением.
- `ctx.drag.start(path: string): void` - Перетаскивание файла ведёт ядро: Chromium не пускает перетаскивание из страницы во фрейм другого процесса. Путь - от корня рабочей папки.
- `ctx.drag.drop(): Promise<ViewDrop | null>` - Путь, сброшенный в этот вид, и плагин-источник; сброс не из вида - null.

### FeedLine

Строка ленты, которую ядро показывает виду его плагина.

- `at: number` - Время строки, мс от начала эпохи.
- `kind: 'log' | 'key' | 'window' | 'error'` - `log` - сообщение плагина, `key` - нажатие, перехваченное ядром, `window` - нажатие, дошедшее до страницы, `error` - отказ команды.
- `subject: string` - О чём строка: имя команды, сочетание или источник.
- `text: string` - Текст строки.

### Reply

Ответ ядра на вызов из вида: либо `error`, либо `value`.

- `error?: string` - Текст отказа.
- `value?: unknown` - Ответ команды или метода контракта - данные, прошедшие structured clone.

### ViewDrop

Путь, сброшенный в вид перетаскиванием.

- `from: string` - Плагин-источник перетаскивания.
- `path: string` - Сброшенный путь от корня рабочей папки.

### ThemeTokens

CSS-переменные темы: ядро ставит их на `:root` документа вида до `mount` и обновляет при смене темы.

```ts
type ThemeTokens = Readonly<Record<`--cy-${string}`, string>>;
```

### UiRemote

Контракт глазами вида: через границу фрейма идут только методы с данными; подписки и колбэки - у главной части плагина.

```ts
type UiRemote = { readonly [P in keyof T as NonNullable<T[P]> extends (...args: never[]) => unknown ? P : never]: NonNullable<T[P]> extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never; };
```

### UiTerminal

pty, который показала виду его главная часть: вывод и ввод идут через ядро мимо хоста, так что зависший хост терминал не останавливает.

`extends PtyInfo`

- `backlog: string` - Хвост вывода на момент открытия; может начинаться посреди escape-последовательности.
- `onData(listener: (chunk: string) => void): Disposable` - Вывод до первой подписки копится и отдаётся ей.
- `onExit(listener: (exit: PtyExit) => void): Disposable` - Процесс завершился: слушатель получает код выхода.
- `write(data: string): Promise<void>` - Ввод в терминал.
- `resize(cols: number, rows: number): Promise<void>` - Размер терминала в столбцах и строках.
- `close(): void` - Перестать смотреть; процесс живёт дальше - завершает его главная часть.

### DialogChoice

Пункт диалога: кнопка вопроса или строка меню.

- `id: string` - Идентификатор, который вернёт диалог при выборе.
- `label: string` - Подпись.

### AskDialog

Вопрос с кнопками: то, что видам и главной части одинаково доступно (`ctx.dialogs.show`).

- `kind: 'ask'` - Вид диалога: вопрос с кнопками.
- `title: string` - Заголовок вопроса.
- `message?: string` - Пояснение под заголовком.
- `buttons: readonly DialogChoice[]` - Кнопки по порядку.

### DialogSpec

Диалог в слое ядра поверх всех фреймов: `ask` - вопрос с кнопками, `menu` - меню у точки `at` в координатах вида.

```ts
type DialogSpec = | AskDialog | { readonly kind: 'menu'; readonly items: readonly DialogChoice[]; readonly at: { readonly x: number; readonly y: number } };
```

### ViewModal

Модальное окно глазами его вида: данные от владельца и способ вернуть ему результат.

- `data: unknown` - Данные, с которыми главная часть открыла окно (`ctx.views.modal(view, { data })`); не передала - `undefined`.
- `resize(size: ModalResize): Promise<void>` - Просит окно подогнать высоту под содержимое вида: вид живёт в чужом по origin фрейме, и окно не знает высоту его содержимого, пока вид не скажет. `height` - высота области вида в CSS-пикселях (без шапки окна), целое от 100 до 4096; окно не выше 80% высоты экрана, сверх этого область прокручивается. Вид шлёт просьбу сам, когда содержимое изменилось; та же высота окно не тревожит. Размер автора (`ModalInit.size`) по ширине остаётся; высота области вида его высоту заменяет. Неверная высота, окно, уже закрытое человеком или выгрузкой плагина, - исключение.
- `close(result?: unknown): Promise<void>` - Закрывает окно и отдаёт результат владельцу: данные до 64 КиБ. Окно, уже закрытое человеком или выгрузкой плагина, - исключение.

## Доступ к ОС: ctx.os и права

Файл `contracts/os.ts`.

### PluginOs

Доступ плагина к ОС через шлюз ядра; члены, на которые нет права в манифесте, отсутствуют.

- `paths: {...}` - Свои каталоги: данные и временный; читать и писать в них можно без права. Каталоги общие для всех процессов приложения с этим `userData` (несколько воркспейсов - несколько процессов, K-20): `fs.writeText` пишет файл целиком через временный файл и `rename`, поэтому соседний процесс видит прежний файл или новый, но не недописанный; потерю обновления при цикле «прочитал - изменил - записал» двух процессов ядро не снимает (замка для плагинов нет), её плагин исключает сам (отдельные файлы на процесс или своя блокировка).
- `paths.data: string` - Каталог данных плагина: переживает перезапуск, общий для процессов приложения с этим `userData`.
- `paths.temp: string` - Временный каталог плагина.
- `paths.home: string` - Домашний каталог человека; читать в нём можно только то, что разрешило право `fs.read`.
- `fs: OsFs` - Файлы. Тип: [OsFs](#osfs).
- `pty?: OsPty` - Терминалы; есть при праве `pty`. Тип: [OsPty](#ospty).
- `process?: {...}` - Программы нет в системе (или нет `cwd`) - `NotFound`; ненулевой код выхода ошибкой не считается и приходит в `ProcessResult.code`. Одновременных программ у плагина не больше 16, сверх - `Invalid`: очереди у ядра нет, пул ведёт плагин.
- `process.run(program: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult>` - Запускает программу без оболочки, ждёт завершения и возвращает вывод и код выхода. Программа и первые аргументы должны подходить под правило `process` манифеста.
- `net?: {...}` - Сеть; есть при праве `net`.
- `net.fetch(url: string, request?: HttpRequest): Promise<HttpResponse>` - HTTP-запрос к хосту из права `net` (`config:<поле>` - хост или список хостов из своего раздела `config`). Метод по умолчанию `GET`; срок и предел тела - в `HttpRequest`.
- `env?: {...}` - Переменные окружения; есть при праве `env`.
- `env.get(name: string): Promise<string | undefined>` - Значение переменной окружения, названной в праве `env`; переменной нет - `undefined`.
- `notify?: OsNotify` - Системные уведомления; есть при праве `notify`. Тип: [OsNotify](#osnotify).
- `clipboard?: {...}` - Буфер обмена; члены есть по праву `clipboard`.
- `clipboard.readText?(): Promise<string>` - Читает текст из буфера; есть при праве `clipboard: ["read"]`.
- `clipboard.writeText?(text: string): Promise<void>` - Пишет текст в буфер; есть при праве `clipboard: ["write"]`.
- `secrets: OsSecrets` - Своё хранилище секретов ядра; права не нужно. Тип: [OsSecrets](#ossecrets).
- `security?: {...}` - Настройки безопасности; есть при праве `security.roots`.
- `security.setRoots(paths: readonly string[]): Promise<void>` - Задаёт корни проектов: область `workspace` для всех плагинов. Корни, названные только в файле воркспейса, подтверждает человек.
- `ui?: OsUi` - Замок окна; есть при праве `ui.lock`. Тип: [OsUi](#osui).
- `serve?: {...}` - Слушает только 127.0.0.1; запрос с чужим Host или с Origin (страница в браузере) до обработчика не доходит. Выгрузка плагина закрывает его серверы.
- `serve.http(handler: (request: ServeRequest) => ServeResponse | Promise<ServeResponse>): Promise<HttpServer>` - Запускает сервер HTTP на 127.0.0.1 с портом от ОС; обработчик получает запрос и отвечает (не ответил за 30 с - клиент получит 504).
- `shell?: {...}` - Открыть путь или URL программой ОС; исполняемый файл не открывается - это был бы запуск в обход `process`.
- `shell.openPath?(path: string): Promise<void>` - Открывает документ или каталог программой ОС по умолчанию; путь должен лежать в области права `shell`.
- `shell.openExternal?(url: string): Promise<void>` - Открывает URL, схема которого названа в праве `shell` (`https:`, `mailto:`).
- `dialog: OsDialog` - Права не нужно: выбор человека сам становится областью `granted` и хранится в state воркспейса. Тип: [OsDialog](#osdialog).

### PluginPermissions

Права главной части плагина: что ядро пропустит через `ctx.os` (SAD §3.7). Нет права - нет члена в `ctx.os`.

- `'fs.read'?: readonly string[]` - Области путей: `workspace`, `plugin-data`, `plugin-temp`, `granted` (выбор человека в `dialog`), абсолютный путь (каталог с поддеревом, `~` - домашний) или маска: `*` - часть имени, `**` - любые каталоги.
- `'fs.write'?: readonly string[]` - Те же области и `workspace.git` - корни воркспейса вместе с записью в `.git`.
- `shell?: readonly string[]` - Открыть в системе: области путей, как у `fs.read`, `any` - любой существующий документ или каталог, и схемы URL с двоеточием (`https:`, `mailto:`).
- `process?: readonly ProgramRule[]` - Программы, которые плагин запускает через `ctx.os.process`: имя или правило `{ program, args, env?, deny? }` с закреплёнными первыми аргументами и запретом флагов в хвосте argv (`deny`). Даёт программе все права пользователя ОС.
- `pty?: readonly ProgramRule[]` - Программы в псевдотерминале; правило той же формы, что у `process`, в том числе `deny`.
- `launch?: readonly ProgramRule[]` - Запуски, которые поставщик описывает потребителю (`cyborg.agent`); члена в `ctx.os` не даёт, pty потребителя с `describedBy` сверяется и с ними.
- `net?: readonly string[]` - Хосты HTTP; `config:<поле>` - хост или список хостов из своего раздела config (значение поля - строка или список строк: адрес `https://gitlab.corp:8443` либо `хост:порт`), заданный человеком в слое пользователя. Такой хост ядро считает названным человеком: loopback и частный адрес из DNS ему разрешены, записи с фиксированным именем в манифесте - нет. Link-local (`169.254.0.0/16`, `fe80::/10`) и адреса метаданных облака закрыты любому хосту, и названному тоже.
- `env?: readonly string[]` - Имена переменных окружения, которые плагин читает через `ctx.os.env`.
- `notify?: boolean` - Системные уведомления (`ctx.os.notify`).
- `clipboard?: readonly ('read' | 'write')[]` - Буфер обмена: `read`, `write` или оба.
- `'secrets.ref'?: readonly string[]` - Маски ссылок на секреты внешнего источника: `vault://kv/data/jira*`.
- `'security.roots'?: boolean` - Задать корни проектов - область `workspace` для всех плагинов.
- `'ui.lock'?: boolean` - Закрыть окно своим `ui.overlay`; без него манифест не примут.
- `serve?: boolean` - Сервер HTTP на 127.0.0.1 (`ctx.os.serve`): так агент зовёт инструменты плагина по MCP.

### ProgramRule

Программа или программа с первыми аргументами; `env` - имена переменных, которые плагин может ей передать: точное имя или маска `ПРЕФИКС_*` для номерных: хвост после префикса - только десятичные цифры (`GIT_CONFIG_KEY_*` покрывает `GIT_CONFIG_KEY_0`, `GIT_CONFIG_KEY_12`, но не `GIT_CONFIG_KEY_X`; `GIT_*` не покрывает `GIT_SSH_COMMAND`). `deny` - флаги, запрещённые в хвосте argv после закреплённых `args`: запуск отклоняется, если элемент хвоста равен флагу или начинается с `флаг=` (`--output` ловит `--output` и `--output=путь`). Поле только у `process` и `pty`; список ведёт автор плагина, ядро своего не имеет. Склеенные короткие флаги (`-xD`) запрет не ловит: автор называет и их. Запрет смягчает правило, а не отменяет «полный доступ через программу».

```ts
type ProgramRule = string | { readonly program: string; readonly args: readonly string[]; readonly env?: readonly string[]; readonly deny?: readonly string[] };
```

### DirEntry

Запись каталога.

- `name: string` - Имя без пути.
- `kind: 'file' | 'dir' | 'link' | 'other'` - Что это: файл, каталог, ссылка или другое.

### FileStat

Сведения о файле или каталоге.

- `kind: 'file' | 'dir' | 'other'` - Что это: файл, каталог или другое.
- `size: number` - Размер в байтах.
- `mtimeMs: number` - Время последней правки, мс от начала эпохи.

### FileSlice

Кусок файла, прочитанный `readSlice`.

- `text: string` - Прочитанный текст.
- `bytes: number` - Сколько байт файла покрывает `text`: незаконченный символ UTF-8 на конце куска не входит - на столько сдвинуть `offset`.
- `size: number` - Размер всего файла в байтах.

### ProcessResult

Итог запущенной программы.

- `code: number | null` - Код выхода; `null`, если программу остановил сигнал.
- `signal: string | null` - Сигнал, остановивший программу, или `null`.
- `stdout: string` - Вывод до предела; обрезанный по `truncated` на границе символа.
- `stderr: string` - Вывод ошибок с теми же пределами, что у `stdout`.
- `truncated: boolean` - Вывод `stdout` или `stderr` дошёл до предела (`maxOutputBytes`, по умолчанию 16 МиБ): программа остановлена (`SIGTERM`, через 2 с глухой к нему - `SIGKILL`), а в ответе только прочитанное. Ошибка это или неполные данные, решает плагин: трекер отказывает («ответ больше N»), поиск берёт совпадения из прочитанного.

### ProcessOptions

Параметры запуска программы.

- `cwd?: string` - Рабочий каталог; должен лежать в области, доступной плагину.
- `env?: Readonly<Record<string, string>>` - Только имена из `env` правила `process`; база - PATH, HOME, локаль. Значения - данные, а не ссылки `$secret`.
- `input?: string` - Текст, который подаётся программе на стандартный ввод.
- `timeoutMs?: number` - Срок программы, мс; истёк - `SIGTERM` всей группе, в ответе `signal: 'SIGTERM'`; не остановилась за 2 с (глушит сигнал) - `SIGKILL`, `signal: 'SIGKILL'`.
- `maxOutputBytes?: number` - Предел вывода, байт на `stdout` и на `stderr` отдельно: целое от 1 до 64 МиБ, по умолчанию 16 МиБ. Превышение не ошибка вызова, а `truncated` в ответе.
- `signal?: AbortSignal` - Отмена: сигнал сработал - программе и её группе `SIGTERM` (глухой к нему - `SIGKILL` через 2 с, как по `timeoutMs`), вызов отклоняется `Cancelled`. Сработал до вызова - программа не запускается.

### HttpRequest

Параметры запроса `ctx.os.net.fetch`.

- `method?: string` - Метод HTTP; по умолчанию `GET`.
- `headers?: Readonly<Record<string, string>>` - Заголовки запроса.
- `body?: string` - Тело запроса, текст.
- `timeoutMs?: number` - Срок всего запроса вместе с телом, мс; по умолчанию 30 с, дольше - `Timeout`. Тело ответа больше 16 МиБ - `Remote`.

### HttpResponse

Ответ `ctx.os.net.fetch`.

- `status: number` - Код ответа HTTP.
- `headers: Readonly<Record<string, string>>` - Заголовки ответа, имена в нижнем регистре.
- `body: string` - Тело ответа, текст.

### ServeRequest

Запрос к серверу плагина: имена заголовков в нижнем регистре, тело - текст до 1 МиБ.

- `method: string` - Метод HTTP.
- `path: string` - Путь с запросом, как в первой строке HTTP: `/mcp?x=1`.
- `headers: Readonly<Record<string, string>>` - Заголовки запроса, имена в нижнем регистре.
- `body: string` - Тело запроса, текст до 1 МиБ.

### ServeResponse

Ответ обработчика; не ответил за 30 с - клиент получит 504, чужая форма - 502.

- `status: number` - Код ответа HTTP.
- `headers?: Readonly<Record<string, string>>` - Заголовки ответа.
- `body?: string` - Тело ответа, текст.

### HttpServer

Запущенный сервер плагина.

- `url: string` - `http://127.0.0.1:<порт>`; порт выбирает ОС.
- `dispose(): void` - Останавливает сервер.

### WatchOptions

Параметры слежения за файлами.

- `recursive?: boolean` - Следить за всем деревом под каталогом, а не за его детьми. Для файла - `Invalid`. Обход дерева и разбор событий ОС ядро выполняет вне главного потока приложения (отдельный поток `worker_threads`), главному потоку приходят готовые пачки имён: checkout на тысячи каталогов не замораживает окно. `watch` возвращается, когда дерево обойдено и слежение поставлено, - в большом дереве это дольше, чем без `recursive`. Закрытие слежения (`dispose`, выгрузка плагина, `onClose`) останавливает и этот поток. Отказ ОС по числу слежений (Linux: `fs.inotify.max_user_watches`) по-прежнему `Unavailable` с названием предела; поток, который не запустился или упал, - `Unavailable`, а если упал позже - `onClose` с причиной.

### OsFs

Файлы: без права - только свои каталоги `paths`; чтение шире - по `fs.read`, запись - по `fs.write`. Путь вне области - `PermissionDenied`, никогда `NotFound`; нет файла или каталога внутри области в `readText`, `readSlice`, `list`, `stat`, `watch`, `realpath` - `NotFound` (проверка существования - `stat` и ловля `NotFound`); `list` существующего файла - `Invalid`. Ни код, ни текст ошибки ОС не выдают путь вне области, названный плагином: ошибка раскрытия пути (`ENOTDIR`, `ELOOP`, `EACCES`) там тоже `PermissionDenied`. Путь через ссылку внутри области - путь внутри области, и ответ зависит от цели ссылки: цель вне области есть - `PermissionDenied`, ссылка висячая - `NotFound` (или ошибка операции), цель под закрытым снаружи каталогом - ошибка самой операции; ссылку создаёт человек или другая программа, плагин с `fs` её создать не может.

- `readText(path: string): Promise<string>` - Читает файл целиком как текст UTF-8.
- `list(dir: string): Promise<DirEntry[]>` - Список записей каталога.
- `stat(path: string): Promise<FileStat>` - Сведения о файле или каталоге; нет пути внутри области - `NotFound`.
- `realpath(path: string): Promise<string>` - Настоящий путь: ссылки раскрыты, как `realpath` ОС. Нужен, чтобы сверять пути по имени (ключи `~/.claude.json`, корни проектов): `/tmp/x` и `/private/tmp/x` - один каталог. Ссылка наружу области - `PermissionDenied`, нет пути - `NotFound`.
- `readSlice(path: string, offset: number, maxBytes: number): Promise<FileSlice>` - Кусок файла с байта `offset`, от 4 байт до 1 МиБ: длинный журнал читается частями, а не целиком.
- `watch(path: string, listener: (names: readonly string[]) => void, onClose?: (reason: string) => void, options?: WatchOptions): Promise<Disposable>` - Изменения файла или каталога по праву чтения; у каталога - имена изменённых, события склеиваются за 50 мс. С `options.recursive` слежение идёт за всем деревом под каталогом одной записью лимита 64, а имя в `listener` - путь изменённого относительно каталога с `/` в роли разделителя (`src/a/b.ts`); имена мест, закрытых плагину и при обычном чтении (каталоги других плагинов, данные приложения, защищённые пути), не приходят. Ссылки внутри дерева не раскрываются. Файл с `recursive` - `Invalid`. Рекурсивное слежение идёт вне главного потока приложения (#211), события приходят пачками. На Linux Node ставит inotify на каждый каталог внутри, и в большом дереве может не хватить `fs.inotify.max_user_watches`: `watch` отказывает `Unavailable` с названием предела, следите за каталогами по отдельности. Удалён наблюдаемый каталог (в том числе с `recursive`) или заменён каталогом с другим inode - `onClose` с причиной; ФС вправе отдать новому каталогу inode удалённого, тогда замена не замечается и событий больше не будет. Наблюдение файла переживает подмену файла через `rename` (`writeText`, редакторы с атомарной записью), в том числе когда старый файл держит открытым другой процесс (`tail -f`): событие приходит на каждую запись. Ядро закрыло наблюдение само (ошибка ОС, путь ушёл из прав, файл удалён, на его месте каталог или ссылка) - `onClose` с причиной. События о правках в первые миллисекунды после возврата `watch` не обещаны (на macOS FSEvents начинает доставку позже возврата вызова), поэтому плагин, которому нужно состояние сейчас, читает его сам после `watch`, а событие использует как повод перечитать. Имена в `listener` - то, о чём сообщила ОС: это не только дети каталога (на macOS в свежесозданном каталоге приходит и имя самого каталога), по ним состояние не выводят.
- `writeText(path: string, text: string): Promise<void>` - Атомарно: текст пишется во временный файл рядом (`<файл>.<hex>.tmp`) и переименовывается, читатель и оборванная запись видят прежний файл или новый целиком; режим существующего файла сохраняется; файл без права записи (0444) не заменяется - `EACCES`, как при записи на месте, так что `chmod a-w` защищает файл. Без `fsync`: падение процесса не страшно, потеря питания - не гарантия. Наблюдатель каталога видит имя временного файла. Временному файлу нужно право записи на его имя: если `fs.write` называет один файл или маску под имя (`*.json`), либо каталог цели закрыт для создания файлов, запись идёт на месте, без защиты от обрыва, зато ничего вне права не создаётся. Не обычный файл (каталог, ссылка, FIFO) - `Invalid`.
- `mkdir(path: string): Promise<void>` - Создаёт каталог, в том числе недостающие родительские.
- `remove(path: string): Promise<void>` - Удаляет файл или каталог с содержимым; пути, которого нет, - не ошибка.

### OsSecrets

Своё хранилище секретов ядра: ключи видны только своему плагину; без шифрования ОС - `Unavailable`.

- `get(key: string): Promise<string | undefined>` - Значение секрета по ключу своего плагина; нет - `undefined`.
- `set(key: string, value: string): Promise<void>` - Сохраняет секрет в хранилище ядра.
- `delete(key: string): Promise<void>` - Удаляет секрет.

### PtySpawnOptions

Параметры запуска программы в псевдотерминале.

- `program: string` - Программа; должна подходить под правило `pty` манифеста.
- `args?: readonly string[]` - Аргументы программы.
- `cwd?: string` - Рабочий каталог.
- `env?: Readonly<Record<string, string>>` - Только имена из `env` правила `pty`; база - PATH, HOME, локаль.
- `cols?: number` - Число столбцов.
- `rows?: number` - Число строк.
- `persist?: boolean` - Пережить перезапуск хоста: процесс ждёт, пока владелец вернётся через `attach`.
- `describedBy?: string` - Плагин, описавший запуск: ядро пропустит его, только если описание подходит и под правило `launch` этого плагина.

### PtyExit

Завершение процесса в терминале.

- `code: number` - Код выхода; `-1`, если хост потерял процесс.
- `signal?: number` - Номер сигнала, если процесс остановлен им.

### PtyInfo

Сведения о процессе в терминале.

- `id: string` - Идентификатор терминала.
- `pid: number` - Номер процесса в ОС.
- `program: string` - Запущенная программа.
- `args: readonly string[]` - Аргументы запуска.
- `persist: boolean` - Процесс переживает перезапуск хоста.
- `exit?: PtyExit` - Есть, если процесс завершился, пока владельца не было. Тип: [PtyExit](#ptyexit).

### PtyHandle

Терминал, которым владеет плагин.

`extends PtyInfo`

- `backlog: string` - Хвост вывода до `attach`; у только что запущенного пуст. Может начинаться посреди escape-последовательности.
- `onData(listener: (chunk: string) => void): Disposable` - Слушатель вывода терминала.
- `onExit(listener: (exit: PtyExit) => void): Disposable` - Завершился до подписки - слушатель получит выход сразу.
- `write(data: string): Promise<void>` - Ввод в терминал.
- `resize(cols: number, rows: number): Promise<void>` - Размер терминала в столбцах и строках.
- `kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'): Promise<void>` - Посылает сигнал процессу; без аргумента процесс завершается.
- `share(): Promise<PtyTicket>` - Одноразовый билет для своего UI (`ctx.terminal.open` в виде): живёт 30 с, чужой плагин его не откроет.

### PtyTicket

Строка-билет: главная часть передаёт её своему виду, например ответом своей команды.

```ts
type PtyTicket = string;
```

### OsPty

Процесс держит ядро: он переживает хост плагина, если просили `persist`.

- `spawn(options: PtySpawnOptions): Promise<PtyHandle>` - Запускает программу в терминале по правилу `pty` манифеста.
- `list(): Promise<PtyInfo[]>` - Только свои pty.
- `attach(id: string): Promise<PtyHandle>` - Свой pty без владельца: после перезапуска хоста или «Оставить работать». Брать при активации: с неё идёт льготный срок ядра, после него процесс завершён и ответ - `NotFound`.

### NotifyClick

Клик по уведомлению: своя команда из манифеста, аргументы сверяются её схемой. Команда, а не колбэк: клик переживёт перезапуск хоста.

- `command: string` - Своя команда из манифеста.
- `args?: readonly unknown[]` - Аргументы команды.

### NotifyOptions

Параметры уведомления.

- `onClick?: NotifyClick` - Клик поднимает окно, закрывает уведомление и запускает команду. Тип: [NotifyClick](#notifyclick).

### OsNotify

Выгрузка плагина закрывает его живые уведомления; падение хоста - нет, клик дойдёт до вернувшегося плагина.

- `show(title: string, body?: string, options?: NotifyOptions): Promise<string>` - Ответ - id уведомления для `close`. Длина заголовка и текста ограничена средой, превышение - `Invalid`; сверх предела живых закрывается старейшее уведомление плагина.
- `close(id: string): Promise<void>` - Уже закрытое или чужое уведомление - ничего не делает.

### OpenDialogOptions

Параметры диалога выбора пути.

- `title?: string` - Заголовок диалога.
- `directory?: boolean` - Выбирать каталоги.
- `multiple?: boolean` - Разрешить несколько путей.

### OsDialog

Диалог выбора пути, который показывает ядро.

- `open(options?: OpenDialogOptions): Promise<string[]>` - Отмена - пустой список; окно закрыто чужим замком - `Unavailable`.

### OsUi

Замок окна: чужие виды скрыты и `inert`, виден только `ui.overlay` владельца, работают только его сочетания и диалоги. Главные части работают дальше.

- `lock(options?: { readonly hideNotifications?: boolean }): Promise<UiLock>` - `hideNotifications` прячет текст уведомлений и имя воркспейса в заголовке окна. Повторный вызов владельца меняет только его. Хост владельца упал - окно остаётся закрытым до его возвращения.

### UiLock

Замок, взятый плагином.

- `release(): Promise<void>` - Снимает только свой замок; два замка - окно откроется, когда сняты оба.

### SecretValue

Раскрытое значение секрета.

- `value: string` - Значение.
- `expiresAt?: number` - Аренда источника: после этого значение надо спросить заново.

### SecretRef

Ссылка на секрет в `config`: без схемы - своё хранилище ядра, со схемой - источник секретов.

- `$secret: string` - Ключ секрета: без схемы - свой ключ в хранилище ядра, со схемой - ссылка на внешний источник.

### PluginSecrets

Раскрытие ссылок на секреты.

- `resolve(ref: string | SecretRef): Promise<SecretValue>` - Раскрывает ссылку: ключ (строка) или `{ "$secret": "..." }`. Значение не попадает в журнал.
