---
level: product
feature: cyborg-harness
status: review
date: 2026-11-11
origin: derived
---

# Доменная модель: словарь терминов

Термины сверены с [SAD](../04-architecture/design/sad.md) и кодом `core/`, `contracts/`. Бывший `docs/glossary.md`. Правила употребления - [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md).

## Ядро и плагины

| Термин | Значение | Дом | Не путать с |
|---|---|---|---|
| **Ядро** | Хост плагинов без предметной области: открывает воркспейс, загружает плагины, связывает их, изолирует сбои, следит за правами, даёт экран, клавиши и хранение. Агентов, сессий, файлов, проектов и трекеров в ядре нет ([SAD, раздел 2](../04-architecture/design/sad.md#2-что-есть-ядро)) | [SAD, раздел 2](../04-architecture/design/sad.md#2-что-есть-ядро) | - |
| **Цели ядра** | Десять целей, ради которых существует ядро; всё вне них - плагины ([SAD, раздел 3](../04-architecture/design/sad.md#3-цели-ядра)) | [SAD, раздел 3](../04-architecture/design/sad.md#3-цели-ядра) | - |
| **Плагин Cyborg** | Модуль приложения по этому проекту: манифест, главная часть, виды. В коде - `plugin`, `PluginManifest`, `PluginContext`. Все плагины равны: у встроенных нет особого API | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 1 | плагин Claude Code |
| **Плагин Claude Code** | То, что ставят командой `claude plugin`. | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 2 | плагин Cyborg; пишется только с уточнением «Claude Code» |
| **Поставка** | Плагины, которые приходят вместе с Cyborg. | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 4; [SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож) | манифест: признак - каталог установки, а не манифест |
| **Встроенный плагин** | Плагин из поставки. По умолчанию его главная часть идёт в хост `builtin`; в конфликте сочетаний побеждает стороннего | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 4; [SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож) | уровни доверия L0-L2 (их нет) |
| **Сторонний плагин** | Плагин не из поставки. Всегда один в своём хосте и в своей группе рендера (origin `solo_<id>`) из любого слоя config; группа его не объединяет, ядро пишет `host-isolated` и `group-isolated` ([SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож)) | [SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож); [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 4 | уровни доверия L0-L2 (их нет) |
| **Манифест** | JSON плагина (в playground - `manifest.json`), который ядро разбирает до запуска кода: `id`, `version`, `engines.cyborg`, `provides`, `requires`, `optional`, `consumes`, `commands`, `keybindings`, `permissions`, `config`, `state`, `ui`, `documents`, `host`, `activation`, `lock` ([ADR-CH-0002](../04-architecture/adr/ADR-CH-0002-manifest-and-compatibility.md)) | [ADR-CH-0002](../04-architecture/adr/ADR-CH-0002-manifest-and-compatibility.md) | блок `cyborg` в `package.json` (первая редакция) |
| **Главная часть** | Код плагина с `activate(ctx)`; работает в хосте и получает `PluginContext` | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 5; [SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож) | - |
| **Вид** | UI плагина в своём `<iframe>` по адресу `cyborg-plugin://<группа>/<плагин>/` (origin задаёт группа рендера); монтируется `mount(root, ctx)` и получает `UiContext` без `ctx.os` ([SAD, 3.8](../04-architecture/design/sad.md#38-изоляция-рендера)) | [SAD, 3.8](../04-architecture/design/sad.md#38-изоляция-рендера); [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 5 | - |
| **Группа рендера** | Набор плагинов с видами, которые делят origin `cyborg-plugin://<группа>/` и процесс рендера. Рекомендует автор (`ui.group`), решает владелец (`plugins.uiGroups` файла пользователя), без группы - группа со своим id, сторонний всегда один; граница доверия моста - группа ([SAD, 3.8](../04-architecture/design/sad.md#38-изоляция-рендера)) | [SAD, 3.8](../04-architecture/design/sad.md#38-изоляция-рендера) | - |
| **Хост** | Процесс `utilityProcess`, где живут главные части плагинов одной группы. Группы задаёт пользователь в `plugins.hosts` | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 5; [SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож) | - |
| **Сторож** | Проверка хостов ядром: пинг раз в 1 с, нет ответа 5 с - перезапуск хоста; после трёх зависаний подряд виновник выключается ([SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож)) | [SAD, 3.5](../04-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож) | - |
| **Ленивая активация** | `"activation": "lazy"`: плагин ждёт до первой команды, сочетания, показа своего вида или активации своего потребителя ([SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов)) | [SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов) | - |
| **Журнал плагинов** | Отказы загрузки, ошибки активации, отказы прав, перезапуски хостов; виден в окне «Плагины Cyborg» | [SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов) | - |
| **«Плагины Cyborg»** | Окно управления плагинами: состояние, хосты, права словами, сочетания и конфликты, журнал | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 1 | окно «Расширения» (управляет плагинами, скиллами, серверами MCP и магазинами Claude Code) |
| **Безопасный режим** | Запуск, в котором выключены все плагины без исключений; замок `lock.onStart` не ставится ([SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов)) | [SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов) | безопасный режим «только ядро и встроенные» (первая редакция) |
| **Воркспейс** | Главная сессия приложения: файл `config` воркспейса, его `state` и одно окно. Один экземпляр - один воркспейс - одно окно ([SAD, 3.1](../04-architecture/design/sad.md#31-воркспейс-как-главная-сессия)) | [SAD, 3.1](../04-architecture/design/sad.md#31-воркспейс-как-главная-сессия) | - |

## Связь плагинов

| Термин | Значение | Дом | Не путать с |
|---|---|---|---|
| **Контракт** | Имя, версия и типы API между плагинами; типы - в пакете объявлений `@cyborg-harness/contracts`. Члены асинхронны, данные переживают `structuredClone` ([SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов)) | [SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов) | - |
| **Поставщик** | Плагин, который объявляет контракт в `provides` и отдаёт его реализацию | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 3; [SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов) | «провайдер» (слово не используется; `Provider` в коде - запись о поставщике в `ctx.contracts.all`, `contracts/plugin.ts`, а не роль) |
| **Потребитель** | Плагин, который берёт контракт через `requires`, `optional` или `consumes` | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 3; [SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов) | - |
| **Кратность** | Сколько поставщиков получает потребитель: `requires` и `optional` - ровно один, `consumes` - все списком | [SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов) | - |
| **Граф контрактов** | Связи `provides` и `requires`, которые ядро проверяет до запуска кода: недостающий поставщик, два при кратности один, цикл - отказ с причиной в журнале ([SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов)) | [SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов) | - |
| **Команда** | Действие по имени в пространстве `id` плагина; аргументы описаны в манифесте и сверяются ядром до обработчика | [SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов); [ADR-CH-0005](../04-architecture/adr/ADR-CH-0005-plugin-interaction.md) | - |
| **Сочетание** | Клавиши, объявленные в манифесте на свою команду; ядро перехватывает их до страницы. Человек переназначает их в `plugins.keybindings` ([SAD, 3.9](../04-architecture/design/sad.md#39-системные-клавиши-и-события)) | [SAD, 3.9](../04-architecture/design/sad.md#39-системные-клавиши-и-события) | - |
| **`guard`, `via-contract`** | Пометка поставщика, какие аргументы членов контракта - пути или ссылки под право; ядро сверяет их с правом вызывающего, отказ - `PermissionDenied` с `reason: 'via-contract'` | [ADR-CH-0005](../04-architecture/adr/ADR-CH-0005-plugin-interaction.md), п. 8 | режим событий `guard` первой редакции (общей шины событий нет) |
| **`@deprecated`** | Пометка члена контракта или API, который живёт минимум до следующей мажорной версии | [ADR-CH-0002](../04-architecture/adr/ADR-CH-0002-manifest-and-compatibility.md), п. 5 | префикс `experimental_` (не заводится) |

## Права и ОС

| Термин | Значение | Дом | Не путать с |
|---|---|---|---|
| **Шлюз `ctx.os`** | Единственный путь плагина к ОС. Нет права - нет члена; путь проверяется после `realpath`; отказ - `PermissionDenied` с записью в журнал ([SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов)) | [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) | - |
| **Право** | Ключ в `permissions` манифеста: `fs.read`, `fs.write`, `shell`, `process`, `pty`, `launch`, `net`, `env`, `notify`, `clipboard`, `secrets.ref`, `security.roots`, `ui.lock`, `serve`. Окно «Плагины Cyborg» показывает его словами | [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) | возможность (capability) первой редакции |
| **Области путей** | `workspace` (задают плагины с правом `security.roots`), `plugin-data`, `plugin-temp` (всегда свои), явные пути и маски, `granted` (выбор человека в диалоге) | [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) | - |
| **Честная граница** | Право, которое даёт больше, чем видно: `process` и `pty` на программу - это полный доступ через неё. Окно показывает это прямо, а не прячет | [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) | - |
| **Два класса плагинов** | Базовые модули (`sessions`, агенты, `files`, git, поиск) с широкими правами и интеграции по HTTP API, которые режутся до сети к своему хосту и своего токена ([SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов)) | [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) | - |
| **pty, `persist`, `attach`** | Псевдотерминал - ресурс ядра, живёт дольше плагина. `persist` - переживает перезапуск хоста и окна; `attach` - вернуться к живому pty после перезапуска ([SAD, 3.6](../04-architecture/design/sad.md#36-ресурсы-дольше-плагина-pty)) | [SAD, 3.6](../04-architecture/design/sad.md#36-ресурсы-дольше-плагина-pty) | - |
| **Билет** | Разрешение, которое главная часть выдаёт своему виду на просмотр и ввод в свой pty; вывод идёт из ядра прямо во фрейм, мимо хоста | [SAD, 3.6](../04-architecture/design/sad.md#36-ресурсы-дольше-плагина-pty) | - |
| **Хранилище секретов** | Хранилище ядра на `safeStorage`; ключи по владельцу, каждый плагин видит только свои ([SAD, секреты](../04-architecture/design/sad.md#секреты)) | [SAD, секреты](../04-architecture/design/sad.md#секреты) | источник секретов |
| **`$secret`** | Ссылка на секрет в `config` вида `{ "$secret": "ключ" }`; значения секретов в `config` и `state` не лежат | [SAD, секреты](../04-architecture/design/sad.md#секреты) | - |
| **Источник секретов** | Плагин, поставщик `cyborg.secret-source` (Vault, 1Password, `pass`). Отложен до первого такого плагина | [SAD, секреты](../04-architecture/design/sad.md#секреты) | хранилище секретов ядра (источник его не подменяет) |

## Интерфейс

| Термин | Значение | Дом | Не путать с |
|---|---|---|---|
| **Роды областей** | Что знает о расстановке ядро: боковая колонка, основная область с группой документов, панель инструментов, всплывающий слой, слой замка. Плагин указывает род (`sidebar`, `main`, `toolbar`, `popup`) и `order` в манифесте, ядро отдаёт упорядоченный снимок `Kernel.layout` ([ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md)) | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md) | - |
| **Документ** | Вкладка основной области с типом из манифеста. `restorable` - переживает перезапуск окна; данные отдаёт владелец через `ctx.documents.save` | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md); [SAD, 3.8](../04-architecture/design/sad.md#38-изоляция-рендера) | - |
| **Элементы ядра** | Веб-компоненты `cy-button`, `cy-field`, `cy-list`, `cy-tree`, `cy-tabs`, `cy-empty`, `cy-spinner`; их определяет оболочка вида до `mount` | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md), п. 4 | - |
| **Токены темы** | CSS-переменные `--cy-*` (цвета, шрифты, отступы, радиусы); приходят в каждый вид до `mount` и при смене темы | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md), п. 4 | - |
| **Слой диалогов** | Диалоги и меню ядра поверх всех фреймов (`ctx.dialogs.show`), по одному за раз | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md), п. 6 | - |
| **Замок окна** | Механизм ядра: с правом `ui.lock` и экраном `ui.overlay` плагин закрывает окно; чужие виды скрыты и не принимают ввод. | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md), п. 10 | защита данных (замок защищает экран, а не данные) |
| **Задача, а не виджет** | Нужен чужой UI - вызывается команда или контракт владельца, и он сам показывает свой документ или диалог | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md), п. 5 | виджет (чужой UI в свой не встраивается) |

## Состояние и версии

| Термин | Значение | Дом | Не путать с |
|---|---|---|---|
| **`config`** | Намеренные настройки: файл пользователя и файл воркспейса. Плагин видит только свой раздел ([SAD, 3.10](../04-architecture/design/sad.md#310-главный-конфиг-и-состояние)) | [SAD, 3.10](../04-architecture/design/sad.md#310-главный-конфиг-и-состояние) | `state` |
| **`state`** | Память машины: активный проект, ширины, раскрытые узлы, расстановка. В каталоге приложения, ключ по воркспейсу | [SAD, 3.10](../04-architecture/design/sad.md#310-главный-конфиг-и-состояние) | `config` |
| **Раздел** | Часть `config` или `state` одного плагина со своей `version` и, по желанию, схемой (подмножество JSON Schema) | [SAD, 3.3](../04-architecture/design/sad.md#33-версии-и-миграции); [SAD, 3.10](../04-architecture/design/sad.md#310-главный-конфиг-и-состояние) | - |
| **`migrate`** | Функция плагина `migrate(fromVersion, data)`; ядро зовёт её до активации, если версия раздела ниже манифеста ([SAD, 3.3](../04-architecture/design/sad.md#33-версии-и-миграции)) | [SAD, 3.3](../04-architecture/design/sad.md#33-версии-и-миграции) | - |

## Этапы

| Термин | Значение | Дом | Не путать с |
|---|---|---|---|
| **Этап 1** | Ядро без изоляции доступа: изоляция сбоев и рендера для всех плагинов, права видны, но код плагина может обойти шлюз ([SAD, 6.1](../04-architecture/design/sad.md#61-этап-1-ядро-без-изоляции-доступа)) | [SAD, 6.1](../04-architecture/design/sad.md#61-этап-1-ядро-без-изоляции-доступа) | - |
| **Дисциплина** | Правила этапа 1, которые держат путь к этапу 2: импорт только `@cyborg-harness/contracts` и своих модулей, данные через `structuredClone`, UI говорит только через `ctx`. Импорты проверяет `checkPlugin` (`core/src/plugin-check.ts`, команда `cyborg-plugin check`); на плагинах репозитория её запускает `core/test/plugin-imports.test.ts` | [SAD, 6.1](../04-architecture/design/sad.md#61-этап-1-ядро-без-изоляции-доступа); [ADR-CH-0003](../04-architecture/adr/ADR-CH-0003-trust-and-isolation.md), п. 6 | - |
| **Этап 2** | Изоляция доступа по поводу (автор вне команды или каталог плагинов): `Compartment` в хостах, окна согласия, установка ([SAD, 6.2](../04-architecture/design/sad.md#62-этап-2-изоляция-доступа-по-поводу)) | [SAD, 6.2](../04-architecture/design/sad.md#62-этап-2-изоляция-доступа-по-поводу) | - |
| **`Compartment`** | Механизм `ses`: после `lockdown()` общие объекты заморожены, код плагина видит только переданное. Годится ли в `utilityProcess`, решит спайк этапа 2 | [SAD, 6.2](../04-architecture/design/sad.md#62-этап-2-изоляция-доступа-по-поводу); [ADR-CH-0003](../04-architecture/adr/ADR-CH-0003-trust-and-isolation.md) | - |

## Термины первой редакции

Решения первой редакции (2026-11-02) пересмотрены ([SAD, раздел 7](../04-architecture/design/sad.md#7-расхождения-с-первой-редакцией-пакета)). Их термины в новых документах не употребляются.

| Термин (первая редакция) | Значение (что вместо) | Дом | Не путать с |
|---|---|---|---|
| Сервис, реестр сервисов, `inject` | Контракт в манифесте, поставщик и потребитель | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 3; [SAD, раздел 4](../04-architecture/design/sad.md#4-взаимодействие-плагинов) | - |
| Шина событий, режимы observe, waterfall, guard | Событие - член контракта владельца предмета; сбор вкладов - контракт кратности many | [ADR-CH-0005](../04-architecture/adr/ADR-CH-0005-plugin-interaction.md), п. 6 | - |
| Точка расширения | Контракты и команды в манифесте ([ADR-CH-0005](../04-architecture/adr/ADR-CH-0005-plugin-interaction.md)) | [ADR-CH-0005](../04-architecture/adr/ADR-CH-0005-plugin-interaction.md) | - |
| Слот | Роды областей и вид в своём `<iframe>` ([ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md)) | [ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md) | - |
| Уровни доверия L0, L1, L2 | Встроенный и сторонний плагин; изоляция сбоев и рендера для всех, доступа - этап 2 ([ADR-CH-0003](../04-architecture/adr/ADR-CH-0003-trust-and-isolation.md)) | [ADR-CH-0003](../04-architecture/adr/ADR-CH-0003-trust-and-isolation.md); [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 4 | - |
| Провайдер агента | Плагин-поставщик `cyborg.agent` ([ADR-CH-0004](../04-architecture/adr/ADR-CH-0004-agent-provider-contract.md)) | [ADR-CH-0004](../04-architecture/adr/ADR-CH-0004-agent-provider-contract.md) | - |
| Провайдер трекера | Плагин-интеграция; настройки трекеров - через `cyborg.project-settings` | [SAD, раздел 7](../04-architecture/design/sad.md#7-расхождения-с-первой-редакцией-пакета) | - |
| Definition, Provider, Consumer | Контракт, поставщик, потребитель | [ADR-CH-0008](../04-architecture/adr/ADR-CH-0008-terminology.md), п. 3 | - |
| Возможность (capability) | Право | [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) | - |
| `experimental_` | Не заводится: нестабильное ломает мажорная версия контракта, переход - `@deprecated` ([ADR-CH-0002](../04-architecture/adr/ADR-CH-0002-manifest-and-compatibility.md), D-10 [журнала решений](../03-requirements/01-plugin-host/decision-log.md)) | [ADR-CH-0002](../04-architecture/adr/ADR-CH-0002-manifest-and-compatibility.md) | - |
| Храповик | Статическая проверка импортов плагинов `checkPlugin` (`core/src/plugin-check.ts`); тест репозитория - `core/test/plugin-imports.test.ts` | код: `core/src/plugin-check.ts`, `core/test/plugin-imports.test.ts` | - |
| Блок `cyborg` в `package.json` | Манифест JSON в каталоге плагина | [ADR-CH-0002](../04-architecture/adr/ADR-CH-0002-manifest-and-compatibility.md) | - |
| Безопасный режим «только ядро и встроенные» | Безопасный режим выключает все плагины | [SAD, 3.2](../04-architecture/design/sad.md#32-загрузка-плагинов) | - |
