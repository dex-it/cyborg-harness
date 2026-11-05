---
level: verification
feature: cyborg-harness
status: review
date: 2026-11-05
origin: derived
quality-checks: входных записей нет
---

# План паритета: как проверяем, что ничего не потеряно

> План на этапе проектирования: механизмов ещё нет, они создаются в P0-P1 ([дорожная карта](../05-plans/roadmap.md)). Решение - [ADR-CH-0006](../03-architecture/adr/ADR-CH-0006-strangler-migration-and-parity.md), требования - [фича 03](../01-product/03-migration/srs.md). Владельцы функций и каналов проведены по модели [SAD2](../03-architecture/design/sad2.md) и проверены по коду (`src/main/main.ts`, `src/main/preload.ts`, `src/renderer/`) на `e4beb72`; исправления неточностей прежней версии - из [ресёрча-2, раздел 5](../research/sad2-validation.md#5-сверка-с-кодом). Идентификаторы FR-CH и NFR-CH - из сводок «Сводка по SAD2» в конце [фичи 01](../01-product/01-plugin-host/srs.md#3-сводка-по-sad2), [02](../01-product/02-extension-contracts/srs.md#3-сводка-по-sad2) и [03](../01-product/03-migration/srs.md#3-сводка-по-sad2).

## 1. Что значит «не потеряно»

Функция считается сохранённой, если одновременно:

1. все её требования основного корпуса (`docs/01-product/NN-*/srs.md`) по-прежнему подтверждены своими проверками;
2. все прежние тесты зелёные, а их утверждения не изменены (меняются пути импорта и способ доступа к проверяемому: окно превращается в `<iframe>`, [FR-CH-3015](../01-product/03-migration/srs.md#fr-ch-3015-перенос-тестов-с-сохранением-утверждений));
3. поведение, снятое на записанных сессиях и подставных программах, совпадает с эталоном до допустимых расхождений;
4. данные пользователя после однократной миграции ([FR-CH-3011](../01-product/03-migration/srs.md#fr-ch-3011-перенос-формата-воркспейса), [FR-CH-3012](../01-product/03-migration/srs.md#fr-ch-3012-перенос-файлов-пользователя-и-localstorage)) эквивалентны прежним, прежние каналы IPC отвечают как раньше, пока работает прокладка ([FR-CH-3003](../01-product/03-migration/srs.md#fr-ch-3003-прокладка-совместимости-каналов));
5. бюджеты производительности не нарушены относительно **измеренной** базы ([FR-CH-3007](../01-product/03-migration/srs.md#fr-ch-3007-бюджеты-производительности), [NFR-CH-1001](../01-product/01-plugin-host/srs.md#nfr-ch-1001-бюджет-запуска)).

## 2. Что можно менять, а что нет

| Допустимо без записи | Допустимо с записью в allowlist | Недопустимо |
|---|---|---|
| Внутреннее устройство, имена модулей и файлов, пути импорта | Переименование «Расширения» в «Расширения Claude Code» ([FR-CH-3008](../01-product/03-migration/srs.md#fr-ch-3008-переименование-окна-расширения)) | Менять утверждения существующих тестов |
| Порядок активации плагинов, если результат тот же | Нативные `alert` / `confirm` (10 вызовов в `app.ts` и `config-editor.ts`) заменяются асинхронным слоем диалогов: синхронная семантика теряется ([FR-CH-2006](../01-product/02-extension-contracts/srs.md#fr-ch-2006-слой-диалогов)) | Терять данные пользователя или менять формат без миграции ([FR-CH-3006](../01-product/03-migration/srs.md#fr-ch-3006-сохранность-данных-пользователя-при-переносе)) |
| Способ проверки в `smoke.mjs` и `static-guards.test.ts` при тех же утверждениях | Изменение порядка вызовов, не видимое пользователю, с объяснением | Убирать пункт меню, сочетание, кнопку, канал IPC, настройку до снятия прокладки |

**Формат данных меняется один раз.** Прежняя формулировка «формат файлов пользователя не меняется» снята: SAD2, 3.10 переводит `{projects, lastProjectId, commands}`, файлы пользователя и ключи `localStorage` в `config` и `state` плагинов одной миграцией ([ADR-CH-0014](../03-architecture/adr/ADR-CH-0014-secrets-config-state.md)). Недопустима потеря и неэквивалентность, а не сам перенос. До миграции прежний `ProjectStore` обязан сохранять неизвестные поля ([шаг 0, FR-CH-3010](../01-product/03-migration/srs.md#fr-ch-3010-шаг-0-подготовка-на-текущем-коде)), иначе откат стирает данные нового формата.

### 2.1. Поведение, которого нет в основном корпусе

Для него нет эталона «как раньше», поэтому оно проверяется собственными тестами, а не паритетом, и в паритетную матрицу не входит:

| Что | Требование | Почему нет эталона |
|---|---|---|
| Безопасный режим: выключает все плагины | [FR-CH-1009](../01-product/01-plugin-host/srs.md#fr-ch-1009-безопасный-режим) | в корпусе и коде отсутствует |
| Раздел «Плагины Cyborg», журнал плагинов, `--dump-plugins` | [FR-CH-1010](../01-product/01-plugin-host/srs.md#fr-ch-1010-раздел-плагины-cyborg-и-журнал) | новая функция |
| Буфер вывода pty, `list` и `attach`, повторный `resize` | [FR-CH-1021](../01-product/01-plugin-host/srs.md#fr-ch-1021-pty-хост-ядра-persist-list-attach-буфер-resize), [FR-CH-1022](../01-product/01-plugin-host/srs.md#fr-ch-1022-завершение-pty-сирота-выключение-плагина-закрытие) | в коде буфера нет, вкладки и вывод живут только в окне ([ресёрч-2, 5.2](../research/sad2-validation.md#52-допущения-sad2-которые-код-нарушает), п. 1) |
| Восстановление сессий после перезапуска приложения | [FR-CH-3014](../01-product/03-migration/srs.md#fr-ch-3014-восстановление-сессий-условно) | **противоречит non-goal** `docs/01-product/brd.md`, FR-1015, FR-2014; без решения владельца (вопрос 15 SAD2) не реализуется |
| Сторож хостов, перезапуск хоста плагина | [FR-CH-1018](../01-product/01-plugin-host/srs.md#fr-ch-1018-сторож-хостов-и-pty-хоста) | прецедента нет ([ресёрч-2, 4.1](../research/sad2-validation.md#41-vs-code)) |

## 3. Механизмы

| № | Механизм | Что ловит | Откуда идея |
|---|---|---|---|
| 1 | **Матрица паритета** (раздел 4): фича, требования, каналы, целевой плагин, проверка, статус | Забытую функцию | bb `row-counts.json`, основной корпус `verification-matrix` |
| 2 | **Существующие тесты** (на 2026-11-05 `npm test`: 925, из них 1 пропущен - 893 в `test/` по `scripts/test.mjs` и 32 в `src/**/*.test.ts`) и дымовой тест | Регрессию поведения | основной корпус |
| 3 | **Записанные сессии и подставные программы** (раздел 5) | Регрессию на уровне интерфейса и событий | bb `provider-parity`, dsh `snapshots/session` |
| 4 | **Allowlist допустимых расхождений**; лишняя запись роняет проверку | Молчаливый дрейф, засорение allowlist | bb `parity-allowlist.json` |
| 5 | **Закреплённые счётчики**: каналы - 58 (51 `ipcMain.handle` и 7 `ipcMain.on`), события главного процесса окну (14), члены `window.cyborg` (61, см. [раздел 8](#8-базовые-метрики-p0)), пункты меню, требования (153), диалоги (6) | Потерянный или лишний элемент | bb `row-counts.json` |
| 6 | **Храповики границ** ([FR-CH-3005](../01-product/03-migration/srs.md#fr-ch-3005-храповики-границ)): ядро не импортирует плагины, плагин - только `@cyborg/contracts` и свои модули; счётчик прямых обращений к `electron`, `node:*`, `fs` не растёт | Обратную связность | bb `check-provider-literal-ratchet`, dsh `check-workspace-constraints` |
| 7 | **Тест прокладки**: перебор всех 58 прежних каналов с эталонными запросами; для `on` - наблюдаемый эффект ([FR-CH-3003](../01-product/03-migration/srs.md#fr-ch-3003-прокладка-совместимости-каналов)) | Нарушение совместимости каналов | - |
| 8 | **Тесты через настоящий загрузчик** и **HMR-safety тест реестров** | Плагин, который в тестах работал, а в приложении нет | dsh постмортем 0001 |
| 9 | **Бюджеты** (раздел 8), включая вывод терминала и горячие пути ([NFR-CH-2003](../01-product/02-extension-contracts/srs.md#nfr-ch-2003-задержка-вызова-через-шлюз), [NFR-CH-2004](../01-product/02-extension-contracts/srs.md#nfr-ch-2004-задержка-вывода-терминала)) | Регрессию запуска и отзывчивости | dsh бенчмарки |
| 10 | **Тест миграции данных**: эталонные файлы `e4beb72` -> `config` и `state`, повторный запуск ничего не меняет, секретов в результате нет; откат не стирает поля ([FR-CH-3006](../01-product/03-migration/srs.md#fr-ch-3006-сохранность-данных-пользователя-при-переносе), [NFR-CH-3001](../01-product/03-migration/srs.md#nfr-ch-3001-обратимость-шага)) | Потерю данных пользователя | - |
| 11 | **Тесты дисциплины первого этапа**: `structuredClone`, импорты, доступ к ОС только через `ctx.os` ([FR-CH-1020](../01-product/01-plugin-host/srs.md#fr-ch-1020-дисциплина-первого-этапа-проверяется-тестами)) | Плагин, который невозможно будет изолировать на втором этапе | SAD2, 6.1 |

## 4. Матрица паритета

### 4.1. Функции и целевые плагины

Числа - требования основного корпуса (FR и NFR) на `e4beb72`, всего 153 в 14 фичах (проверено подсчётом заголовков `### FR-` и `### NFR-` в `docs/01-product/NN-*/srs.md`). Если требования фичи делятся между владельцами, перечислены идентификаторы; деление - предложение составителя, его подтверждает скрипт паритета (строка без плагина или проверки блокирует закрытие фазы).

| Фича основного корпуса | Требований | Целевой владелец по SAD2 | Требования пакета | Чем проверяем | Статус |
|---|---|---|---|---|---|
| 01 панель задач, воркспейсы | 37 | `trackers` - 30 (все, кроме перечисленных ниже); ядро - 7: FR-1026, FR-1027, FR-1028, FR-1029, FR-1030, FR-1033 (воркспейс, шлюз путей) и FR-1032 (проверка ввода, размера и завершения сессии - pty-хост и билет) | FR-CH-1014, 1015, 1021, 2011, 2024, 2034, 3011 | `trackers.test.ts`, `task-details.test.ts`, `cli-limits.test.ts`, `workspaces.test.ts`, `stores.test.ts`; сценарии S6, S15, S18 | не начато |
| 02 вид MR и PR | 18 | `trackers` | FR-CH-2011, 2032, 2035 | `mrs.test.ts`, `flow.test.ts`; сценарий S7 | не начато |
| 03 путь в промпт | 5 | `files` - FR-3001 (строка дерева как источник MIME); `sessions` - FR-3002, FR-3003, FR-3005 (бросок на терминал, кавычки, зоны); ядро - FR-3004 (путь файла ОС, `webUtils.getPathForFile` синхронный: перехват drop в оболочке, [вопрос 11 SAD2](../03-architecture/design/sad2.md#8-открытые-вопросы)). Отдельного плагина `path-drop` нет | FR-CH-2017 | `drop-path.test.ts`; сценарий S13 | не начато |
| 04 дерево файлов сессии | 8 | `files` (корни дерева - из `cyborg.projects` и cwd живых сессий `cyborg.sessions`) | FR-CH-2007, 2017 | `tree.test.ts`, `tree-keys.test.ts`, `allowed-paths.test.ts`; сценарий S2 | не начато |
| 05 macOS | 9 | ядро - FR-5001, FR-5002, FR-5004, FR-5006 (запуск, клавиши системы, умолчания, меню и закрытие окна); `agent-claude-code` - FR-5003, FR-5008 (журнал событий, история worktree); `projects` - FR-5007 (физические пути репозиториев); вне кода (CI) - FR-5005, FR-5009 | FR-CH-2028, 2030, 3007 | `platform.test.ts`, `menu.test.ts`, `history.test.ts`, `stores.test.ts`; проверка сквозная | не начато |
| 06 README и сайт | 3 | вне кода приложения | - | не переносится | не переносится |
| 07 смена ветки | 5 | `git` - FR-7001..7004 (список, `git switch`, отказ при сессии, отказ при конфиге с командами); `files` - FR-7005 (меню выбора репозитория и ветки). Отказ FR-7003 использует `cyborg.sessions` ([4.6](#46-что-в-матрице-остаётся-открытым), п. 4) | FR-CH-3016 | `git-branch.test.ts`; сценарий S12 | не начато |
| 08 история сессий | 4 | `agent-claude-code` (вид «Сессии»; продолжение - через `sessions`) | FR-CH-2010 | `history.test.ts`; сценарий S5 | не начато |
| 09 изоляция сессий | 3 | `sessions` - FR-9001, FR-9003 (источник фрагмента промпта); `agent-claude-code` - FR-9002 (порядок аргументов запуска). Отдельного плагина `session-isolation` нет; владелец источника фрагмента SAD2 не называет ([4.6](#46-что-в-матрице-остаётся-открытым), п. 6) | FR-CH-2032 | `session-args.test.ts`, `sessions.test.ts`: байт-в-байт тот же промпт и порядок аргументов | не начато |
| 10 настройки окна, вкладки, доступность, уведомления, ссылки в выводе | 13 | ядро - FR-10001, FR-10002, FR-10005, FR-10007..10011, FR-10013 (шрифт и тема, состояние, заголовок, меню «Воркспейс», группа документов, диалоги, проверка пути и адреса в `shell`); `sessions` - FR-10003, FR-10012; `projects` - FR-10004; `session-notifications` - FR-10006 | FR-CH-2006, 2025, 2030, 2031, 2033, 3012 | `font-size.test.ts`, `prefs.test.ts`, `title.test.ts`, `tabs.test.ts`, `neighbor.test.ts`, `term-links.test.ts`, `notify.test.ts`, `menu.test.ts`; сценарии S3, S15 | не начато |
| 11 «Статус» | 12 | `trackers` (карточка «Статус» и Jira - вид того же плагина, [4.4](#44-граница-trackers)) | FR-CH-2011, 2035 | `status-model.test.ts`, `jira.test.ts`; сценарий S8 | не начато |
| 12 кнопки-команды | 10 | `command-buttons`; сочетания - `ctx.keys.register` ядра | FR-CH-2004, 2029, 2032, 2026, 3012 | `commands.test.ts`, `commands-store.test.ts`, `command-values.test.ts`, `prompts.test.ts`, `suggestions.test.ts`; сценарии S4, S14; регрессия D-27 | не начато |
| 13 поиск | 9 | `search` | FR-CH-2016, 2031 | `search-model.test.ts`, `git-search.test.ts`, `file-list.test.ts`; сценарий S9 | не начато |
| 14 расширения Claude Code | 17 | `claude-extensions` | FR-CH-3008, 2031 | `extensions*.test.ts`, `hubs.test.ts`; сценарии S10, S11 | не начато |
| **Итого** | **153** | | | | |

Владелец `viewer` не получает собственных требований основного корпуса: отдельного FR на просмотр файла в нём нет (Monaco упомянут в FR-12006 и FR-12010 как редактор кнопок и промптов). Его паритет проверяется через `fs:read`, `git:headContent` и сценарии S12, S14.

**Сводка по владельцам.** Скрипт паритета проверяет эти числа вместе с таблицей.

| Владелец | Требований | | Владелец | Требований |
|---|---|---|---|---|
| `trackers` | 60 | | `claude-extensions` | 17 |
| ядро | 21 | | `command-buttons` | 10 |
| `files` | 10 | | `search` | 9 |
| `sessions` | 7 | | `git` | 4 |
| `agent-claude-code` | 7 | | `projects` | 2 |
| вне кода приложения (CI, README и сайт) | 5 | | `session-notifications` | 1 |
| `viewer` | 0 | | **Итого** | **153** |

### 4.2. Каналы IPC и целевые владельцы

Всего **58 каналов: 51 `ipcMain.handle` и 7 `ipcMain.on`** (все в `src/main/main.ts`; `ipcMain` в других файлах не используется). Прежняя версия плана считала все 58 как `handle`. `on` - вызовы без ответа: `session:input`, `session:resize`, `session:kill`, `session:notify`, `session:unnotify`, `notifications:state`, `project:selected`. Каждый канал проверен по `main.ts` и `preload.ts`: 58 вызовов `ipcRenderer.invoke` и `ipcRenderer.send` в `preload.ts` соответствуют 58 обработчикам. Колонка «Чем проверяем» - всегда тест прокладки (механизм 7) плюс названное; `S*` - сценарии [раздела 5](#5-записанные-сессии-и-подставные-программы).

Где выбор не очевиден, он назван предложением; остальное следует таблице каналов из [ресёрча-2, 5.3](../research/sad2-validation.md#53-каналы-ipc-и-владелец-в-модели-sad2).

| Канал | Тип | Владелец | Что меняется при переносе | Чем проверяем |
|---|---|---|---|---|
| `dialog:pickWorkspaceDir` | handle | ядро: воркспейс | диалог через `ctx.os.dialog` ядра | `workspaces.test.ts`; S15 |
| `workspace:info` | handle | ядро: воркспейс | отдаёт `home`, `sep`, имя и файл воркспейса; платформа - забота ядра | `workspaces.test.ts`; smoke |
| `workspace:create` | handle | ядро: воркспейс | один конфиг - один инстанс, замок `<файл>.lock`; защита `offeredWorkspace` (открывается только предложенное ядром) сохраняется | `workspaces.test.ts`; S15 |
| `workspace:open` | handle | ядро: воркспейс | то же; повторное открытие занятого воркспейса передаёт фокус окну владельца и завершается ([FR-CH-1014](../01-product/01-plugin-host/srs.md#fr-ch-1014-воркспейс-один-конфиг---один-инстанс)); меняет FR-1029, FR-1033 | `workspaces.test.ts`; S15 |
| `path:open` | handle | ядро: `shell` | право `shell` с областями путей; `openablePath` пускает любой существующий неисполняемый путь, одной области `workspace` не хватит ([4.6](#46-что-в-матрице-остаётся-открытым), п. 9); вызывает `sessions` (ссылки в выводе, FR-10012) | `term-links.test.ts`; S1 |
| `url:open` | handle | ядро: `shell` | схемы URL в праве `shell` (сегодня только http и https) | `term-links.test.ts`; S1 |
| `session:input` | on | ядро: pty-хост | прямой путь по билету `pty.share()` ([FR-CH-2024](../01-product/02-extension-contracts/srs.md#fr-ch-2024-билет-ptyshare-и-прямой-путь-вывода-терминала)); проверка аргументов FR-1032 (предел 1 МиБ) переезжает в мост | `session-args.test.ts`; S1, S17 |
| `session:resize` | on | ядро: pty-хост | то же; размер 1..1000; после `attach` ядро шлёт `resize` сам | `session-args.test.ts`; S1, S17 |
| `dialog:pickDir` | handle | `projects` | через `ctx.os.dialog` и `ctx.security.setRoots`: каталог сразу доступен `files` и `git` до сохранения проекта ([FR-CH-2034](../01-product/02-extension-contracts/srs.md#fr-ch-2034-каталог-выбранный-в-диалоге)); сегодня `AllowedPaths.grant` | `allowed-paths.test.ts`; smoke |
| `projects:load` | handle | `projects` | раздел `settings.projects` и `state` | `stores.test.ts`; S18 |
| `projects:problem` | handle | `projects` (раздел) и ядро (копия файла) | раздел не прошёл схему - отказ только `projects`; копия `<файл>.corrupt-<время>` в SAD2 не описана ([4.6](#46-что-в-матрице-остаётся-открытым), п. 8) | `stores.test.ts`, `workspaces.test.ts` |
| `projects:save` | handle | `projects` | `saveProjectsState` проверяет и секцию трекеров (`validateProjectsState` из `trackers.ts`) и вызывает `trackers.resetAuth()`: после переноса - `cyborg.project-settings` (`validate`, `save`) и `projects.onChange` | `stores.test.ts`; S18 |
| `project:selected` | on | `projects` (состояние) + меню ядра | канал уходит: пункты «Свойства проекта», «Поиск», «Расширения» - вклады в меню с `enabled` из `cyborg.projects.active()` ([FR-CH-2031](../01-product/02-extension-contracts/srs.md#fr-ch-2031-вклады-плагинов-в-меню)) | `menu.test.ts` |
| `session:create` | handle | `sessions` | проверка каталогов через `cyborg.projects`; промпт запуска из фрагментов ([FR-CH-2032](../01-product/02-extension-contracts/srs.md#fr-ch-2032-вклады-в-промпт-запуска-агента)); возвращает устойчивый id (шаг 0) | `sessions.test.ts`; S1, S6, S7 |
| `session:resume` | handle | `sessions` (вызов) и `agent-claude-code` (`resume`) | проверка журнала сессии - в агенте | `sessions.test.ts`, `history.test.ts`; S5 |
| `session:kill` | on | `sessions` | `pty.kill()` у владельца процесса; сам процесс держит pty-хост | `session-args.test.ts`; S1 |
| `history:list` | handle | `agent-claude-code` | нужен `projectId` -> репозитории (`cyborg.projects`, `optional`) | `history.test.ts`; S5 |
| `history:delete` | handle | `agent-claude-code` | **запись** `fs.write` в `~/.claude/projects` (не чтение) | `history.test.ts`; S5 |
| `session:notify` | on | `session-notifications` | право `notify`; клик по уведомлению - `ctx.window.focus()` и событие клика ([FR-CH-2033](../01-product/02-extension-contracts/srs.md#fr-ch-2033-заголовок-и-фокус-окна-буфер-обмена)) | `notify-args.test.ts`, `notify.test.ts`; S3 |
| `session:unnotify` | on | `session-notifications` | то же | `notify.test.ts`; S3 |
| `notifications:state` | on | `session-notifications` | выключатель хранит плагин; пункт меню - вклад с `checked` из состояния плагина | `notify.test.ts`, `menu.test.ts`; S3 |
| `trackers:status` | handle | `trackers` | результат проверки входа - один, прогретый (FR-1019) | `trackers.test.ts` |
| `tasks:list` | handle | `trackers` | список выборки; `tracked` - привязки сессий из памяти | `trackers.test.ts`, `cli-limits.test.ts`; S6 |
| `tasks:details` | handle | `trackers` | описание только по задаче текущей выборки (FR-1024) | `task-details.test.ts` |
| `tasks:sessionDetails` | handle | `trackers` | то же для задачи сессии | `task-details.test.ts` |
| `tasks:open` | handle | `trackers` | `shell.openExternal` -> право `shell` на схемы URL | `trackers.test.ts`; S6 |
| `jira:status` | handle | `trackers` | `jira-cli` через `process` | `jira.test.ts`; S8 |
| `jira:list` | handle | `trackers` | то же | `jira.test.ts`; S8 |
| `jira:projects` | handle | `trackers` | то же | `jira.test.ts` |
| `jira:suggest` | handle | `trackers` | ходит в git за ветками: `cyborg.git` (`branches`) | `jira.test.ts` |
| `jira:details` | handle | `trackers` | то же | `jira.test.ts`; S8 |
| `jira:open` | handle | `trackers` | `shell.openExternal` | `jira.test.ts` |
| `mrs:list` | handle | `trackers` | выборка MR/PR; пул запросов и бюджет (NFR-2001, NFR-2002) | `mrs.test.ts`; S7 |
| `mrs:open` | handle | `trackers` | `shell.openExternal` | `mrs.test.ts` |
| `mrs:details` | handle | `trackers` | пределы деталей MR | `mrs.test.ts`; S7 |
| `git:root` | handle | `git` | `cyborg.git.root`; право `process` на `git` | `git.test.ts`, `allowed-paths.test.ts` |
| `git:branch` | handle | `git` | `cyborg.git.branch`; нужен ещё `command-buttons` (`{branch}`, `{pr}`) | `git.test.ts`; S14 |
| `git:status` | handle | `git` | `cyborg.git.status`; опрос раз в 3 с (три процесса `git` за раз) - горячий путь ([9.5](#95-тугие-узлы)) | `git.test.ts`; S2 |
| `git:branches` | handle | `git` | `cyborg.git.branches`; сегодня только для репозиториев сохранённых проектов (`projectRepo`) | `git-branch.test.ts`; S12 |
| `git:switch` | handle | `git` | `cyborg.git.switch`; отказ, когда репозиторий занят сессией (`sessions.uses`), - связь с `cyborg.sessions` ([4.6](#46-что-в-матрице-остаётся-открытым), п. 4) | `git-branch.test.ts`; S12 |
| `git:headContent` | handle | `git` | `cyborg.git.headContent`; нужен `viewer` для diff, у которого права на процессы нет | `git-head.test.ts`, `git-filters.test.ts` |
| `fs:list` | handle | `files` | `fs.read` и `fs.watch` в области `workspace`; последовательные вызовы на каждый раскрытый каталог - горячий путь | `allowed-paths.test.ts`, `tree.test.ts`; S2 |
| `fs:read` | handle | `viewer` | `fs.read` в `workspace`; проверка пути строковая, ссылки не раскрываются, правило SAD2 строже (`realpath`) | `allowed-paths.test.ts`; S12 |
| `fs:files` | handle | `search` | список файлов корня (`git ls-files` либо обход) для окна поиска, FR-13005; **в `cyborg.git` SAD2 такого члена нет** ([4.6](#46-что-в-матрице-остаётся-открытым), п. 3) | `file-list.test.ts`; S9 |
| `search:text` | handle | `search` | `git grep` под `AbortController`: отмена - часть протокола вызова ([FR-CH-2016](../01-product/02-extension-contracts/srs.md#fr-ch-2016-отмена-запросов)) | `git-search.test.ts`, `search-model.test.ts`; S9 |
| `search:changes` | handle | `search` | то же, поиск по изменениям | `git-search.test.ts`; S9 |
| `commands:load` | handle | `command-buttons` | общий набор - файл пользователя, набор воркспейса - раздел `config` воркспейса | `commands-store.test.ts`; S14, S18 |
| `commands:save` | handle | `command-buttons` | проверку набора ведёт владелец; редактор открывает `viewer.editJson` с проверкой владельца ([4.6](#46-что-в-матрице-остаётся-открытым), п. 7) | `commands.test.ts`; S14 |
| `prompts:load` | handle | `command-buttons` | файл `prompts.json`; читают ещё `session:create` и трекеры ([4.6](#46-что-в-матрице-остаётся-открытым), п. 5) | `prompts.test.ts` |
| `prompts:save` | handle | `command-buttons` | то же | `prompts.test.ts` |
| `config:reveal` | handle | `command-buttons` | вид `commands` открывает **файл воркспейса** - защищённый путь ядра ([3.7 SAD2](../03-architecture/design/sad2.md#37-безопасность-данных-и-контроль-плагинов)); нужна команда ядра ([4.6](#46-что-в-матрице-остаётся-открытым), п. 10) | `commands-store.test.ts` |
| `extensions:load` | handle | `claude-extensions` | читает `~/.claude/*` и `.mcp.json` репозиториев; права описываются при переносе | `extensions.test.ts`, `extensions-read.test.ts`; S10 |
| `extensions:probe` | handle | `claude-extensions` | запуск `claude` через `$SHELL -lc`; проверка связи MCP только по кнопке | `extensions.test.ts`; S10 |
| `extensions:act` | handle | `claude-extensions` | установка и удаление плагина, магазины; одно действие за раз | `extensions-act.test.ts`; S10 |
| `extensions:usage` | handle | `claude-extensions` | статистика по журналам сессий; кэш `extensions-usage.json` | `extensions-usage.test.ts` |
| `hubs:list` | handle | `claude-extensions` | `hubs.json` в разделе плагина | `hubs.test.ts`; S11 |
| `hubs:change` | handle | `claude-extensions` | то же | `hubs.test.ts`; S11 |
| `hubs:fetch` | handle | `claude-extensions` | https к хабам: право `net` | `hubs.test.ts`; S11 |

**Итого по владельцам: 58.**

| Владелец | Каналов | Из них `on` |
|---|---|---|
| `trackers` | 14 (`trackers:status`, `tasks:*` - 4, `jira:*` - 6, `mrs:*` - 3) | 0 |
| `claude-extensions` | 7 | 0 |
| `git` | 6 | 0 |
| ядро: воркспейс | 4 | 0 |
| `projects` | 5 | 1 (`project:selected`) |
| `command-buttons` | 5 | 0 |
| ядро: `shell` | 2 | 0 |
| ядро: pty-хост | 2 | 2 |
| `sessions` | 3 | 1 (`session:kill`) |
| `session-notifications` | 3 | 3 |
| `search` | 3 | 0 |
| `agent-claude-code` | 2 | 0 |
| `files` | 1 | 0 |
| `viewer` | 1 | 0 |
| **Итого** | **58** | **7** |

Скрипт паритета ([FR-CH-3001](../01-product/03-migration/srs.md#fr-ch-3001-матрица-паритета)) строит список каналов из `ipcMain.handle(` и `ipcMain.on(` в `main.ts` и сверяет его с этой таблицей: лишний или пропущенный канал роняет проверку. Прежнее деление «`projects:*` - ядро», «`session:*` - ядро и плагины», «`tasks`, `jira`, `mrs` - пять плагинов», «`git` и `fs` - `files` и `search` над сервисом git ядра» заменено таблицей выше.

### 4.3. События главного процесса окну

14 событий (все через `webContents.send`; в окне подписка `api.on(...)`). Каждое имеет целевое событие или вклад, как требовал [SAD, раздел 8](../03-architecture/design/sad.md#8-события); после [ADR-CH-0010](../03-architecture/adr/ADR-CH-0010-contracts-instead-of-services.md) общей шины нет, событие - часть контракта владельца.

| Событие | Владелец | Целевое место | Чем проверяем |
|---|---|---|---|
| `session:data` | ядро: pty-хост | вывод идёт из pty-хоста в `<iframe>` `sessions` по `MessagePort` ([FR-CH-2024](../01-product/02-extension-contracts/srs.md#fr-ch-2024-билет-ptyshare-и-прямой-путь-вывода-терминала)); без пакетирования по чанкам, как сегодня, - нельзя | нагрузочный сценарий вывода ([9.1](#91-горячие-пути-pty)); S1 |
| `session:exit` | `sessions` | `sessions.onChange` (выход) | `sessions.test.ts`; S1 |
| `session:cwd` | `sessions` (источник - хук агента) | `sessions.onChange` (смена каталога); дерево идёт за сессией | S2 |
| `session:activity` | `sessions` (источник - хук агента) | `sessions.onChange` (активность) | S1 |
| `session:waiting` | `sessions` | `sessions.onChange` (ожидание); потребитель - `session-notifications` | S3 |
| `session:suggest` | `command-buttons` | разбор последнего сообщения (`parseSuggestions`) по событию конца хода `sessions` ([FR-CH-2003](../01-product/02-extension-contracts/srs.md#fr-ch-2003-события-сессий-в-контракте-cyborgsessions)) | `suggestions.test.ts`; S4 |
| `session:reveal` | `session-notifications` | клик по уведомлению -> `ctx.window.focus()` и команда `sessions.reveal` | S3 |
| `notifications:toggle` | `session-notifications` | пункт меню с `checked` из состояния плагина | `menu.test.ts` |
| `menu:create-workspace` | ядро: воркспейс | меню «Воркспейс» | `menu.test.ts`; S15 |
| `menu:project` (`new` / `edit`) | `projects` | команды `projects.new`, `projects.edit` по вкладу в меню | `menu.test.ts` |
| `menu:commands` | `command-buttons` | вклад в меню | `menu.test.ts` |
| `menu:prompts` | `command-buttons` | вклад в меню | `menu.test.ts` |
| `menu:search` (режим) | `search` | вклад в меню и сочетание | `menu.test.ts`; S9 |
| `menu:extensions` (вкладка) | `claude-extensions` | вклад в меню и сочетание | `menu.test.ts`; S10 |

### 4.4. Граница `trackers`

**Открытый вопрос.** SAD2 называет плагин `trackers` (разделы 5, 5.2: поставщик `cyborg.project-settings`), но не фиксирует, один это плагин или несколько; [FR-CH-2011](../01-product/02-extension-contracts/srs.md#fr-ch-2011-плагин-trackers) прямо оставляет разбиение и контракт провайдера трекера на P1. Прежняя версия плана держала шесть плагинов (`tasks`, `merge-requests`, `status`, `tracker-github`, `tracker-gitlab`, `tracker-jira`); этого деления в SAD2 нет, и оно снято.

**Что в коде.** 14 каналов (`trackers:status`, `tasks:*`, `jira:*`, `mrs:*`), модули `trackers.ts`, `mrs.ts`, `mrs-service.ts`, `jira.ts`, `jira-service.ts`, `task-details.ts` и три вида окна - «Задачи», «MR/PR», «Статус» (60 из 153 требований корпуса, фичи 01, 02, 11).

**Рабочее предложение: один плагин `trackers` с тремя видами.**

1. `MrsService` построен поверх `TrackersService` (общая проверка входа, один результат на все выборки, определение источника по remote, пределы вызовов `gh` и `glab`: FR-1019, NFR-1003, NFR-2001); `JiraService` делит с ними запуск CLI и шаблоны промптов. Разрезать это значило бы сначала выпустить контракт провайдера трекера.
2. Карточка «Статус» (FR-11005, FR-11007) собирает задачи Jira, MR/PR и их связь. При разбиении она оказалась бы составным экраном из карточек разных плагинов, а такой случай «задача, а не виджет» ([SAD2, 3.8](../03-architecture/design/sad2.md#38-изоляция-рендера) и риск в разделе 9) прямо не покрывает.
3. Один раздел `settings.trackers.byProject` и одна секция `cyborg.project-settings` для GitHub, GitLab и Jira (FR-1009, FR-1010, FR-11001, FR-11012); `projects:save` уже сегодня сбрасывает вход в трекеры.
4. Привязка задачи и MR к сессии, живущая только в памяти (FR-1015, FR-2014), остаётся одна.
5. Согласуется с [OVERVIEW, раздел 4](../OVERVIEW.md#4-что-в-ядре-а-что-в-плагинах) и [FR-CH-2011](../01-product/02-extension-contracts/srs.md#fr-ch-2011-плагин-trackers).

Права `trackers` по коду: `process` на `gh`, `glab`, `jira` (широкий класс, [FR-CH-2035](../01-product/02-extension-contracts/srs.md#fr-ch-2035-два-класса-плагинов)); `shell` на схемы URL для `*:open`; запросы ветки и remote - через `cyborg.git`; токенов плагин не хранит (NFR-1001).

**Когда пересматривать.** После паритета. Если появится сторонний трекер или Jira уйдёт на HTTP API (узкий класс, новое требование, не перенос), из `trackers` выделяется провайдер за контрактом, который тогда придётся спроектировать; до этого он не нужен. Разбиение внутри плагина - модули `tasks`, `mrs`, `status`, `jira`, храповик ([FR-CH-3005](../01-product/03-migration/srs.md#fr-ch-3005-храповики-границ)) не пускает их в зависимость друг от друга снаружи.

### 4.5. Данные на диске и владельцы

Назначения файлов, которых SAD2 не называет, - предложение [ресёрча-2, 5.4](../research/sad2-validation.md#54-что-на-диске); тест миграции (механизм 10) проверяет каждый.

| Данные | Кто пишет сегодня | Целевой владелец и место | Требование |
|---|---|---|---|
| Файл воркспейса: `projects`, `lastProjectId`, `commands` | `ProjectStore` (`projects.ts`), `saveCommands`, `createWorkspaceFile` | `projects` -> `settings.projects`; `trackers` и `jira` -> `settings.trackers.byProject`; `commands` -> раздел `command-buttons`; `lastProjectId` -> `state` | FR-CH-3011 |
| `<файл>.lock` | воркспейс | ядро | FR-CH-1014 |
| `<файл>.corrupt-<время>` | `keepCopy` | SAD2 не описывает; поведение сохраняется до решения | FR-CH-3011 |
| `userData/recent-workspaces.json` | все экземпляры, без блокировки | «Недавние» ядра | FR-CH-3012 |
| `userData/projects.json`, `trackers.json` | прежний путь (`trackers.json` только читается) | `projects`, `trackers`; старый `projects.json` по-прежнему открывается как воркспейс | FR-CH-3006 |
| `userData/commands.json` | `CommandStore` | `command-buttons`, файл пользователя | FR-CH-3012 |
| `userData/prompts.json` | `PromptStore` | `command-buttons`; потребители - `sessions` и `trackers` ([4.6](#46-что-в-матрице-остаётся-открытым), п. 5) | FR-CH-3012 |
| `userData/hubs.json` | `HubStore` | `claude-extensions` | FR-CH-3012 |
| `userData/extensions-usage.json` | `UsageStore` | `claude-extensions`: `state` или `plugin-data` | FR-CH-3012 |
| `userData/claude-hooks.json` | каждый экземпляр при старте | `agent-claude-code`, `plugin-data` | FR-CH-3012 |
| `userData/sessions/<pid>-<id>.jsonl` | `claude` по хуку | `agent-claude-code`, `plugin-data`; имя от устойчивого id сессии, без pid | FR-CH-2010, FR-CH-3010 |
| `userData/workspaces/<хеш>/` (сессия Chromium, `localStorage`, ключи `cyborg.*`) | окно | `state` плагинов-владельцев; у `<iframe>` другой origin, ключи иначе теряются | FR-CH-3012 |

Ключи `localStorage` на `e4beb72` - 10 постоянных (`cyborg.fontSize`, `cyborg.notifications`, `cyborg.tasks.assigned`, `cyborg.tasks.sort`, `cyborg.mrs.filter`, `cyborg.mrs.sort`, `cyborg.search.mode`, `cyborg.extensions.tab`, `cyborg.extensions.view`, `cyborg.extensions.size`) и три семейства с вычисляемым ключом (`cyborg.extensions.${key}`, `cyborg.search.${key}`, `cyborg.tasks.labels:${id}`). Закрытый список ключей хранилища окна зафиксирован `static-guards.test.ts`; он переписывается вместе с переносом без потери утверждений.

### 4.6. Что в матрице остаётся открытым

Расхождения между SAD2, SRS и кодом, найденные при составлении матрицы. Этот документ их не решает: решение за P0 и P1 ([дорожная карта](../05-plans/roadmap.md)). Пункты 1, 2, 3 и 5 решены правилом 11 [SAD2, раздел 4](../03-architecture/design/sad2.md#4-взаимодействие-плагинов) («контракт вклада объявляет владелец сущности или вида»), пункт 6 - наполовину; ниже под каждым - чем.

1. ~~**Привязка задачи и MR к сессии.**~~ Решено: метки сессии в `cyborg.sessions` с ключом по плагину, только в памяти; пишет `trackers`, читает `command-buttons` ([SAD2, 5.5](../03-architecture/design/sad2.md#55-пробелы-паритета-найденные-сверкой-с-кодом)). Исходная запись: В коде это поля объекта сессии в окне (`s.task`, `s.mr`, `s.jira`): от них зависят заголовок сессии (FR-1014, FR-2013), возврат к строке панели (FR-1031) и подстановки `{task}`, `{pr}` (FR-12003). Контракта `cyborg.sessions` с такими данными ни SAD2, ни FR-CH-2003 не описывают. Нужен член «привязка», который задаёт создатель сессии; хранится только в памяти (FR-1015, FR-2014, `static-guards.test.ts`).
2. ~~**Кнопки-команды под терминалом.**~~ Решено: полосу под терминалом объявляет и рисует `sessions` как владелец вида, `command-buttons` - вкладчик. Исходная запись: FR-12001 и FR-12008: полоса кнопок живёт под терминалом сессии. [FR-CH-2005](../01-product/02-extension-contracts/srs.md#fr-ch-2005-роды-областей-и-виды) снимает слот `terminal.footer`, а на панель инструментов основной области переносит только кнопки «Статус», «Задачи», «MR/PR», «Новая сессия». Как `command-buttons` оказывается под терминалом чужого `<iframe>` при правиле «чужой UI не встраивается», не описано.
3. ~~**Состав `cyborg.git`.**~~ Решено: общий ресурс держит плагин-владелец `git`; в `cyborg.git` добавлены `remotes` и `files`, отметки в дерево (`cyborg.tree-decoration`) поставляет тот же `git`. Исходная запись: SAD2, 5.5 называет шесть членов: `root`, `branch`, `status`, `headContent`, `branches`, `switch`. Код требует ещё `gitRemotes` (определение источника задач, `trackers`) и `gitFiles` (`git ls-files` для `fs:files`, `search`). `gitGrep` и `gitDiffSearch` у `search` сегодня вызывают `git` сами, а SAD2 называет `search` потребителем `cyborg.git`. Кроме того, SAD2, 5 рисует поставщика `git-status` для `cyborg.tree-decoration`, а в 5.5 - плагин `git`; кто поставляет отметки git в дерево, не сказано.
4. **`git:switch` и сессии.** Сегодня отказ идёт от `sessions.uses(root)`, плюс проверка `projectRepo`. Если `git` потребует `cyborg.sessions`, граф получит зависимость `git` -> `sessions`, а `files` -> `sessions` уже есть. Предложение: проверку ведёт `files` перед вызовом, но тогда другой потребитель `cyborg.git.switch` её обойдёт. Решение за P1.
5. ~~**Промпты и цикл.**~~ Решено: шаблоны стартов остаются у `trackers`; `{task}` и `{pr}` `command-buttons` читает из меток сессии, а не из `trackers`, поэтому цикла нет. Исходная запись: SAD2, 5.5 отдаёт `prompts.json` плагину `command-buttons`, а все пять шаблонов (`mr.review`, `mr.rework`, `mr.ci`, `task.start`, `jira.start`) относятся к стартам из трекеров, и читают их `session:create` и `trackers`. С другой стороны `{pr}` и `{task}` кнопок берутся из `trackers` (`api.listMrs`, `pickPr`). Пара `command-buttons` <-> `trackers` образует цикл, а граф с циклом не загружается (FR-CH-1004). Варианты: шаблоны остаются у `trackers`; или шаблоны отдаёт контракт `command-buttons`, а `{pr}` и `{task}` разрешает команда без зависимости.
6. **Источник фрагмента изоляции.** Наполовину решено: контракт фрагментов промпта объявляет `sessions`, `trackers` - поставщик; владелец инструкции изоляции (FR-9001) не назван. Исходная запись: FR-9001 (инструкция изоляции в каждой сессии) и инструкция предложений кнопок (`SUGGEST_PROMPT`, FR-12007) идут в `--append-system-prompt` через `claude-args.ts`. Контракт-источник фрагментов (FR-CH-2032) в SAD2 без формы и без названного владельца изоляции; прежний плагин `session-isolation` в SAD2 отсутствует. Предложение: `sessions` отдаёт фрагмент изоляции, `command-buttons` - инструкцию кнопок, порядок аргументов (FR-9002) - `agent-claude-code`.
7. **`editJson` и проверка владельца.** Сегодняшний редактор кнопок и промптов проверяет сохранение в главном процессе, остаётся открытым при ошибке, показывает замечания и спрашивает при несохранённой правке (`config-editor.ts`); эскиз `editJson({title, value, schema})` этого не несёт ([ресёрч-2, 5.1](../research/sad2-validation.md#51-что-в-sad2-и-parity-plan-неверно-или-неточно)). Контракт должен принимать проверку владельца.
8. **Повреждённый файл воркспейса.** FR-1026 требует не терять файл: копия `<файл>.corrupt-<время>` и сообщение. SAD2 говорит только об отказе раздела по схеме. Поведение сохраняется ([FR-CH-3011](../01-product/03-migration/srs.md#fr-ch-3011-перенос-формата-воркспейса)) до отдельного решения; владелец - ядро.
9. **Область для `path:open`.** `openablePath` пускает любой существующий неисполняемый путь (в том числе вне репозиториев: файлы из вывода сессии), а SAD2 строит области `workspace`, `plugin-data`, `granted`. Нужна область или правило для `shell`, иначе FR-10012 и FR-10013 теряются.
10. **`config:reveal` и защищённый путь.** Вид `commands` открывает файл воркспейса целиком, а он по SAD2 - защищённый путь, недоступный плагину. Нужна команда ядра «показать файл воркспейса» либо отказ от пункта с записью в allowlist.
11. **Число методов `window.cyborg`.** Ранние документы пакета говорили о 65 методах; в коде 61 член объекта `api` ([раздел 8](#8-базовые-метрики-p0)). Исправлено во всех документах пакета.
12. **Число тестов.** Ранние документы пакета говорили об 893 тестах с одним пропуском; `npm test` даёт 925 (893 в `test/` и 32 в `src/**/*.test.ts`), пропущен один из 32. Исправлено во всех документах пакета.
13. **«21 из 40 модулей».** В `src/main` 38 модулей без тестов; 21 из них импортируют `node:*`, `electron` или `node-pty`. «40» получается, если добавить два файла `src/shared`, которые таких импортов не имеют.

## 5. Записанные сессии и подставные программы

**Подставные программы.** Уже есть в дымовом тесте (`scripts/smoke.mjs`): `claude`, `gh`, `jira`. Расширяем: `glab`, `claude plugin ...` (магазины, установка, удаление), `git` на фикстурных репозиториях.

**Записанная сессия** - набор файлов в `test/parity/<сценарий>/`:

| Файл | Что |
|---|---|
| `events.jsonl` | События хуков, которые получает приложение (формат `claude-hooks.json` событий) |
| `output.txt` | Вывод pty (как есть) |
| `cli.json` | Ответы подставных `gh`, `glab`, `jira`, `claude plugin` на запросы |
| `expect.json` | Эталон: нормализованные события `session.*`, строки дерева, панелей, меню, состояние видов |
| `manifest.json` | Версия записи, версия Claude Code, на которой снята, описание |

Нормализация идёт на уровне событий контрактов и строк видов, а не DOM окна: после переноса в `<iframe>` обращение к `#tree` или `#session-list` из `document` окна не работает ([9.4](#94-smoke-и-static-guards-завязаны-на-dom-и-списки)).

**Сценарии первой записи** (идентификаторы используются в таблицах выше). S1-S15 - прежний перечень по функциям; S16-S18 добавлены по SAD2.

| № | Сценарий |
|---|---|
| S1 | новая сессия, ввод, вывод, ссылка из вывода |
| S2 | смена cwd на worktree (дерево идёт за сессией) |
| S3 | запрос разрешения и уведомление |
| S4 | конец хода с предложением кнопок |
| S5 | продолжение сессии и удаление из истории |
| S6 | старт по задаче |
| S7 | ревью MR |
| S8 | карточка «Статус» с Jira |
| S9 | поиск файла, текста, изменений |
| S10 | установка и удаление плагина Claude Code |
| S11 | чтение хаба |
| S12 | смена ветки |
| S13 | перетаскивание пути |
| S14 | кнопка-команда с подстановкой |
| S15 | открытие второго воркспейса |
| S16 | перезапуск хоста плагина: сессия продолжается, события после `attach` совпадают с эталоном ([FR-CH-3004](../01-product/03-migration/srs.md#fr-ch-3004-записанные-сессии-и-подставные-программы)) |
| S17 | перезагрузка окна: pty живы, терминал восстанавливается, TUI перерисован (сначала новый эталон, [9.1](#91-горячие-пути-pty)) |
| S18 | миграция: файл `e4beb72` -> `config` и `state`, ключи `localStorage` -> `state` |

**Повтор.** Тест проигрывает запись против текущей сборки и сравнивает нормализованный результат с `expect.json`. Расхождение допустимо только при записи в allowlist (`test/parity/allowlist.json`: сценарий, поле, причина, ссылка на решение). Запись в allowlist, которой не пользуется ни одно расхождение, роняет проверку.

## 6. Чек-лист PR переноса

PR, переносящий функцию в плагин, обязан:

- [ ] перенести код в `src/plugins/<id>`, не меняя утверждений существующих тестов ([FR-CH-3015](../01-product/03-migration/srs.md#fr-ch-3015-перенос-тестов-с-сохранением-утверждений));
- [ ] оставить прежние каналы IPC и методы `window.cyborg` работающими через прокладку;
- [ ] указать плагин-владелец каждого перенесённого канала, события и файла (разделы 4.2, 4.3, 4.5); канал без владельца блокирует PR;
- [ ] объявить права в манифесте по таблице [SAD2, 3.7](../03-architecture/design/sad2.md#37-безопасность-данных-и-контроль-плагинов) и показать их в «Плагины Cyborg»; импортировать только `@cyborg/contracts` и свои модули, к ОС обращаться только через `ctx.os` ([FR-CH-1020](../01-product/01-plugin-host/srs.md#fr-ch-1020-дисциплина-первого-этапа-проверяется-тестами));
- [ ] обновить строку матрицы (статус «перенесено, паритет подтверждён»), счётчики и allowlist, если нужны;
- [ ] приложить прогон: тесты, дымовой тест, паритет, храповики, `check:corpus`;
- [ ] приложить замер бюджета, если функция в пути запуска, открытия окна, вывода терминала, дерева или поиска;
- [ ] описать откат шага ([NFR-CH-3001](../01-product/03-migration/srs.md#nfr-ch-3001-обратимость-шага));
- [ ] данные: формат меняется только миграцией по [FR-CH-3011](../01-product/03-migration/srs.md#fr-ch-3011-перенос-формата-воркспейса) и [FR-CH-3012](../01-product/03-migration/srs.md#fr-ch-3012-перенос-файлов-пользователя-и-localstorage) с тестом на эталонных файлах; новая запись в файлы, не входящие в список писателей, - отдельное решение.

## 7. Условия выхода фаз

Определены в [дорожной карте](../05-plans/roadmap.md): фаза закрывается только при зелёных механизмах 1-11 раздела 3, красной строке в матрице нет, а спайки, от которых зависит фаза, закрыты ([FR-CH-3009](../01-product/03-migration/srs.md#fr-ch-3009-условия-выхода-фазы)).

## 8. Базовые метрики (P0)

Снимаются на `e4beb72` до начала P1 и записываются в таблицу; дальше сравниваются на каждой фазе. Колонка «Значение» - то, что получено сверкой с кодом 2026-11-05; «снять в P0» - замера нет.

| Метрика | Значение сейчас | Как снять |
|---|---|---|
| Требований основного корпуса | 153 | `npm run check:corpus` |
| Тестов | 925, из них 1 пропущен: 893 в `test/` (`scripts/test.mjs`) и 32 в `src/**/*.test.ts` (в ранних документах пакета было 893, исправлено) | `npm test` |
| Каналов IPC главного процесса | 58: 51 `ipcMain.handle` и 7 `ipcMain.on` | `grep -ohE "ipcMain\.(handle\|on)\('[^']+'" src/main/main.ts \| wc -l`; по видам - `grep -c "ipcMain.handle("` и `grep -c "ipcMain.on("` |
| Событий главного процесса окну | 14 | `grep -ohE "send\('[a-z:-]+'" src/main/main.ts` (6 `menu:*`, `notifications:toggle`, `session:reveal`) и `emit('session:` в `sessions.ts` |
| Членов `window.cyborg` | 61: 58 привязаны к каналам, плюс `pathForFile`, `on` и значение `platform` (в ранних документах пакета было 65, исправлено) | подсчёт ключей объекта `api` в `src/main/preload.ts` |
| Диалогов в `index.html` | 6 | `grep -c '<dialog' src/renderer/index.html` |
| Строк `src/main` (без тестов) | 7057 в 38 файлах | см. [cyborg-today](../research/cyborg-today.md) |
| Строк `src/renderer` (TypeScript) | 6828 в 45 файлах; `app.ts` - 1360 | там же |
| Модулей `src/main`, импортирующих `node:*`, `electron` или `node-pty` | 21 из 38 (в ресёрче «21 из 40» - с `src/shared`) | `grep -lE "from '(node:\|electron\|node-pty)" src/main/*.ts` без тестов; стартовое значение храповика ([FR-CH-3005](../01-product/03-migration/srs.md#fr-ch-3005-храповики-границ)) |
| Файлов `src/renderer`, импортирующих `../main/*` | 20 | `grep -lE "from '\.\./main/" src/renderer/*.ts \| wc -l`; выносятся в `@cyborg/contracts` до переноса |
| Время до готового окна | **не измерено**: `scripts/measure.mjs` замеряет только загрузку панели задач и MR через CLI, `smoke.mjs` метрик времени не снимает; расширить, снять в P0 | новый замер в `measure.mjs` и метки времени в дымовом тесте |
| Память приложения (главный процесс и рендерер) | **не измерено**, снять в P0 | `footprint` на macOS, как в [ресёрче-2](../research/sad2-validation.md#1-что-проверяли-и-как) |
| Время открытия окон поиска, «Расширения», панелей задач и MR | снять в P0 | дымовой тест с метками времени |
| Вывод терминала: задержка и пропускная способность на реальной сессии | **не измерено** (в ресёрче замерен только пустой мост: IPC 54 мкс, порт 50 мкс, поток около 2 ГБ/с) | нагрузочный сценарий с подставным `claude` и большим выводом |
| Размер собранных бандлов | снять в P0 | `ls -l dist` |

Предложенные бюджеты (вопрос 9 SAD2): вызов через шлюз не более 1 мс на p99, вывод терминала не более кадра (16 мс). Бюджет запуска и открытия окон - не хуже базового более чем на 10% ([NFR-CH-1001](../01-product/01-plugin-host/srs.md#nfr-ch-1001-бюджет-запуска)); допустимое значение предлагается, пока нет базы, оно не проверяемо.

## 9. Риски паритета, найденные сверкой с кодом

Каждый риск - допущение SAD2, которое код нарушает ([ресёрч-2, 5.2](../research/sad2-validation.md#52-допущения-sad2-которые-код-нарушает)); здесь они проверены повторно и привязаны к проверкам паритета. Риски общего характера - в [OVERVIEW, раздел 8](../OVERVIEW.md#8-риски) и [SAD2, раздел 9](../03-architecture/design/sad2.md#9-риски).

### 9.1. Горячие пути pty

- Вывод идёт `proc.onData` -> `emit('session:data')` -> `webContents.send` на каждый чанк, без пакетирования (`sessions.ts`, `main.ts`); в окне один обработчик пишет в `Terminal.write`.
- Сессия без вкладки копит чанки в `pendingData`, копируя весь массив на каждый чанк (`app.ts`: `[...(pendingData.get(id) ?? []), data]`), то есть квадратично.
- В ядре нет буфера вывода: вкладки, прокрутка и сессии живут только в окне, поэтому перезагрузка страницы убрана из меню (FR-5006).
- Буфер, `list`, `attach` и повторный `resize` - **новое поведение**, а не перенос ([FR-CH-1021](../01-product/01-plugin-host/srs.md#fr-ch-1021-pty-хост-ядра-persist-list-attach-буфер-resize)); эталон «как раньше» для S17 не существует. Хвост сырой может начинаться посреди escape-последовательности; сырой хвост или снимок экрана (headless-xterm) - вопрос 12 SAD2, решает спайк с настоящим `claude`.
- `claude` в pty-хосте, повторный `resize` и перерисовка после `attach` не испытаны ([ресёрч-2, 7](../research/sad2-validation.md#7-что-осталось-непроверенным), п. 3); `node-pty` в `utilityProcess` только загружается.

*Что делаем.* База вывода терминала в [разделе 8](#8-базовые-метрики-p0) до переноса; сценарии S1, S16, S17 в записях; нагрузочный сценарий, который ловит квадратичный `pendingData`; бюджет [NFR-CH-2004](../01-product/02-extension-contracts/srs.md#nfr-ch-2004-задержка-вывода-терминала).

### 9.2. Клавиши и D-27

- Системные сочетания - акселераторы меню (`menu.ts`: `Cmd+P` / `Ctrl+Shift+P`, `CmdOrCtrl+Shift+F`, `CmdOrCtrl+Shift+D`, `CmdOrCtrl+Shift+X`, `CmdOrCtrl+Q`) плюс `window.addEventListener('keydown', ..., true)` в `app.ts`. `before-input-event` в коде не используется.
- **Сочетания, которых нет в меню и которые живут только в слушателе окна:** `Cmd/Ctrl+Shift+N` (новая сессия) и `Cmd/Ctrl+0` (размер шрифта по умолчанию). Слушатель окна не видит нажатий из `<iframe>`; пока перехват в главном процессе при фокусе в кадре не подтверждён, эти два сочетания молчат из терминала. Это потеря функции, а не вопрос улучшения.
- Горячие клавиши кнопок (F1-F4 по умолчанию) условные: не при `repeat`, не в `INPUT` и `TEXTAREA` (кроме поля xterm), не при открытом диалоге, только для видимой сессии. Статические `keybindings` манифеста этого не выражают: нужен `ctx.keys.register` ([FR-CH-2029](../01-product/02-extension-contracts/srs.md#fr-ch-2029-динамические-сочетания-с-условиями)).
- Дефект D-27 подтверждён: `RESERVED_MAC` и `RESERVED_OTHER` в `commands.ts` не содержат `Cmd+P`, `Shift+F/D/X`; кнопка с таким хоткеем не сработает. Список занятых сочетаний ведётся руками.
- Не проверено: `Cmd+Shift+F` и `Ctrl+C` при фокусе в `<iframe>` настоящей клавиатурой; поведение `role: copy/paste` меню Edit во вложенном кадре; xterm `attachCustomKeyEventHandler` (`Alt+Enter`) в кадре.

*Что делаем.* Спайк с настоящей клавиатурой до каркаса (P0); регрессия на пять сочетаний ([FR-CH-2004](../01-product/02-extension-contracts/srs.md#fr-ch-2004-команды-и-статические-сочетания)); `Cmd/Ctrl+Shift+N` и `Cmd/Ctrl+0` вносятся в таблицу сочетаний и в сценарии.

### 9.3. `localStorage`

- 10 постоянных ключей `cyborg.*` и три семейства с вычисляемым ключом ([4.5](#45-данные-на-диске-и-владельцы)) живут в хранилище окна воркспейса (`userData/workspaces/<хеш>/`).
- У `<iframe>` с другим origin (`cyborg-plugin://<группа>/`, [SAD2, 3.8](../03-architecture/design/sad2.md#38-изоляция-рендера)) это хранилище другое: настройки интерфейса пропадут (FR-10002), если не перенести их миграцией ([FR-CH-3012](../01-product/03-migration/srs.md#fr-ch-3012-перенос-файлов-пользователя-и-localstorage)).
- `sandbox` без `allow-same-origin` лишает кадр хранилищ origin совсем; Monaco и xterm под ним не проверены ([ресёрч-2, 7](../research/sad2-validation.md#7-что-осталось-непроверенным), п. 2).

*Что делаем.* Сценарий S18 и тест миграции; окно воркспейса с прежним состоянием после обновления.

### 9.4. `smoke` и `static-guards` завязаны на DOM и списки

- `smoke.mjs` (827 строк) проверяет DOM окна (`#tree`, `#session-list`, `#tree-meta`, заголовок, `localStorage`) через CDP главного документа. После переноса вида в `<iframe>` селекторы нужно искать в нужном кадре.
- `static-guards.test.ts` закрывает: список файлов `src/main`, пишущих на диск (8 файлов); список ключей, которые интерфейс пишет в хранилище окна; запрет `innerHTML` и подобного (FR-1018); `aria-labelledby` у каждого `<dialog>` (FR-10010). Правило «привязка задачи к сессии только в памяти» (FR-1015, FR-2014) вместе с хранением списка сессий в `state` ([FR-CH-3014](../01-product/03-migration/srs.md#fr-ch-3014-восстановление-сессий-условно)) придётся переформулировать: привязка не пишется на диск и теряется при восстановлении.
- Правило паритета «утверждения не меняются» выполнимо только при смене способа проверки ([FR-CH-3015](../01-product/03-migration/srs.md#fr-ch-3015-перенос-тестов-с-сохранением-утверждений)).

*Что делаем.* Утверждения выписываются в таблицу до переноса; число утверждений не уменьшается; невыполнимое - в allowlist с причиной.

### 9.5. Тугие узлы

- **Связность `src/main`.** 21 из 38 модулей импортируют `node:*`, `electron` или `node-pty`; 20 файлов окна импортируют типы и значения из `../main/*`. Правило «плагин импортирует только `@cyborg/contracts`» требует сначала вынести общие типы ([FR-CH-3005](../01-product/03-migration/srs.md#fr-ch-3005-храповики-границ)).
- **`workspaces.ts` -> `projects` и `trackers`** (`validateProjectsState` из `trackers.ts`); `projects:save` -> `trackers.resetAuth()`. В SAD2 эта связь превращается в `cyborg.project-settings` и `projects.onChange`; до переноса `projects` и `trackers` двигать порознь нельзя.
- **`sessions` -> `suggestions` -> `commands`**; **`jira`, `mrs`, `trackers` -> `prompts` -> `commands`**. Разбор предложений кнопок и сборка промптов тянут модуль кнопок в `sessions` и в трекеры; в SAD2 это либо контракт-источник фрагментов, либо цикл ([4.6](#46-что-в-матрице-остаётся-открытым), п. 5).
- **`sessions.ts`** держит и менеджер сессий, и запуск `claude` с хуками (`claude-args`, `events-store`, `suggestions`, `pid`, `node-pty`): разрез на `sessions` и `agent-claude-code` делается одним шагом.
- **`app.ts` (1360 строк)** держит проекты, воркспейс, сессии, терминалы, дерево, историю, меню выбора, клавиши и уведомления; оболочка разрезается не по плагинам, а по мере их переноса.
- **Горячие вызовы через хост.** `listDir` - последовательные вызовы на каждый раскрытый каталог, опрос `git:status` раз в 3 с, поиск отдаёт в окно весь список файлов репозитория и отменяется через `AbortController`. Каждый вызов станет цепочкой окно - хост - шлюз - ОС; бюджет не измерен ([ресёрч-2, 7](../research/sad2-validation.md#7-что-осталось-непроверенным), п. 5).
- **Буфер обмена и диалоги.** `navigator.clipboard` в UI терминала и 10 вызовов `alert` / `confirm`: у UI плагина нет `ctx.os.clipboard`, синхронное подтверждение слой диалогов не даёт ([FR-CH-2006](../01-product/02-extension-contracts/srs.md#fr-ch-2006-слой-диалогов), [FR-CH-2033](../01-product/02-extension-contracts/srs.md#fr-ch-2033-заголовок-и-фокус-окна-буфер-обмена)).
- **Бросок файлов ОС.** `webUtils.getPathForFile` синхронный и нужен в том кадре, куда бросают файл (FR-3004); перехват drop придётся дублировать или вести в оболочке, MIME `application/x-cyborg-path` между кадрами не проверен.
- **Права агента.** `claude` запускается как `$SHELL -lc 'exec claude ...'`; удаление истории - запись, не чтение; хуки пишут файлы в app-data; очищается окружение `CLAUDE*`. Это права `process` (проверка версии), `fs.read` и `fs.write`, `plugin-data`, `env`; `pty` с оболочкой - у `sessions`, которая запускает процесс по описанию `launch` ([FR-CH-2010](../01-product/02-extension-contracts/srs.md#fr-ch-2010-плагин-agent-claude-code)).
- **Трекеры на CLI.** `gh`, `glab`, `jira` через `process`; узкий класс «только `net`» возможен лишь после перехода на HTTP API ([FR-CH-2035](../01-product/02-extension-contracts/srs.md#fr-ch-2035-два-класса-плагинов)).

## 10. Что изменено в этой версии

| Раздел | Было | Стало |
|---|---|---|
| 1, 2 | формат данных не меняется | формат меняется один раз миграцией; недопустима потеря |
| 2.1 | не было | новое поведение без эталона: безопасный режим, буфер pty и `attach`, восстановление сессий (условно), сторож |
| 3 | 9 механизмов, счётчик «58 каналов, 65 методов» (65 - ошибка ранней версии) | 11 механизмов; 58 = 51 `handle` + 7 `on`; 61 член `window.cyborg`; счётчик событий |
| 4.1 | цели `tasks`, `merge-requests`, `path-drop`, `session-history`, `session-isolation`, `status`, `tracker-jira`; воркспейс, оболочка, git - ядро | цели по SAD2: `trackers`, `files`, `sessions`, `agent-claude-code`, `git`, `projects`, `command-buttons`, `search`, `claude-extensions`, `session-notifications`; деление требований по владельцам |
| 4.2 | 58 каналов "из handle" по группам, без владельцев `projects`, `git`, `viewer` | 58 каналов по одному по владельцам SAD2, с типом и проверкой |
| 4.3-4.6 | не было | события, граница `trackers`, данные на диске, открытое по матрице |
| 5 | около 15 сценариев | 18 с номерами |
| 8 | 10 метрик, "время до готового окна: `npm run measure`" | `measure.mjs` старта и памяти не снимает: база - расширить |
| 9 | не было | риски паритета |
