# Журнал изменений @cyborg-harness/contracts

Формат - [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии - [semver](https://semver.org/lang/ru/) по правилам из [README](README.md#установка-и-версии). Запись обязательна в каждом изменении, которое меняет `api-snapshot.txt`.

## Правило записи

- Каждое изменение карты `Contracts`, `PluginContext`, `UiContext`, `PluginPermissions` или другого экспортируемого типа - строка в разделе `Unreleased` в том же PR.
- Строка начинается с затронутого имени в обратных кавычках и называет, что повышает версию: `[major]`, `[minor]` или `[patch]`.
- Для контракта (`cyborg.agent`) добавляется его мажорная версия: `cyborg.agent` v1.
- При выпуске `Unreleased` переименовывается в номер версии и дату (`## 1.1.0 - 2026-12-01`), версия в `package.json` и в `api-snapshot.txt` повышается тем же коммитом.

## Unreleased

Пусто: изменения до кандидата записаны ниже.

## 1.0.0-rc.1 - 2026-11-11

Кандидат в первый выпуск (K-21, [#62](https://github.com/dex-it/cyborg-harness/issues/62)). Эталон API плагина `core/test/api-snapshot/1.0.0.txt` принят как форма 1.0: с этой версии декларации без нового номера кандидата не меняются, а ломающая правка эталона ждёт мажора 2.0.0. Не выпущен в реестр; на `1.0.0` кандидата переводит снятие суффикса, когда закрыты условия заморозки (дорожная карта, раздел 17: открыта угроза У-42). Изменения API, набранные на линии разработки:

### Добавлено
- Пакет собирается в декларации (`dist/*.d.ts`) без расширений `.ts` в путях и ставится по номеру версии; в `exports` только условие `types`, кода выполнения в пакете нет.
- Снимок деклараций `api-snapshot.txt` и проверка `npm run check:contracts`: изменение публичных типов без повышения версии пакета - ошибка CI.
- `PluginContext.keys`, `PluginKeys`, `KeyBinding`, `KeyWhen`, `KeyRegistration` [minor]: `ctx.keys.register` - сочетание клавиш с условиями во время работы плагина (K-07).
- `ProcessOptions.signal` [minor]: отмена `ctx.os.process.run` сигналом `AbortSignal`, код отказа `Cancelled` (K-09); в пакете объявлен минимум `AbortSignal` (`aborted`), чтобы потребитель без lib DOM и @types/node собирал плагин.
- `ProcessResult.truncated`, `ProcessOptions.maxOutputBytes` [minor]: вывод `process.run` до предела с признаком обрезки вместо тихой потери; предел задаёт плагин (K-12).
- `OsFs.realpath` [minor]: настоящий путь с проверкой области; ссылка наружу - `PermissionDenied`, нет пути - `NotFound` (K-12).
- `PluginContext.views`, `PluginViews`, `ViewChannel`, `UiContext.channel` [minor]: канал «главная часть - вид» по имени вида, `post` и `onMessage` в обе стороны, сообщение до 64 КиБ (K-13).
- `PluginViews.modal`, `ModalInit`, `UiContext.modal`, `ViewModal`, область `modal` в `ui.views` [minor]: модальное окно плагина - вид с `area: "modal"`, главная часть открывает его `ctx.views.modal(view, { title?, data? })` и получает результат из `ctx.modal.close(result)` вида; Escape и выгрузка плагина дают `undefined` (K-13).
- `ModalInit.size`, `ModalSize`, `ModalInit.escape` [minor]: размер модального окна задаёт автор (`{ width?, height? }`, целые пиксели от 100 до 4096), а `escape: "view"` оставляет Escape виду окна вместо закрытия окна ядром (#163).
- `ViewModal.resize`, `ModalResize` [minor]: `ctx.modal.resize({ height })` - вид просит окно подогнать высоту под содержимое (высота области вида в CSS-пикселях, целое от 100 до 4096; окно не выше 80% экрана); заменяет `ModalInit.size.height`, ширина остаётся (#197). Вид только вызывает метод; тест, подменяющий `ViewModal` своей подделкой, добавит `resize`.
- `PluginContext.dialogs`, `PluginDialogs`, `AskDialog` [minor]: `ctx.dialogs.show(ask)` - вопрос человеку из главной части без вида, в той же очереди окна, что диалоги видов; `menu` у главной части нет (K-13).
- `PluginContext.log`, `LogLevel` [minor]: второй необязательный параметр `level` (`info`, `warn`, `error`; по умолчанию `info`), существующие плагины с одним аргументом работают как прежде; ядро обрезает строку длиннее предела и не кладёт в журнал по одной строки сверх предела частоты (K-29).
- `OsFs.watch` четвёртый параметр `options`, `WatchOptions` [minor]: `{ recursive: true }` следит за всем деревом под каталогом одной записью лимита, имя в `listener` - путь от каталога через `/`; удаление наблюдаемого каталога (в том числе без `recursive`; замена каталогом с другим inode - тоже) закрывает наблюдение с причиной в `onClose`; отказ ОС по числу слежений - `Unavailable` с названием предела (#182). Существующие вызовы `watch` работают как прежде.
- `Contracts['cyborg.git']`, `Git`, `GitStatus`, `GitChange`, `GitCode` [minor]: черновик контракта `cyborg.git` v1 - `status(repo)` и `onChange(repo, listener)`; остальные члены SAD (`headContent`, `branches`, `switch`, `remotes`, `files`) придут необязательными (PL-04).
- `Contracts['cyborg.tree-decoration']`, `TreeDecoration`, `TreeMark`, `TreeMarkKind` [minor]: черновик контракта `cyborg.tree-decoration` v1, кратность many - `marks(root)` и `onChange(listener)` (PL-04).
- `cyborg.sessions` v1, `Sessions`, `SessionEvent`, `SessionChange` [minor]: черновик пилота PL-02 - события сессий `onChange` (`cwd`, `activity`, `waiting`, `exit`); остальные члены реестра (`create`, `send`, `reveal`, метки) придут минорными версиями.
- `PluginWindow.focused` [minor]: `ctx.window.focused()` - окно в фокусе сейчас (последнее событие приложения; до него - ответ приложения `LoadOptions.windowFocused`; без источника - «активно»); `onFocusChange` по-прежнему сообщает только перемены, плагин, поднятый при окне без фокуса, больше не пропускает первое событие (#193; принято по поручению владельца 2026-11-10).
- `PluginDocuments.reveal` [minor]: `ctx.documents.reveal(id)` - просьба сделать вкладку своего документа активной; чужой и закрытый - `NotFound`, под чужим замком окна - `Unavailable`, окно из фона сама не поднимает; приложение получает её в `LoadOptions.onDocumentReveal` (#194; принято по поручению владельца 2026-11-10).
- `Sessions.reveal` (`cyborg.sessions` v1, поставщик объявляет `1.1`) [minor]: необязательный член `reveal?(sessionId)` - открыть вкладку сессии; поставщик 1.0 его не даёт, потребитель проверяет, что он есть (#194).

### Эталон API плагина
- Эталон `core/test/api-snapshot/1.0.0.txt` дополнен записями, которых снимок T-06 не видел (типы деклараций не менялись): вклады в меню (`Contributes`, `MenuItemDecl`, `StateSource`, `MENU_NAMES`, K-08), открытые свойства и события элементов `cy-*` (`items`, `tabs`, `expanded`, `cy-select`, `cy-toggle` и другие). Теперь удаление любого из них краснеет так же, как удаление члена `ctx`.

## 1.0.0-dev - не выпущена

Линия разработки до кандидата: типы менялись без повышения версии (проверка `--base` её не требовала), снимок `api-snapshot.txt` обновлялся. Первый выпуск `1.0.0` фиксирует набор: `cyborg.agent` v1, `cyborg.agent-tool` v1, `cyborg.session-prompt` v1, `cyborg.sessions` v1 (черновик), API плагина (`PluginModule`, `PluginContext`, `UiModule`, `UiContext`), `ctx.os`, элементы ядра `cy-*`. Выпуск в реестр - задача P-10 после заморозки API (K-21).
