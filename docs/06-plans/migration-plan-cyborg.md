---
level: plan
feature: cyborg-harness
status: draft
date: 2026-11-11
origin: derived
---

# План переезда Cyborg на ядро: карта каналов, событий, данных, тугие узлы и метрики

> **Перенос этого файла в репозиторий ai-cyborg ждёт решения владельца.** План восстановлен здесь, в репозитории харнеса, как файл для сверки; в ai-cyborg ничего не отправлено и PR туда не открыт. Владелец решает, куда план переезжает (`docs/` ai-cyborg, где лежит корпус требований приложения, либо остаётся здесь), и принимает его статус. Статус `draft` - не решение, а отметка о том, что план собран и сверен, но не принят.
>
> Основа - `parity-plan.md` с коммита `9fa78e5` ветки `origin/worktree-docs-harness-architecture` репозитория [ai-cyborg](https://github.com/dex-it/ai-cyborg) (путь `docs/cyborg-harness/04-verification/parity-plan.md`, версия 2026-11-05, сверенная с кодом `e4beb72`). Здесь он пересобран: числа каналов, событий и членов `window.cyborg` пересняты с актуального `master` ai-cyborg (`1f00014`, 2026-11-09) скриптом [migration-plan-cyborg.check.sh](migration-plan-cyborg.check.sh); имена плагинов, контракты, пути и бюджеты сверены с [SAD](../04-architecture/design/sad.md) и кодом этого репозитория; ссылки на документы, которых в харнесе нет, заменены ([приложение А](#приложение-а-соответствие-старых-ссылок)).
>
> **Сверка.** Из корня этого репозитория: `docs/06-plans/migration-plan-cyborg.check.sh <путь к клону ai-cyborg на master>`; выход 0 - числа таблиц 4.2 и 4.3 и раздела 8 равны тому, что в коде, и все ссылки плана на нормы и ADR существуют. Результат на `1f00014` - в [разделе 11](#11-как-проверено).

## 0. Что изменилось с версии `9fa78e5`

**Код ai-cyborg ушёл вперёд.** Версия `9fa78e5` сверялась с `e4beb72`. С тех пор в `master` влиты MCP-сервер Cyborg для сессий (фича 15, ADR-0019 ai-cyborg: `open_session`, `list_sessions`, `send_to_session`, `close_session`), Markdown в просмотрщике с правкой (фича 16, канал `fs:write`), перестановка вкладок перетаскиванием, удаление нескольких сессий из истории разом. Поэтому прежние числа плана (58 каналов, 14 событий, 61 член) устарели; актуальные - в таблице.

| Что | В `parity-plan.md` (`e4beb72`) | Сейчас (`1f00014`) | Откуда |
|---|---|---|---|
| Каналов IPC главного процесса | 58 = 51 `handle` + 7 `on` | **61 = 52 `handle` + 9 `on`** | `ipcMain.handle(` и `ipcMain.on(` в `src/main/main.ts` |
| Новые каналы | - | `session:handoffFailed` (`on`), `edits:unsaved` (`on`), `fs:write` (`handle`) | то же |
| Событий главного процесса окну | 14 | **16** (новые `session:handoff`, `session:close`) | `webContents.send(` в `main.ts`, `emit('session:` в `sessions.ts` |
| Членов `window.cyborg` | 61 | **64** (новые `handoffFailed`, `writeFile`, `reportUnsaved`) | ключи объекта `api` в `src/main/preload.ts` |
| Требований основного корпуса | 153 в 14 фичах | **171 в 16 фичах** (фичи 15 и 16 - 10 и 7; в фиче 08 стало 5) | `docs/01-product/*/srs.md` ai-cyborg |
| Модулей `src/main` без тестов | 38, 7057 строк | 40, 7736 строк | `wc -l` |

**Расхождение с постановкой задачи #13 снято.** Задача писала, что каталог `docs/cyborg-harness` на основной ветке ai-cyborg не удалён (37 файлов первой редакции, где «58 каналов все `handle`», «65 методов», ADR о переносе «душителем»). Это было верно на `e112be0`; PR #73 ai-cyborg («Документация Cyborg Harness перенесена в dex-it/cyborg-harness», 2026-11-06) удалил каталог, и на `1f00014` в `master` его нет (`git ls-tree -r HEAD | grep -c docs/cyborg-harness` даёт 0). Два плана параллельно жить не будут: единственный - этот.

**Поправки к старым числам** (из [инвентаря Cyborg](../research/cyborg-migration-inventory.md#52-неверно-или-неточно-относительно-master), подтверждены на `1f00014`): `alert`/`confirm` - вызовов больше, чем «10» (на `1f00014` - 21 место в `src/renderer`, считано регулярным выражением раздела 8); тестов статически не 925, а считанных `it(`/`test(` - 964 (924 в `test/` и 40 в `src/main/*.test.ts`), запуском не подтверждено; `measure.mjs` привязан к проекту «Upcore» и к `projects.json` userData; шаг 0 («`ProjectStore` сохраняет неизвестные поля», устойчивый id сессии) в ai-cyborg не сделан.

## 1. Что значит «не потеряно»

Функция считается сохранённой, если одновременно:

1. все её требования основного корпуса (`docs/01-product/NN-*/srs.md` ai-cyborg) по-прежнему подтверждены своими проверками;
2. все прежние тесты зелёные, а их утверждения не изменены (меняются пути импорта и способ доступа к проверяемому: окно превращается в `<iframe>`; правило плана ПМ-15);
3. поведение, снятое на записанных сессиях и подставных программах, совпадает с эталоном до допустимых расхождений;
4. данные пользователя после однократной миграции (ПМ-11, ПМ-12; на ядре - [FR-CH-5009](../03-requirements/05-compatibility/srs.md#fr-ch-5009-перевод-старого-формата-не-теряет-поля), [NFR-CH-5001](../03-requirements/05-compatibility/srs.md#nfr-ch-5001-сохранность-разделов), пилот [PL-06](../05-verification/pilot-legacy-data.md)) эквивалентны прежним;
5. бюджеты производительности не нарушены относительно **измеренной** базы ([NFR-CH-1001](../03-requirements/01-plugin-host/srs.md#nfr-ch-1001-накладные-расходы), раздел 8, [cyborg-baseline](../05-verification/cyborg-baseline.md)).

**Прокладки `window.cyborg` и каналов IPC нет.** Решение D-00, строка 4 ([#21](https://github.com/dex-it/cyborg-harness/issues/21)): «прокладка `window.cyborg` и каналов IPC или сборка приложения заново» - принято по предложению задачи, **нет** (P-03, PR #115, 2026-11-08; запись в [SAD, раздел 1](../04-architecture/design/sad.md#1-общая-архитектура), «Адаптер Electron»; на утверждение владельцу как все решения по поручению). Приложение берёт каналы пакета адаптера (`plugins:*`, `view:*`, `window:*`) и само называет мост окна; мост вида остаётся `window.cyborgView`. Следствие для плана: прежний механизм «тест прокладки на 58 прежних каналов» заменён механизмом 7 раздела 3 - тестом на **61 функцию контрактов и команд** по таблице 4.2: каждый прежний канал имеет владельца-плагина и функцию, которая отвечает на тот же запрос; сами каналы исчезают вместе с `window.cyborg`.

## 2. Что можно менять, а что нет

| Допустимо без записи | Допустимо с записью в allowlist | Недопустимо |
|---|---|---|
| Внутреннее устройство, имена модулей и файлов, пути импорта | Переименование «Расширения» в «Расширения Claude Code» (решение плана ПМ-08; в документах харнеса не найдено, нужно решение владельца) | Менять утверждения существующих тестов |
| Порядок активации плагинов, если результат тот же | Нативные `alert` / `confirm` (21 место) заменяются асинхронным слоем диалогов `ctx.dialogs`: синхронная семантика теряется ([FR-CH-2006](../03-requirements/02-extension-contracts/srs.md#fr-ch-2006-слой-окна-диалоги-и-замок)) | Терять данные пользователя или менять формат без миграции (ПМ-06) |
| Способ проверки в `smoke.mjs` и `static-guards.test.ts` при тех же утверждениях | Кнопки от модели: вместо разбора конца хода (`parseSuggestions`) - инструмент MCP `cyborg.agent-tool` ([раздел 10](#10-сверка-с-актуальным-sad), п. 3) | Убирать пункт меню, сочетание, кнопку, настройку |
| | Изменение порядка вызовов, не видимое пользователю, с объяснением | Убирать функцию до того, как её плагин принят по условиям раздела 7 |

**Формат данных меняется один раз.** Старый файл воркспейса `{projects, lastProjectId, commands}`, файлы пользователя и ключи `localStorage` переводятся в `config` и `state` плагинов одной миграцией ([SAD, 3.10](../04-architecture/design/sad.md#310-главный-конфиг-и-состояние)). Недопустима потеря и неэквивалентность, а не сам перенос. До миграции прежний `ProjectStore` обязан сохранять неизвестные поля (шаг 0, ПМ-10), иначе откат на старую версию стирает данные нового формата; проверка отката - `playground/scripts/pilot-legacy-rollback.mjs`.

### 2.1. Поведение, которого нет в основном корпусе

Для него нет эталона «как раньше», поэтому оно проверяется собственными тестами ядра, а не паритетом, и в паритетную матрицу не входит:

| Что | Норма ядра | Почему нет эталона |
|---|---|---|
| Безопасный режим | [FR-CH-1009](../03-requirements/03-security-trust/srs.md#fr-ch-1009-безопасный-режим) | в Cyborg отсутствует |
| Раздел «Плагины Cyborg», журнал плагинов | [FR-CH-1010](../03-requirements/04-observability/srs.md#fr-ch-1010-журнал-и-окно-плагины-cyborg) | новая функция |
| Буфер вывода pty, `list`, `attach`, повторный `resize`, pty-хост | [FR-CH-1015](../03-requirements/01-plugin-host/srs.md#fr-ch-1015-процессы-дольше-плагина-pty), [FR-CH-1018](../03-requirements/01-plugin-host/srs.md#fr-ch-1018-сбой-слоя-pty-не-замораживает-окно), [FR-CH-1019](../03-requirements/01-plugin-host/srs.md#fr-ch-1019-осиротевший-pty-завершается-по-льготному-времени) | в Cyborg буфера нет, вкладки и вывод живут только в окне |
| Восстановление сессий после перезапуска приложения | [SAD, 5.3](../04-architecture/design/sad.md#53-восстановление-сессий), [FR-CH-2019](../03-requirements/02-extension-contracts/srs.md#fr-ch-2019-агент-без-продолжения-сессии) | противоречит non-goal BRD Cyborg для режима `eager` (D-00, строка 18 - решение владельца); ленивое ручное восстановление в стенде сделано |
| Сторож хостов, перезапуск хоста плагина | [FR-CH-1005](../03-requirements/01-plugin-host/srs.md#fr-ch-1005-изоляция-сбоя-хосты-и-сторож) | прецедента нет |

## 3. Механизмы

| № | Механизм | Что ловит | Откуда идея |
|---|---|---|---|
| 1 | **Матрица паритета** (раздел 4): фича, нормы, каналы, целевой плагин, проверка, статус | Забытую функцию | bb `row-counts.json`, `verification-matrix` Cyborg |
| 2 | **Существующие тесты** (статически 964 `it(`/`test(`, раздел 8) и дымовой тест | Регрессию поведения | корпус Cyborg |
| 3 | **Записанные сессии и подставные программы** (раздел 5) | Регрессию на уровне интерфейса и событий | bb `provider-parity`, dsh `snapshots/session` |
| 4 | **Allowlist допустимых расхождений**; лишняя запись роняет проверку | Молчаливый дрейф | bb `parity-allowlist.json` |
| 5 | **Закреплённые счётчики**: каналы - 61 (52 `handle` и 9 `on`), события окну (16), члены `window.cyborg` (64), диалоги (6), ключи `localStorage` (10 и 3 семейства), требования (171) | Потерянный или лишний элемент | bb `row-counts.json` |
| 6 | **Храповики границ**: ядро не импортирует плагины, плагин - только `@cyborg-harness/contracts` и свои модули; счётчик прямых обращений к `electron`, `node:*`, `fs` в `src/main` не растёт (23 из 40 модулей) | Обратную связность | bb `check-provider-literal-ratchet`, dsh `check-workspace-constraints`; на ядре - `checkPlugin` ([FR-CH-7005](../03-requirements/07-author-kit/srs.md#fr-ch-7005-checkplugin)) |
| 7 | **Тест соответствия каналов**: для каждого из 61 прежних каналов таблица 4.2 называет функцию контракта или команду плагина-владельца; тест перебирает таблицу и проверяет, что функция отвечает так же, как отвечал канал на эталонный запрос (для `on` - наблюдаемый эффект). Без прокладки (раздел 1) канал не вызывается, вызывается его преемник | Потерю функции при исчезновении канала | - |
| 8 | **Тесты через настоящий загрузчик** и **HMR-safety тест реестров** | Плагин, который в тестах работал, а в приложении нет | dsh постмортем 0001; на ядре - `@cyborg-harness/testing` ([FR-CH-7004](../03-requirements/07-author-kit/srs.md#fr-ch-7004-тест-кит)) |
| 9 | **Бюджеты** (раздел 8), включая вывод терминала и горячие пути | Регрессию запуска и отзывчивости | dsh бенчмарки; проверка бюджетов - `npm run check:budgets` этого репозитория |
| 10 | **Тест миграции данных**: эталонные файлы `e4beb72` -> `config` и `state`, повторный запуск ничего не меняет, секретов в результате нет; откат не стирает поля | Потерю данных пользователя | пилот PL-06 ([pilot-legacy-data](../05-verification/pilot-legacy-data.md)) |
| 11 | **Тесты дисциплины первого этапа**: `structuredClone`, импорты, доступ к ОС только через `ctx.os` | Плагин, который невозможно будет изолировать на втором этапе | [SAD, 6.1](../04-architecture/design/sad.md#61-этап-1-ядро-без-изоляции-доступа); `checkPlugin` |

## 4. Матрица паритета

### 4.1. Функции и целевые плагины

Числа - требования основного корпуса (FR и NFR) ai-cyborg на `1f00014`, всего 171 в 16 фичах (подсчёт заголовков `### FR-` и `### NFR-` в `docs/01-product/NN-*/srs.md`). Деление между владельцами - предложение составителя, его подтверждает скрипт паритета: строка без плагина или проверки блокирует закрытие фазы. Колонка «Нормы ядра» - номера из [SRS харнеса](../03-requirements/README.md); где нормы нет, названа часть SAD или пилот.

| Фича корпуса Cyborg | Требований | Целевой владелец | Нормы ядра | Чем проверяем | Статус |
|---|---|---|---|---|---|
| 01 панель задач, воркспейсы | 37 | `trackers` - 30; ядро - 7: FR-1026..1030, FR-1033 (воркспейс, шлюз путей) и FR-1032 (ввод, размер, завершение сессии - pty-хост) | [FR-CH-1014](../03-requirements/01-plugin-host/srs.md#fr-ch-1014-воркспейс-как-главная-сессия), [FR-CH-1015](../03-requirements/01-plugin-host/srs.md#fr-ch-1015-процессы-дольше-плагина-pty), [FR-CH-3007](../03-requirements/03-security-trust/srs.md#fr-ch-3007-выбор-человека-dialog-и-granted), [FR-CH-5009](../03-requirements/05-compatibility/srs.md#fr-ch-5009-перевод-старого-формата-не-теряет-поля); `trackers` - [SAD, 5](../04-architecture/design/sad.md#5-пример-базовая-часть), пилот [PL-07](../05-verification/pilot-trackers.md) | `trackers.test.ts`, `task-details.test.ts`, `cli-limits.test.ts`, `workspaces.test.ts`, `stores.test.ts`; S6, S15, S18 | не начато |
| 02 вид MR и PR | 18 | `trackers` | [FR-CH-2012](../03-requirements/03-security-trust/srs.md#fr-ch-2012-права-в-манифесте-и-этапы-изоляции), [FR-CH-3017](../03-requirements/03-security-trust/srs.md#fr-ch-3017-поставщик-текста-агенту), PL-07 | `mrs.test.ts`, `flow.test.ts`; S7 | не начато |
| 03 путь в промпт | 5 | `files` - FR-3001 (строка дерева как источник MIME); `sessions` - FR-3002, FR-3003, FR-3005 (бросок на терминал, кавычки, зоны); ядро - FR-3004 (путь файла ОС, `webUtils.getPathForFile` синхронный: перехват drop в оболочке). Плагина `path-drop` нет | [SAD, 3.8 и раздел 4](../04-architecture/design/sad.md#38-изоляция-рендера) (перетаскивание между видами ведёт ядро, данные - MIME) | `drop-path.test.ts`; S13 | не начато |
| 04 дерево файлов сессии | 8 | `files` (корни - из `cyborg.projects` и cwd живых сессий `cyborg.sessions`) | [FR-CH-2007](../03-requirements/03-security-trust/srs.md#fr-ch-2007-шлюз-ctxos), пилот [PL-04](../05-verification/pilot-files-git.md) | `tree.test.ts`, `tree-keys.test.ts`, `allowed-paths.test.ts`; S2 | не начато |
| 05 macOS | 9 | ядро - FR-5001, FR-5002, FR-5004, FR-5006; `agent-claude-code` - FR-5003, FR-5008; `projects` - FR-5007; вне кода (CI) - FR-5005, FR-5009 | [FR-CH-2004](../03-requirements/02-extension-contracts/srs.md#fr-ch-2004-команды-и-сочетания), [FR-CH-2024](../03-requirements/02-extension-contracts/srs.md#fr-ch-2024-сочетания-во-время-работы), [FR-CH-2028](../03-requirements/02-extension-contracts/srs.md#fr-ch-2028-уведомления-и-заголовок-окна), [FR-CH-6006](../03-requirements/06-delivery/srs.md#fr-ch-6006-системное-сочетание-и-pty-на-поддерживаемых-ос), [NFR-CH-1009](../03-requirements/06-delivery/srs.md#nfr-ch-1009-платформы); [macos-check](../05-verification/macos-check.md) | `platform.test.ts`, `menu.test.ts`, `history.test.ts`, `stores.test.ts` | не начато |
| 06 README и сайт | 3 | вне кода приложения | - | не переносится | не переносится |
| 07 смена ветки | 5 | `git` - FR-7001..7004 (список, `git switch`, отказ при сессии, отказ при конфиге с командами); `files` - FR-7005 | `cyborg.git`: [SAD, вопрос 16](../04-architecture/design/sad.md#8-открытые-вопросы), пилот PL-04 | `git-branch.test.ts`; S12 | не начато |
| 08 история сессий | 5 | `agent-claude-code` (вид «Сессии»; продолжение - через `sessions`) | [FR-CH-2010](../03-requirements/02-extension-contracts/srs.md#fr-ch-2010-плагин-agent-claude-code) | `history.test.ts`; S5 | не начато |
| 09 изоляция сессий | 3 | `sessions` - FR-9001, FR-9003 (потребитель фрагментов; поставщик фрагмента изоляции - плагин `session-isolation`, он есть в стенде); `agent-claude-code` - FR-9002 (порядок аргументов запуска) | [FR-CH-3017](../03-requirements/03-security-trust/srs.md#fr-ch-3017-поставщик-текста-агенту); порядок фрагментов - [раздел 10](#10-сверка-с-актуальным-sad), п. 2 | `session-args.test.ts`, `sessions.test.ts` | не начато |
| 10 настройки окна, вкладки, доступность, уведомления, ссылки в выводе | 13 | ядро - FR-10001, FR-10002, FR-10005, FR-10007..10011, FR-10013; `sessions` - FR-10003, FR-10012; `projects` - FR-10004; `session-notifications` - FR-10006 | [FR-CH-2006](../03-requirements/02-extension-contracts/srs.md#fr-ch-2006-слой-окна-диалоги-и-замок), [FR-CH-2025](../03-requirements/02-extension-contracts/srs.md#fr-ch-2025-вклады-в-меню-окна), [FR-CH-2028](../03-requirements/02-extension-contracts/srs.md#fr-ch-2028-уведомления-и-заголовок-окна), [FR-CH-5009](../03-requirements/05-compatibility/srs.md#fr-ch-5009-перевод-старого-формата-не-теряет-поля); [notify-chain](../05-verification/notify-chain.md) | `font-size.test.ts`, `prefs.test.ts`, `title.test.ts`, `tabs.test.ts`, `neighbor.test.ts`, `term-links.test.ts`, `notify.test.ts`, `menu.test.ts`; S3, S15 | не начато |
| 11 «Статус» | 12 | `trackers` (карточка «Статус» и Jira - вид того же плагина, [4.4](#44-граница-trackers)) | PL-07 | `status-model.test.ts`, `jira.test.ts`; S8 | не начато |
| 12 кнопки-команды | 10 | `command-buttons`; сочетания - `ctx.keys.register` ядра; кнопки от модели - `cyborg.agent-tool` | [FR-CH-2004](../03-requirements/02-extension-contracts/srs.md#fr-ch-2004-команды-и-сочетания), [FR-CH-2024](../03-requirements/02-extension-contracts/srs.md#fr-ch-2024-сочетания-во-время-работы), [FR-CH-2025](../03-requirements/02-extension-contracts/srs.md#fr-ch-2025-вклады-в-меню-окна), [FR-CH-3017](../03-requirements/03-security-trust/srs.md#fr-ch-3017-поставщик-текста-агенту) | `commands.test.ts`, `commands-store.test.ts`, `command-values.test.ts`, `prompts.test.ts`, `suggestions.test.ts` (переопределить, п. 3 раздела 10); S4, S14; D-27 закрыт реестром ядра | не начато |
| 13 поиск | 9 | `search` | [FR-CH-2026](../03-requirements/02-extension-contracts/srs.md#fr-ch-2026-отмена-запроса-между-плагинами), [FR-CH-2025](../03-requirements/02-extension-contracts/srs.md#fr-ch-2025-вклады-в-меню-окна) | `search-model.test.ts`, `git-search.test.ts`, `file-list.test.ts`; S9 | не начато |
| 14 расширения Claude Code | 17 | `claude-extensions` | [FR-CH-2025](../03-requirements/02-extension-contracts/srs.md#fr-ch-2025-вклады-в-меню-окна); права `net` для хабов - D-00, строка 17 | `extensions*.test.ts`, `hubs.test.ts`; S10, S11 | не начато |
| 15 MCP-сервер сессий (новая) | 10 | `sessions` (сервер по праву `serve`, инструменты сессий) | [FR-CH-3006](../03-requirements/03-security-trust/srs.md#fr-ch-3006-локальный-сервер-serve), [FR-CH-3017](../03-requirements/03-security-trust/srs.md#fr-ch-3017-поставщик-текста-агенту), [SAD, раздел 5](../04-architecture/design/sad.md#5-пример-базовая-часть) («Кнопки следующих шагов через MCP») | `mcp.test.ts`, `session-tools.test.ts`; S19 | не начато |
| 16 Markdown в просмотрщике (новая) | 7 | `viewer` (право `fs.write` на существующий `.md` в разрешённых каталогах) | [FR-CH-2007](../03-requirements/03-security-trust/srs.md#fr-ch-2007-шлюз-ctxos), [FR-CH-3015](../03-requirements/03-security-trust/srs.md#fr-ch-3015-закрытая-csp-вида) | `md-links.test.ts`, `write-file.test.ts`; S20 | не начато |
| **Итого** | **171** | | | | |

Владелец `viewer` в корпусе до фичи 16 собственных требований не имел; теперь у него 7 (все из фичи 16), остальное его паритет проверяется через `fs:read`, `git:headContent` и сценарии S12, S14.

**Сводка по владельцам.** Скрипт паритета проверяет эти числа вместе с таблицей.

| Владелец | Требований | | Владелец | Требований |
|---|---|---|---|---|
| `trackers` | 60 | | `claude-extensions` | 17 |
| ядро | 21 | | `command-buttons` | 10 |
| `sessions` | 17 | | `search` | 9 |
| `files` | 10 | | `agent-claude-code` | 8 |
| `viewer` | 7 | | `git` | 4 |
| вне кода приложения (CI, README и сайт) | 5 | | `projects` | 2 |
| | | | `session-notifications` | 1 |
| | | | **Итого** | **171** |


### 4.2. Каналы IPC и целевые владельцы

Всего **61 канал: 52 `ipcMain.handle` и 9 `ipcMain.on`** (все в `src/main/main.ts`; `ipcMain` в других файлах не используется). `on` - вызовы без ответа: `session:input`, `session:resize`, `session:kill`, `session:handoffFailed`, `session:notify`, `session:unnotify`, `notifications:state`, `project:selected`, `edits:unsaved`. Каждый канал проверен по `main.ts` и `preload.ts` скриптом сверки: 61 вызов `ipcRenderer.invoke` и `ipcRenderer.send` в `preload.ts` соответствует 61 обработчику. Колонка «Чем проверяем» - всегда тест соответствия каналов (механизм 7) плюс названное; `S*` - сценарии [раздела 5](#5-записанные-сессии-и-подставные-программы).

| Канал | Тип | Владелец | Что меняется при переносе | Чем проверяем |
|---|---|---|---|---|
| `dialog:pickWorkspaceDir` | handle | ядро: воркспейс | диалог через `ctx.os.dialog` ядра | `workspaces.test.ts`; S15 |
| `workspace:info` | handle | ядро: воркспейс | отдаёт `home`, `sep`, имя и файл воркспейса; платформа - забота ядра | `workspaces.test.ts`; smoke |
| `workspace:create` | handle | ядро: воркспейс | процесс на воркспейс, замок `<файл>.lock`; защита `offeredWorkspace` сохраняется | `workspaces.test.ts`; S15 |
| `workspace:open` | handle | ядро: воркспейс | то же; повторное открытие занятого воркспейса отказывает ([FR-CH-1014](../03-requirements/01-plugin-host/srs.md#fr-ch-1014-воркспейс-как-главная-сессия)) | `workspaces.test.ts`; S15 |
| `path:open` | handle | ядро: `shell` | право `shell`, область `any` (D-00, строка 15: документ или каталог); вызывает `sessions` (ссылки в выводе, FR-10012) | `term-links.test.ts`; S1 |
| `url:open` | handle | ядро: `shell` | схемы URL в праве `shell` (сегодня только http и https) | `term-links.test.ts`; S1 |
| `session:input` | on | ядро: pty-хост | прямой путь по билету `pty.share()`; проверка аргументов FR-1032 (предел 1 МиБ) переезжает в мост и в pty-хост | `session-args.test.ts`; S1, S17 |
| `session:resize` | on | ядро: pty-хост | то же; размер 1..1000; после `attach` ядро шлёт `resize` само | `session-args.test.ts`; S1, S17 |
| `dialog:pickDir` | handle | `projects` | через `ctx.os.dialog` и `ctx.os.security.setRoots`: каталог сразу доступен `files` и `git` до сохранения проекта (область `granted`, [FR-CH-3007](../03-requirements/03-security-trust/srs.md#fr-ch-3007-выбор-человека-dialog-и-granted)); сегодня `AllowedPaths.grant` | `allowed-paths.test.ts`; smoke |
| `projects:load` | handle | `projects` | раздел `settings.projects` и `state` | `stores.test.ts`; S18 |
| `projects:problem` | handle | `projects` (раздел) и ядро (копия файла) | раздел не прошёл схему - отказ только `projects`; копия `<файл>.corrupt-<время>` закрыта для плагинов вместе с файлом (D-00, строка 15) | `stores.test.ts`, `workspaces.test.ts` |
| `projects:save` | handle | `projects` | `saveProjectsState` проверяет и секцию трекеров и вызывает `trackers.resetAuth()`: после переноса - `cyborg.project-settings` (`validate`, `save`) и `projects.onChange` | `stores.test.ts`; S18 |
| `project:selected` | on | `projects` (состояние) + меню ядра | канал уходит: пункты «Свойства проекта», «Поиск», «Расширения» - вклады в меню `contributes.menus` с `enabled` из булева члена контракта `cyborg.projects` ([FR-CH-2025](../03-requirements/02-extension-contracts/srs.md#fr-ch-2025-вклады-в-меню-окна)) | `menu.test.ts` |
| `session:create` | handle | `sessions` | проверка каталогов через `cyborg.projects`; промпт запуска из фрагментов `cyborg.session-prompt`; возвращает устойчивый id (шаг 0); старт `{handoff}` для `open_session` (фича 15) | `sessions.test.ts`; S1, S6, S7, S19 |
| `session:resume` | handle | `sessions` (вызов) и `agent-claude-code` (`resume`) | проверка журнала сессии - в агенте | `sessions.test.ts`, `history.test.ts`; S5 |
| `session:kill` | on | `sessions` | `pty.kill()` у владельца процесса; процесс держит pty-хост | `session-args.test.ts`; S1 |
| `session:handoffFailed` | on | `sessions` | вкладку по одноразовому ключу открыть не удалось: причина возвращается вызвавшей модели (фича 15, FR-15003) | `session-tools.test.ts`; S19 |
| `history:list` | handle | `agent-claude-code` | нужен `projectId` -> репозитории (`cyborg.projects`, `optional`) | `history.test.ts`; S5 |
| `history:delete` | handle | `agent-claude-code` | **запись** `fs.write` в `~/.claude/projects` (не чтение); удаление нескольких сессий разом | `history.test.ts`; S5 |
| `session:notify` | on | `session-notifications` | право `notify`; клик по уведомлению - команда плагина и фокус окна ([FR-CH-2028](../03-requirements/02-extension-contracts/srs.md#fr-ch-2028-уведомления-и-заголовок-окна)) | `notify-args.test.ts`, `notify.test.ts`; S3 |
| `session:unnotify` | on | `session-notifications` | то же | `notify.test.ts`; S3 |
| `notifications:state` | on | `session-notifications` | выключатель хранит плагин; пункт меню - вклад с `checked` из состояния плагина | `notify.test.ts`, `menu.test.ts`; S3 |
| `trackers:status` | handle | `trackers` | результат проверки входа - один, прогретый (FR-1019) | `trackers.test.ts` |
| `tasks:list` | handle | `trackers` | список выборки; `tracked` - привязки сессий из меток сессии в памяти | `trackers.test.ts`, `cli-limits.test.ts`; S6 |
| `tasks:details` | handle | `trackers` | описание только по задаче текущей выборки (FR-1024) | `task-details.test.ts` |
| `tasks:sessionDetails` | handle | `trackers` | то же для задачи сессии | `task-details.test.ts` |
| `tasks:open` | handle | `trackers` | `shell.openExternal` -> право `shell` на схемы URL | `trackers.test.ts`; S6 |
| `jira:status` | handle | `trackers` | `jira-cli` через `process` | `jira.test.ts`; S8 |
| `jira:list` | handle | `trackers` | то же | `jira.test.ts`; S8 |
| `jira:projects` | handle | `trackers` | то же | `jira.test.ts` |
| `jira:suggest` | handle | `trackers` | ходит в git за ветками: `cyborg.git` (`branches`) | `jira.test.ts` |
| `jira:details` | handle | `trackers` | то же | `jira.test.ts`; S8 |
| `jira:open` | handle | `trackers` | `shell.openExternal` | `jira.test.ts` |
| `mrs:list` | handle | `trackers` | выборка MR/PR; пул запросов и отмена (пилот PL-07: пул 6, тайм-аут, предел вывода) | `mrs.test.ts`; S7 |
| `mrs:open` | handle | `trackers` | `shell.openExternal` | `mrs.test.ts` |
| `mrs:details` | handle | `trackers` | пределы деталей MR | `mrs.test.ts`; S7 |
| `git:root` | handle | `git` | `cyborg.git.root`; право `process` на `git` | `git.test.ts`, `allowed-paths.test.ts` |
| `git:branch` | handle | `git` | `cyborg.git.branch`; нужен ещё `command-buttons` (`{branch}`, `{pr}`) | `git.test.ts`; S14 |
| `git:status` | handle | `git` | `cyborg.git.status`; опрос раз в 3 с заменяется событием `onChange` и `fs.watch` (пилот PL-04) | `git.test.ts`; S2 |
| `git:branches` | handle | `git` | `cyborg.git.branches`; сегодня только для репозиториев сохранённых проектов | `git-branch.test.ts`; S12 |
| `git:switch` | handle | `git` | `cyborg.git.switch`; отказ, когда репозиторий занят сессией, - связь с `cyborg.sessions` ([4.6](#46-что-в-матрице-остаётся-открытым), п. 4) | `git-branch.test.ts`; S12 |
| `git:headContent` | handle | `git` | `cyborg.git.headContent`; нужен `viewer` для diff, у которого права на процессы нет | `git-head.test.ts`, `git-filters.test.ts` |
| `fs:list` | handle | `files` | `fs.read` и `fs.watch` в области `workspace`; последовательные вызовы на каждый раскрытый каталог - горячий путь | `allowed-paths.test.ts`, `tree.test.ts`; S2 |
| `fs:read` | handle | `viewer` | `fs.read` в `workspace`; шлюз проверяет путь после `realpath` | `allowed-paths.test.ts`; S12, S20 |
| `fs:write` | handle | `viewer` | перезапись только существующего Markdown в разрешённых каталогах (FR-16004): право `fs.write` в области `workspace`, без `workspace.git`; конфликт с изменением на диске остаётся вопросом человеку (FR-16005) | `write-file.test.ts`; S20 |
| `edits:unsaved` | on | `viewer` | число файлов с несохранённой правкой; вопрос при закрытии окна задаёт ядро (слой диалогов), число отдаёт `viewer` (FR-16006) | `write-file.test.ts`; S20 |
| `fs:files` | handle | `search` | список файлов корня (`git ls-files` либо обход); **в `cyborg.git` члена `files` пока нет** ([раздел 10](#10-сверка-с-актуальным-sad), п. 4) | `file-list.test.ts`; S9 |
| `search:text` | handle | `search` | `git grep` с отменой запроса ([FR-CH-2026](../03-requirements/02-extension-contracts/srs.md#fr-ch-2026-отмена-запроса-между-плагинами)) | `git-search.test.ts`, `search-model.test.ts`; S9 |
| `search:changes` | handle | `search` | то же, поиск по изменениям | `git-search.test.ts`; S9 |
| `commands:load` | handle | `command-buttons` | общий набор - файл пользователя, набор воркспейса - раздел `config` воркспейса | `commands-store.test.ts`; S14, S18 |
| `commands:save` | handle | `command-buttons` | проверку набора ведёт владелец; редактор открывает `viewer` с проверкой владельца ([4.6](#46-что-в-матрице-остаётся-открытым), п. 7) | `commands.test.ts`; S14 |
| `prompts:load` | handle | `command-buttons` | файл `prompts.json`; читают ещё `session:create` и трекеры ([4.6](#46-что-в-матрице-остаётся-открытым), п. 5) | `prompts.test.ts` |
| `prompts:save` | handle | `command-buttons` | то же | `prompts.test.ts` |
| `config:reveal` | handle | `command-buttons` | вид `commands` открывает **файл воркспейса** - защищённый путь ядра; решено: команда ядра `cyborg.workspace.reveal` (D-00, строка 15) | `commands-store.test.ts` |
| `extensions:load` | handle | `claude-extensions` | читает `~/.claude/*` и `.mcp.json` репозиториев; права описываются при переносе | `extensions.test.ts`, `extensions-read.test.ts`; S10 |
| `extensions:probe` | handle | `claude-extensions` | запуск `claude` через `$SHELL -lc`; проверка связи MCP только по кнопке | `extensions.test.ts`; S10 |
| `extensions:act` | handle | `claude-extensions` | установка и удаление плагина, магазины; одно действие за раз | `extensions-act.test.ts`; S10 |
| `extensions:usage` | handle | `claude-extensions` | статистика по журналам сессий; кэш `extensions-usage.json` | `extensions-usage.test.ts` |
| `hubs:list` | handle | `claude-extensions` | `hubs.json` в разделе плагина | `hubs.test.ts`; S11 |
| `hubs:change` | handle | `claude-extensions` | то же | `hubs.test.ts`; S11 |
| `hubs:fetch` | handle | `claude-extensions` | https к хабам: право `net` (адрес от пользователя - D-00, строка 17) | `hubs.test.ts`; S11 |

**Итого по владельцам: 61.**

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
| `sessions` | 4 | 2 (`session:kill`, `session:handoffFailed`) |
| `session-notifications` | 3 | 3 |
| `search` | 3 | 0 |
| `agent-claude-code` | 2 | 0 |
| `files` | 1 | 0 |
| `viewer` | 3 | 1 (`edits:unsaved`) |
| **Итого** | **61** | **9** |

Скрипт сверки строит список каналов из `ipcMain.handle(` и `ipcMain.on(` в `main.ts` и сверяет его с таблицей по именам и видам: лишний или пропущенный канал даёт расхождение.

### 4.3. События главного процесса окну

16 событий (все через `webContents.send`; в окне подписка `api.on(...)`). Каждое имеет целевое событие или вклад. Общей шины нет ([ADR-CH-0001](../04-architecture/adr/ADR-CH-0001-core-and-plugins.md)), событие - часть контракта владельца.

| Событие | Владелец | Целевое место | Чем проверяем |
|---|---|---|---|
| `session:data` | ядро: pty-хост | вывод идёт из pty-хоста в `<iframe>` `sessions` по `MessagePort` (билет `pty.share()`); без пакетирования по чанкам, как сегодня, - нельзя | нагрузочный сценарий вывода ([9.1](#91-горячие-пути-pty)); S1 |
| `session:exit` | `sessions` | `cyborg.sessions.onChange` (выход) | `sessions.test.ts`; S1 |
| `session:cwd` | `sessions` (источник - хук агента) | `onChange` (смена каталога); дерево идёт за сессией | S2 |
| `session:activity` | `sessions` (источник - хук агента) | `onChange` (активность) | S1 |
| `session:waiting` | `sessions` | `onChange` (ожидание); потребитель - `session-notifications` | S3 |
| `session:suggest` | `command-buttons` | **заменяется**: кнопки от модели приходят инструментом MCP `cyborg.agent-tool` (`next-actions` в стенде), а не разбором последнего сообщения по `turnEnd`; паритет S4 переопределяется ([раздел 10](#10-сверка-с-актуальным-sad), п. 3) | `suggestions.test.ts`; S4 |
| `session:reveal` | `session-notifications` | клик по уведомлению -> команда плагина -> `cyborg.sessions.reveal` и фокус окна | S3 |
| `session:handoff` | `sessions` | вкладка по одноразовому ключу от `open_session` (фича 15); ключ и промпт не проходят через интерфейс (ADR-0019 ai-cyborg, п. 4) | `session-tools.test.ts`; S19 |
| `session:close` | `sessions` | `close_session` закрывает вкладку проекта тем же путём, что крестик (ADR-0019 ai-cyborg, п. 9) | `session-tools.test.ts`; S19 |
| `notifications:toggle` | `session-notifications` | пункт меню с `checked` из состояния плагина | `menu.test.ts` |
| `menu:create-workspace` | ядро: воркспейс | меню «Воркспейс» | `menu.test.ts`; S15 |
| `menu:project` (`new` / `edit`) | `projects` | команды `projects.new`, `projects.edit` по вкладу в меню | `menu.test.ts` |
| `menu:commands` | `command-buttons` | вклад в меню | `menu.test.ts` |
| `menu:prompts` | `command-buttons` | вклад в меню | `menu.test.ts` |
| `menu:search` (режим) | `search` | вклад в меню и сочетание | `menu.test.ts`; S9 |
| `menu:extensions` (вкладка) | `claude-extensions` | вклад в меню и сочетание | `menu.test.ts`; S10 |

### 4.4. Граница `trackers`

**Открытый вопрос.** [SAD, раздел 5](../04-architecture/design/sad.md#5-пример-базовая-часть) называет плагин `trackers` (поставщик `cyborg.project-settings`), но не фиксирует, один это плагин или несколько. Прежняя версия плана держала шесть плагинов (`tasks`, `merge-requests`, `status`, `tracker-github`, `tracker-gitlab`, `tracker-jira`); этого деления нет в SAD, оно снято.

**Что в коде.** 14 каналов (`trackers:status`, `tasks:*`, `jira:*`, `mrs:*`), модули `trackers.ts`, `mrs.ts`, `mrs-service.ts`, `jira.ts`, `jira-service.ts`, `task-details.ts` и три вида окна - «Задачи», «MR/PR», «Статус» (60 из 171 требования корпуса, фичи 01, 02, 11).

**Рабочее предложение: один плагин `trackers` с тремя видами.**

1. `MrsService` построен поверх `TrackersService` (общая проверка входа, один результат на все выборки, определение источника по remote, пределы вызовов `gh` и `glab`: FR-1019, NFR-1003, NFR-2001); `JiraService` делит с ними запуск CLI и шаблоны промптов. Разрезать значило бы сначала выпустить контракт провайдера трекера.
2. Карточка «Статус» (FR-11005, FR-11007) собирает задачи Jira, MR/PR и их связь; при разбиении она стала бы составным экраном из карточек разных плагинов, а правило «чужой UI в свой не встраивается» ([ADR-CH-0007](../04-architecture/adr/ADR-CH-0007-plugin-ui.md), п. 5) такой случай не покрывает.
3. Один раздел `settings.trackers.byProject` и одна секция `cyborg.project-settings` для GitHub, GitLab и Jira (FR-1009, FR-1010, FR-11001, FR-11012).
4. Привязка задачи и MR к сессии, живущая только в памяти (FR-1015, FR-2014), остаётся одна: метки сессии `cyborg.sessions`, в память, не на диск.

Права `trackers` по коду: `process` на `gh`, `glab`, `jira` (широкий класс, [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов)); `shell` на схемы URL для `*:open`; запросы ветки и remote - через `cyborg.git`; токенов плагин не хранит. Решение «трекеры на CLI» принято в D-00, строка 19 (по предложению: CLI); срез трекеров уже сделан пилотом PL-07 (`playground/plugins/trackers`, [отчёт](../05-verification/pilot-trackers.md)).

**Когда пересматривать.** После паритета. Если появится сторонний трекер или Jira уйдёт на HTTP API (узкий класс, новое требование, не перенос), из `trackers` выделяется провайдер за контрактом.

### 4.5. Данные на диске и владельцы

Назначения файлов, которых SAD не называет, - предложение; тест миграции (механизм 10) проверяет каждый. Перенос файла воркспейса и `localStorage` уже сделан пилотом PL-06 ([pilot-legacy-data](../05-verification/pilot-legacy-data.md), хук `playground/src/main/legacy-workspace.ts`, таблица «поле - куда»); таблица ниже - карта для остального.

| Данные | Кто пишет сегодня | Целевой владелец и место | Правило |
|---|---|---|---|
| Файл воркспейса: `projects`, `lastProjectId`, `commands` | `ProjectStore` (`projects.ts`), `saveCommands`, `createWorkspaceFile` | `projects` -> `settings.projects`; `trackers` и `jira` -> `settings.trackers.byProject`; `commands` -> раздел `command-buttons`; `lastProjectId` -> `state` | ПМ-11 |
| `<файл>.lock` | воркспейс | ядро | [FR-CH-1014](../03-requirements/01-plugin-host/srs.md#fr-ch-1014-воркспейс-как-главная-сессия) |
| `<файл>.corrupt-<время>` | `keepCopy` | ядро; закрыта для плагинов (D-00, строка 15) | ПМ-11 |
| `userData/recent-workspaces.json` | все экземпляры, без блокировки | «Недавние» ядра | ПМ-12 |
| `userData/projects.json`, `trackers.json` | прежний путь (`trackers.json` только читается) | `projects`, `trackers`; старый `projects.json` по-прежнему открывается как воркспейс | ПМ-06 |
| `userData/commands.json` | `CommandStore` | `command-buttons`, файл пользователя | ПМ-12 |
| `userData/prompts.json` | `PromptStore` | `command-buttons`; потребители - `sessions` и `trackers` ([4.6](#46-что-в-матрице-остаётся-открытым), п. 5) | ПМ-12 |
| `userData/hubs.json` | `HubStore` | `claude-extensions` | ПМ-12 |
| `userData/extensions-usage.json` | `UsageStore` | `claude-extensions`: `state` или `plugin-data` | ПМ-12 |
| `userData/claude-hooks.json` | каждый экземпляр при старте | `agent-claude-code`, `plugin-data` | ПМ-12 |
| `userData/sessions/<pid>-<id>.jsonl` | `claude` по хуку | `agent-claude-code`, `plugin-data`; имя от устойчивого id сессии, без pid | ПМ-10, ПМ-12 |
| Файл конфига MCP сессии (0600, токен) и `CYBORG_MCP` (фича 15) | `sessions.ts` | `sessions`, `plugin-data`; токен не в аргументах командной строки | ПМ-12 |
| `userData/workspaces/<хеш>/` (сессия Chromium, `localStorage`, ключи `cyborg.*`) | окно | `state` плагинов-владельцев; у `<iframe>` другой origin, ключи иначе теряются | ПМ-12, PL-06 |

Ключи `localStorage` на `1f00014` - 10 постоянных (`cyborg.fontSize`, `cyborg.notifications`, `cyborg.tasks.assigned`, `cyborg.tasks.sort`, `cyborg.mrs.filter`, `cyborg.mrs.sort`, `cyborg.search.mode`, `cyborg.extensions.tab`, `cyborg.extensions.view`, `cyborg.extensions.size`) и три семейства с вычисляемым ключом (`cyborg.extensions.${key}`, `cyborg.search.${key}`, `cyborg.tasks.labels:${id}`). Закрытый список ключей хранилища окна зафиксирован `static-guards.test.ts`; он переписывается вместе с переносом без потери утверждений.

### 4.6. Что в матрице остаётся открытым

Расхождения между SAD, корпусом Cyborg и кодом, найденные при составлении матрицы. Закрытое с версии `9fa78e5` вычеркнуто с ссылкой на решение.

1. **Привязка задачи и MR к сессии.** В коде это поля объекта сессии в окне (`s.task`, `s.mr`, `s.jira`): от них зависят заголовок сессии (FR-1014, FR-2013), возврат к строке панели (FR-1031) и подстановки `{task}`, `{pr}` (FR-12003). Решение в SAD (правило 11, раздел 4): владелец сущности (`sessions`) даёт метки с ключом по плагину, только в памяти; контракт `cyborg.sessions` в пакете пока несёт только `onChange` (пилот PL-02), членов «метки» и «привязка» нет - нужны до переноса `trackers`.
2. ~~Кнопки-команды под терминалом~~ - решено правилом 11 SAD: полоса кнопок - вклад `many` в вид владельца (`sessions`), рисует владелец; проверяется в PL-08 ([#32](https://github.com/dex-it/cyborg-harness/issues/32), PR #220, на ревью).
3. **Состав `cyborg.git`.** SAD (вопрос 16) решил: `root`, `branch`, `status`, `headContent`, `branches`, `switch`, `remotes`, `files`. В пакете `contracts/git.ts` пока `status` и `onChange` (черновик PL-04); остальное добавляется необязательными членами (минор). `gitGrep` и `gitDiffSearch` у `search` сегодня вызывают `git` сами: решить, остаётся ли у `search` право `process` на `git` или члены добавляются в контракт.
4. **`git:switch` и сессии.** Сегодня отказ идёт от `sessions.uses(root)`. Если `git` потребует `cyborg.sessions`, граф получит зависимость `git` -> `sessions`. Предложение: проверку ведёт `files` перед вызовом, но тогда другой потребитель `cyborg.git.switch` её обойдёт. Решение за переносом `git`.
5. **Промпты и цикл.** `prompts.json` отдаётся `command-buttons`, но все пять шаблонов (`mr.review`, `mr.rework`, `mr.ci`, `task.start`, `jira.start`) относятся к стартам из трекеров. SAD (правило 11) разрывает цикл: `command-buttons` и `trackers` зависят от `sessions`, а не друг от друга; `{pr}` и `{task}` кнопки читают из меток сессии.
6. ~~Источник фрагмента изоляции~~ - решено: плагин `session-isolation` (`cyborg.session-prompt`, many) есть в стенде; порядок фрагментов - [раздел 10](#10-сверка-с-актуальным-sad), п. 2.
7. **Проверка владельца при правке JSON.** Сегодняшний редактор кнопок и промптов проверяет сохранение в главном процессе, остаётся открытым при ошибке, показывает замечания и спрашивает при несохранённой правке (`config-editor.ts`). Контракт редактора (`viewer`) должен принимать проверку владельца; формы в SAD нет.
8. ~~Повреждённый файл воркспейса~~ - решено (D-00, строка 15): копия `<файл>.corrupt-<время>` закрыта для плагинов вместе с файлом, поведение сохраняется, владелец - ядро.
9. ~~Область для `path:open`~~ - решено (D-00, строка 15): область `any` права `shell`.
10. ~~`config:reveal` и защищённый путь~~ - решено (D-00, строка 15): команда ядра `cyborg.workspace.reveal`.
11. **Число методов `window.cyborg`.** Ранние документы говорили о 65 методах; в коде 64 члена объекта `api` на `1f00014` (61 на `e4beb72`). Исправлено в плане, скрипт сверки держит число.
12. **Число тестов.** Ранние документы: 893, затем 925; статически считано 964 (924 + 40), запуском не подтверждено (`npm test` в ai-cyborg не запускался при составлении плана).
13. **«21 из 40 модулей».** На `1f00014` в `src/main` 40 модулей без тестов, из них 23 импортируют `node:*`, `electron` или `node-pty`; это стартовое значение храповика.
14. **MCP-сервер Cyborg (фича 15) и сервер плагина.** В ai-cyborg сервер поднимает главный процесс. В харнесе сервер MCP держит потребитель `sessions` по праву `serve` (SAD, раздел 5); инструменты `open_session`, `list_sessions`, `send_to_session`, `close_session` в стенде не реализованы (`playground/plugins/sessions/mcp.ts` отдаёт инструменты поставщиков `cyborg.agent-tool`). Решить: переносятся ли инструменты сессий в `sessions` как есть, и кто хранит токены сессий.

## 5. Записанные сессии и подставные программы

**Подставные программы.** Уже есть в дымовом тесте ai-cyborg (`scripts/smoke.mjs`): `claude`, `gh`, `jira`; в `fixtures/fake-bin` (PL-09, ai-cyborg PR #79, на ревью). Расширяем: `glab`, `claude plugin ...` (магазины, установка, удаление), `git` на фикстурных репозиториях. В харнесе есть свои подставные программы: `playground/scripts/fake-claude.mjs` (хуки, MCP, вывод) и `playground/scripts/fake-trackers.mjs`.

**Записанная сессия** - набор файлов в `test/parity/<сценарий>/`:

| Файл | Что |
|---|---|
| `events.jsonl` | События хуков, которые получает приложение (формат `claude-hooks.json` событий) |
| `output.txt` | Вывод pty (как есть) |
| `cli.json` | Ответы подставных `gh`, `glab`, `jira`, `claude plugin` на запросы |
| `expect.json` | Эталон: нормализованные события `session.*`, строки дерева, панелей, меню, состояние видов |
| `manifest.json` | Версия записи, версия Claude Code, на которой снята, описание |

Нормализация идёт на уровне событий контрактов и строк видов, а не DOM окна: после переноса в `<iframe>` обращение к `#tree` или `#session-list` из `document` окна не работает ([9.4](#94-smoke-и-static-guards-завязаны-на-dom-и-списки)).

**Сценарии первой записи** (идентификаторы используются в таблицах выше). S1-S18 - прежний перечень; S19-S20 добавлены при сверке с `1f00014`.

| № | Сценарий |
|---|---|
| S1 | новая сессия, ввод, вывод, ссылка из вывода |
| S2 | смена cwd на worktree (дерево идёт за сессией) |
| S3 | запрос разрешения и уведомление |
| S4 | конец хода с предложением кнопок (на ядре - через `cyborg.agent-tool`) |
| S5 | продолжение сессии и удаление из истории (в том числе нескольких разом) |
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
| S16 | перезапуск хоста плагина: сессия продолжается, события после `attach` совпадают с эталоном (сделано на подставном `claude` в PL-01) |
| S17 | перезагрузка окна: pty живы, терминал восстанавливается, TUI перерисован (сначала новый эталон, [9.1](#91-горячие-пути-pty)) |
| S18 | миграция: файл `e4beb72` -> `config` и `state`, ключи `localStorage` -> `state` (PL-06) |
| S19 | инструменты сессий MCP: `open_session` в фоне, `send_to_session` только в состоянии «ждёт», `close_session` без `force` не обрывает работу соседки |
| S20 | Markdown: рендер, сравнение с HEAD, правка по кнопке, конфликт с изменением на диске, закрытие окна с несохранённой правкой |

**Повтор.** Тест проигрывает запись против текущей сборки и сравнивает нормализованный результат с `expect.json`. Расхождение допустимо только при записи в allowlist (`test/parity/allowlist.json`: сценарий, поле, причина, ссылка на решение). Запись в allowlist, которой не пользуется ни одно расхождение, роняет проверку.

## 6. Чек-лист PR переноса

PR, переносящий функцию в плагин, обязан:

- [ ] перенести код в каталог плагина, не меняя утверждений существующих тестов (ПМ-15). Каталог: у стенда это `playground/plugins/<id>`; **где живут встроенные плагины приложения (в ai-cyborg или в этом репозитории), решает владелец** (D-00, строка 3: адаптер принят в `electron/`, место плагинов остаётся открытым). Каталога плагинов внутри `src` приложения (как в версии `9fa78e5`) в харнесе и в SAD нет;
- [ ] указать плагин-владелец каждого перенесённого канала, события и файла (разделы 4.2, 4.3, 4.5); канал без владельца блокирует PR;
- [ ] объявить права в манифесте по таблице [SAD, 3.7](../04-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) и показать их в «Плагины Cyborg»; импортировать только `@cyborg-harness/contracts` и свои модули, к ОС обращаться только через `ctx.os` (проверяет `cyborg-plugin check`, `checkPlugin`);
- [ ] обновить строку матрицы (статус «перенесено, паритет подтверждён»), счётчики и allowlist, если нужны;
- [ ] приложить прогон: тесты, дымовой тест, паритет, храповики, `check:corpus` ai-cyborg;
- [ ] приложить замер бюджета, если функция в пути запуска, открытия окна, вывода терминала, дерева или поиска;
- [ ] описать откат шага (ПМ-14);
- [ ] данные: формат меняется только миграцией (ПМ-11, ПМ-12) с тестом на эталонных файлах; новая запись в файлы, не входящие в список писателей, - отдельное решение.

## 7. Условия готовности ядра и выхода фаз

Фаза закрывается только при зелёных механизмах 1-11 раздела 3, красной строке в матрице нет и пилоты ниже, от которых зависит фаза, закрыты. Пилоты PL-01..PL-09 ([эпик, критерий 9](epic-microkernel.md)) - условие готовности ядра к переезду; состояние на 2026-11-11:

| Пилот | Что доказывает для переезда | Состояние | Отчёт |
|---|---|---|---|
| PL-01 | реальная сессия через `sessions` и `agent-claude-code` под нагрузкой, перезапуск хоста и окна | закрыт; на подставном `claude`, на живом не проверено | [pilot-sessions](../05-verification/pilot-sessions.md) |
| PL-02 | цепочка хук - статус - уведомление в другом плагине | закрыт; ручная проверка клика | [notify-chain](../05-verification/notify-chain.md) |
| PL-03 | единый реестр сочетаний на macOS | закрыт | [macos-check](../05-verification/macos-check.md) |
| PL-04 | дерево, git и просмотр через границу плагинов, `fs.watch` вместо опроса | закрыт | [pilot-files-git](../05-verification/pilot-files-git.md) |
| PL-05 | Monaco и xterm в `<iframe>` на `cyborg-plugin://` | закрыт | [spike-monaco-xterm](../05-verification/spike-monaco-xterm.md) |
| PL-06 | миграция файла воркспейса и `localStorage`, откат | закрыт | [pilot-legacy-data](../05-verification/pilot-legacy-data.md) |
| PL-07 | CLI-плагин с отменой и пулом (срез трекеров) | закрыт | [pilot-trackers](../05-verification/pilot-trackers.md) |
| PL-08 | раскладка окна Cyborg на областях и вкладах в меню | **на ревью** ([#32](https://github.com/dex-it/cyborg-harness/issues/32), PR #220): без него полоса сессий, панель инструментов и вклады в меню не подтверждены | отчёта в `master` нет |
| PL-09 | базовые метрики Cyborg и записанные сессии | закрыт | [cyborg-baseline](../05-verification/cyborg-baseline.md) |

Кроме пилотов, переезд зависит от решений владельца ([roadmap, раздел 15](roadmap.md#15-решения-владельца)): заморозка API 1.0 (K-21), число экземпляров приложения (D-00, строка 5 - принято по поручению: процесс на воркспейс), `eager`-восстановление сессий (строка 18), место встроенных плагинов (строка 3, остаток).

## 8. Базовые метрики (P0)

Числа снимаются на коде ai-cyborg и записываются в таблицу; дальше сравниваются на каждой фазе. Колонка «Значение» - то, что получено сверкой с `1f00014` (скрипт сверки берёт отмеченные «скрипт» числа сам); измеренные замеры - в [cyborg-baseline](../05-verification/cyborg-baseline.md) (PL-09, macOS, медиана пяти прогонов, коммит `e4beb72`, на `1f00014` не повторялись).

| Метрика | Значение сейчас | Как снять |
|---|---|---|
| Требований основного корпуса | 171 (16 фич) | `cat docs/01-product/*/srs.md \| grep -cE '^### N?FR-[0-9]+'` (скрипт, справочно); `npm run check:corpus` |
| Тестов | 964 статически (924 в `test/`, 40 в `src/main/*.test.ts`); запуском не подтверждено | `cat test/*.ts \| grep -cE '^\s*(it\|test)\('`; `npm test` |
| Каналов IPC главного процесса | **61**: 52 `ipcMain.handle` и 9 `ipcMain.on` (скрипт) | `grep -ohE "ipcMain\.(handle\|on)\('[^']+'" src/main/main.ts` |
| Событий главного процесса окну | **16** (скрипт) | `grep -ohE "webContents\.send\('[^']+'" src/main/main.ts` и `emit('session:` в `sessions.ts` |
| Членов `window.cyborg` | **64**: 61 привязан к каналу, плюс `platform`, `pathForFile`, `on` (скрипт) | ключи объекта `api` в `src/main/preload.ts` |
| Диалогов `<dialog>` в `index.html` | 6 (скрипт) | `grep -c '<dialog' src/renderer/index.html` |
| Постоянных ключей `localStorage` | 10 и 3 семейства (скрипт) | `grep -ohE "'cyborg\.[A-Za-z]+\.[A-Za-z]+'" src/renderer/*.ts` |
| Мест вызова `alert` / `confirm` | 21: `app.ts` 12, `md-viewer.ts` 8, `config-editor.ts` 1 | `grep -nE "(^\|[^A-Za-z.])(alert\|confirm)\(" src/renderer/*.ts` |
| Строк `src/main` (без тестов) | 7736 в 40 файлах (`main.ts` 686) | `wc -l` |
| Строк `src/renderer` (TypeScript) | 7501 в 49 файлах (`app.ts` 1514) | `wc -l` |
| Модулей `src/main`, импортирующих `node:*`, `electron` или `node-pty` | 23 из 40; стартовое значение храповика | `grep -lE "from '(node:\|electron\|node-pty)" src/main/*.ts` без тестов |
| Файлов `src/renderer`, импортирующих `../main/*` | 20; выносятся в `@cyborg-harness/contracts` до переноса | `grep -lE "from '\.\./main/" src/renderer/*.ts \| wc -l` |
| Время до готового окна, память, вывод терминала, окна поиска и «Расширения», размер бандлов | измерено PL-09 на `e4beb72` (старт 455 мс, окно без сессий 170 МиБ все процессы, вывод 50 000 строк 340 мс) - [cyborg-baseline](../05-verification/cyborg-baseline.md) | `npm run build && node scripts/bench.mjs --runs 5` в ai-cyborg (PR #79) |

**Бюджеты.** Решены владельцем 2026-11-07 (D-00, строка 6): вызов через шлюз `ctx.os` не более 1 мс на p99 до 64 КиБ, событие `fs.watch` не позже 5 мс на p99 после склейки 50 мс, вывод терминала не более 16 мс. Для старта и памяти предложено «не хуже базы на 10% по медиане», решение за владельцем: числа `hosts.limits` в `playground/budgets.json` пусты (P-10). Ядро добавляет процессы хостов плагинов (~27 МиБ на хост), поэтому «все процессы» зависят от числа хостов в поставке; главный процесс и рендерер сравниваются отдельно.

## 9. Риски паритета, найденные сверкой с кодом

### 9.1. Горячие пути pty

- Вывод идёт `proc.onData` -> `emit('session:data')` -> `webContents.send` на каждый чанк, без пакетирования; сессия без вкладки копит чанки в `pendingData`, копируя весь массив на каждый чанк (`app.ts`), то есть квадратично.
- В Cyborg нет буфера вывода: вкладки и прокрутка живут только в окне, поэтому перезагрузка страницы убрана из меню.
- Буфер, `list`, `attach` и повторный `resize` - **новое поведение ядра**; эталона «как раньше» для S17 нет. Решено: хвост + `resize`, снимок запасным (D-00, строка 11).
- Реальный `claude` в pty-хосте не проверен: PL-01 шёл на подставном (`playground/scripts/fake-claude.mjs`). Проверка человеком - команда в отчёте PL-01 (`CYBORG_SMOKE_CLAUDE=1`).

*Что делаем.* База вывода терминала есть (PL-09); сценарии S1, S16, S17 в записях; нагрузочный сценарий, который ловит квадратичный `pendingData`.

### 9.2. Клавиши и D-27

- Системные сочетания - акселераторы меню плюс `window.addEventListener('keydown', ..., true)` в `app.ts`. Сочетания, которых нет в меню и которые живут только в слушателе окна: `Cmd/Ctrl+Shift+N` (новая сессия) и `Cmd/Ctrl+0` (размер шрифта по умолчанию); слушатель окна не видит нажатий из `<iframe>`.
- Горячие клавиши кнопок (F1-F4 по умолчанию) условные: не при `repeat`, не в `INPUT` и `TEXTAREA` (кроме поля xterm), не при открытом диалоге, только для видимой сессии. На ядре - `ctx.keys.register({ key, command, args?, when? })` с закрытым списком `when` ([FR-CH-2024](../03-requirements/02-extension-contracts/srs.md#fr-ch-2024-сочетания-во-время-работы)).
- Дефект D-27 (`RESERVED_*` без `Cmd+P`, `Shift+F/D/X`) закрыт единым реестром ядра (D-00, строка 16; K-07).
- Проверка настоящей клавиатурой на macOS - PL-03 ([macos-check](../05-verification/macos-check.md)).

### 9.3. `localStorage`

- 10 постоянных ключей и три семейства ([4.5](#45-данные-на-диске-и-владельцы)) живут в хранилище окна воркспейса (`userData/workspaces/<хеш>/`). У `<iframe>` с другим origin (`cyborg-plugin://<группа>/`) оно другое: настройки интерфейса пропадут, если не перенести их миграцией. Перенос ключей в память видов сделан пилотом PL-06 (`legacy-prefs`).
- `sandbox` без `allow-same-origin` лишает кадр хранилищ origin совсем; Monaco и xterm в кадре проверены PL-05.

### 9.4. `smoke` и `static-guards` завязаны на DOM и списки

- `smoke.mjs` (993 строки) проверяет DOM окна (`#tree`, `#session-list`, `#tree-meta`, заголовок, `localStorage`) через CDP главного документа; после переноса вида в `<iframe>` селекторы ищутся в нужном кадре.
- `static-guards.test.ts` закрывает: список файлов `src/main`, пишущих на диск; список ключей, которые интерфейс пишет в хранилище окна; запрет `innerHTML` и подобного (FR-1018); `aria-labelledby` у каждого `<dialog>` (FR-10010). Правило «привязка задачи к сессии только в памяти» (FR-1015, FR-2014) переформулируется вместе с восстановлением сессий.
- Правило «утверждения не меняются» выполнимо только при смене способа проверки (ПМ-15).

*Что делаем.* Утверждения выписываются в таблицу до переноса; число утверждений не уменьшается; невыполнимое - в allowlist с причиной.

### 9.5. Тугие узлы

- **Связность `src/main`.** 23 из 40 модулей импортируют `node:*`, `electron` или `node-pty`; 20 файлов окна импортируют типы и значения из `../main/*`. Правило «плагин импортирует только `@cyborg-harness/contracts`» требует сначала вынести общие типы.
- **`workspaces.ts` -> `projects` и `trackers`** (`validateProjectsState` из `trackers.ts`); `projects:save` -> `trackers.resetAuth()`. В SAD эта связь превращается в `cyborg.project-settings` и `projects.onChange`; до переноса `projects` и `trackers` двигать порознь нельзя.
- **`sessions` -> `suggestions` -> `commands`**; **`jira`, `mrs`, `trackers` -> `prompts` -> `commands`**; **`hubs` -> `commands`**. Разбор предложений кнопок и сборка промптов тянут модуль кнопок в `sessions` и в трекеры; в SAD цикл разорван правилом 11 (раздел 4).
- **`sessions.ts`** держит и менеджер сессий, и запуск `claude` с хуками (`claude-args`, `events-store`, `suggestions`, `pid`, `node-pty`), и теперь MCP-сервер сессий (`mcp.ts`, `session-tools.ts`): разрез на `sessions` и `agent-claude-code` делается одним шагом.
- **`app.ts` (1514 строк)** держит проекты, воркспейс, сессии, терминалы, дерево, историю, меню выбора, клавиши, уведомления и вкладки перетаскиванием; оболочка разрезается не по плагинам, а по мере их переноса.
- **Горячие вызовы через хост.** `listDir` - последовательные вызовы на каждый раскрытый каталог, опрос `git:status` раз в 3 с, поиск отдаёт в окно весь список файлов. Каждый вызов станет цепочкой окно - хост - шлюз - ОС; бюджет шлюза 1 мс p99 задан и измерен ([spike-gateway](../05-verification/spike-gateway.md)), дерево на `fs.watch` измерено PL-04.
- **Буфер обмена и диалоги.** `navigator.clipboard` в UI терминала и 21 `alert`/`confirm`: у вида нет `ctx.os.clipboard` (буфер - команда главной части с правом `clipboard`, SAD 3.8), синхронное подтверждение слой диалогов не даёт.
- **Бросок файлов ОС.** `webUtils.getPathForFile` синхронный и нужен в том кадре, куда бросают файл (FR-3004); MIME-перетаскивание между кадрами ведёт ядро.
- **Права агента.** `claude` запускается как `$SHELL -lc 'exec claude ...'`; удаление истории - запись, не чтение; хуки пишут файлы в app-data; очищается окружение `CLAUDE*`. Это права `pty` (оболочка), `launch`, `fs.read`/`fs.write` в `plugin-data`, `env`.
- **Трекеры на CLI.** `gh`, `glab`, `jira` через `process`; узкий класс «только `net`» возможен после перехода на HTTP API.

## 10. Сверка с актуальным SAD

Что в версии `9fa78e5` устарело или расходится с SAD и кодом харнеса на 2026-11-11 и как это записано в плане.

| № | Тема | В `parity-plan.md` | В SAD и коде сейчас | В плане |
|---|---|---|---|---|
| 1 | Имена плагинов | `session-notifications`, `claude-extensions`, `command-buttons`, `search`, `trackers`, `files`, `sessions`, `agent-claude-code`, `git`, `projects`, `viewer` | SAD, раздел 5, описывает `sessions`, `agent-claude-code`, `files`, `viewer`, `projects`, `git`, `trackers`; `search` и `command-buttons` упомянуты в правилах раздела 4 и вопросах; **`session-notifications` и `claude-extensions` в SAD отдельно не описаны**. `session-notifications` есть в стенде (пилот PL-02, [notify-chain](../05-verification/notify-chain.md)); `claude-extensions` - только в плане | Имена оставлены как решение плана, **не принятое владельцем**; при приёмке SAD добавить строки таблицы раздела 5 для двух плагинов или принять план как их описание |
| 2 | `cyborg.session-prompt` и порядок фрагментов | «Отдельного плагина `session-isolation` нет»; требование «байт-в-байт тот же промпт и порядок аргументов» | Плагин `session-isolation` есть в стенде (`cyborg.session-prompt`, кратность many). `sessions` собирает фрагменты всех поставщиков и сортирует **по id плагина** (`playground/plugins/sessions/index.ts`, `localeCompare`). В Cyborg промпт `ISOLATION + SUGGEST` (изоляция первой); в стенде фрагменты дают `next-actions` и `session-isolation`, по сортировке `next-actions` идёт **раньше** | Требование «байт-в-байт» для составного промпта **невыполнимо без явного порядка**: порядок по id не равен порядку Cyborg. Решение владельца/автора SAD: явный порядок фрагментов (поле `order` у вклада) либо проверка только фрагмента изоляции. Фрагмент изоляции переносится дословно (`ISOLATION_PROMPT`) |
| 3 | Кнопки от модели | разбор последнего сообщения (`parseSuggestions`) по концу хода, событие `session:suggest`, тесты `suggestions.test.ts` | `cyborg.agent-tool` (many) и MCP: инструмент отдаёт кнопки `actions` ([SAD, раздел 5](../04-architecture/design/sad.md#5-пример-базовая-часть), `next-actions`, `sessions/mcp.ts`) | Паритет S4 переопределён: требования FR-12007/12008 (кнопки снимаются на следующий запрос, на фоновую работу, на вопрос) остаются, реализация другая; смена поведения или паритет - решение владельца (D-00, строка 18) |
| 4 | `cyborg.git` с `remotes` и `files` | нет `gitRemotes`/`gitFiles` | SAD (вопрос 16) решил: `root`, `branch`, `status`, `headContent`, `branches`, `switch`, `remotes`, `files`; в пакете `contracts/git.ts` пока `status` и `onChange` (черновик PL-04), остальное - необязательные члены в миноре | Таблица 4.2: `fs:files`, `git:branches`, `git:switch`, `git:headContent` ждут этих членов; ссылка в [4.6](#46-что-в-матрице-остаётся-открытым), п. 3 |
| 5 | Восстановление сессий | «условно, без решения владельца не реализуется» | [SAD, 5.3](../04-architecture/design/sad.md#53-восстановление-сессий): ленивое ручное восстановление сделано (`resumeId`, `sessions.restore`, `capabilities.resume`); `eager` - отложено, конфликт с non-goal BRD Cyborg | Строка в 2.1; `eager` остаётся решением владельца (D-00, строка 18) |
| 6 | Пути плагинов | каталог плагинов внутри `src` приложения | `playground/plugins/<id>` (стенд); каталога встроенных плагинов приложения нет | Чек-лист раздела 6: путь не фиксируется, место плагинов - решение владельца (D-00, строка 3) |
| 7 | Бюджеты | «не хуже базового более чем на 10%», числа не заданы | Решены 2026-11-07: шлюз 1 мс p99, `fs.watch` 5 мс p99, вывод 16 мс; старт и память - открыто (предложение «не хуже базы на 10%») | Раздел 8 |
| 8 | Прокладка `window.cyborg` и каналов | механизм 7 и чек-лист исходят из strangler внутри ai-cyborg | D-00, строка 4: прокладки нет | Раздел 1 и механизм 7 |
| 9 | MCP-сервер сессий, Markdown-вид | нет (появились после `e4beb72`) | В стенде MCP держит `sessions` по праву `serve`, инструментов `open_session` и др. нет; `viewer` Markdown не рендерит | Фичи 15 и 16 в 4.1, S19-S20, 4.6 п. 14 |
| 10 | Устойчивый id сессии, `ProjectStore` | шаг 0 | в ai-cyborg не сделан (`OWN_FIELDS`, `nextId++`) | ПМ-10 |

## 11. Как проверено

Команда: `docs/06-plans/migration-plan-cyborg.check.sh <клон ai-cyborg на 1f00014>` (клон только читается). Прогон на `1f00014` (2026-11-11): `ИТОГ: сверка сошлась`, выход 0 - каналов 61 = 52 `handle` + 9 `on` (имена и виды таблицы 4.2 совпали с `main.ts`, набор `preload.ts` тот же), событий 16, членов `window.cyborg` 64, диалогов 6, постоянных ключей 10 и три семейства, `alert`/`confirm` 21, тестов статически 964; все `FR-CH`, `NFR-CH` и `ADR-CH` плана есть в этом репозитории. Скрипт проверен на провале: с удалённой строкой `fs:write` и ссылкой на несуществующий `FR-CH-1099` он выходит с кодом 1 и называет обе причины. Не проверено запуском: тесты ai-cyborg (`npm test`), `npm run smoke`, замеры PL-09 на `1f00014`; числа раздела 8 - статические.

## 12. Правила плана

Нормы переноса в версии `9fa78e5` жили в отдельной фиче «03-migration» корпуса харнеса (FR-CH-3001..3016); в этом репозитории её нет - перевод Cyborg на ядро в SRS ядра не входит ([roadmap](roadmap.md)). Нормы, которые нужны плану, оставлены здесь под номерами ПМ-NN и перепривязаны к существующим нормам ядра, где они есть. Принять их как нормы ai-cyborg (в его SRS) или оставить планом - решение владельца.

| № | Правило | Опирается на |
|---|---|---|
| ПМ-01 | Матрица паритета: каждая из 171 требований корпуса Cyborg и каждый канал, событие и файл данных имеют плагин-владельца и проверку | механизм 1 |
| ПМ-03 | Совместимость каналов обеспечивает не прокладка, а соответствие функций (механизм 7) | D-00, строка 4 |
| ПМ-04 | Записанные сессии и подставные программы, allowlist расхождений | раздел 5 |
| ПМ-05 | Храповики границ: счётчик прямых обращений к `electron`, `node:*`, `fs` не растёт | механизм 6 |
| ПМ-06 | Сохранность данных пользователя при переносе; откат шага не стирает поля | [FR-CH-5009](../03-requirements/05-compatibility/srs.md#fr-ch-5009-перевод-старого-формата-не-теряет-поля), [NFR-CH-5001](../03-requirements/05-compatibility/srs.md#nfr-ch-5001-сохранность-разделов) |
| ПМ-07 | Бюджеты производительности против измеренной базы | раздел 8, [NFR-CH-1001](../03-requirements/01-plugin-host/srs.md#nfr-ch-1001-накладные-расходы) |
| ПМ-08 | Переименование окна «Расширения» в «Расширения Claude Code» - допустимое расхождение с записью в allowlist (нужно решение владельца) | раздел 2 |
| ПМ-09 | Условие выхода фазы: механизмы 1-11 зелёные, красной строки нет, пилоты фазы закрыты | раздел 7 |
| ПМ-10 | Шаг 0 на текущем коде ai-cyborg: `ProjectStore` сохраняет неизвестные поля, id сессии устойчив между запусками | [5.2 инвентаря](../research/cyborg-migration-inventory.md#52-неверно-или-неточно-относительно-master) |
| ПМ-11 | Перенос формата файла воркспейса одной миграцией | [FR-CH-5009](../03-requirements/05-compatibility/srs.md#fr-ch-5009-перевод-старого-формата-не-теряет-поля), PL-06 |
| ПМ-12 | Перенос файлов пользователя и `localStorage` одной миграцией | PL-06 |
| ПМ-14 | Каждый шаг переноса обратим: описан откат | PL-06 (`pilot-legacy-rollback.mjs`) |
| ПМ-15 | Тесты переносятся с сохранением утверждений; меняются путь импорта и способ доступа к проверяемому | раздел 1 |

(Номера ПМ-02 и ПМ-13 не заняты: они приходились на нормы версии `9fa78e5`, которые теперь устарели - прокладка каналов, восстановление сессий условно; восстановление записано в 2.1.)

## Приложение А. Соответствие старых ссылок

Ссылки версии `9fa78e5` на документы, которых в этом репозитории нет, и номера FR-CH, которых нет в SRS ядра. Блок не входит в проверку ссылок скрипта.

<!-- old-refs:begin -->

| Было в `parity-plan.md` | Стало |
|---|---|
| `ADR-CH-0006-strangler-migration-and-parity` | снят, в харнес не вошёл ([ресёрч, README](../research/README.md)); вместо него D-00, строка 4 (прокладки нет) и этот план |
| `ADR-CH-0010-contracts-instead-of-services` | влит в [ADR-CH-0005](../04-architecture/adr/ADR-CH-0005-plugin-interaction.md) при слиянии 2026-11-06 ([ADR/README](../04-architecture/adr/README.md)) |
| `sad2.md`, ссылки `SAD2, 3.x` | [sad.md](../04-architecture/design/sad.md) (бывший SAD2 слит с ним 2026-11-06), тот же номер раздела |
| `docs/01-product/03-migration/srs.md`, FR-CH-3001..3016, NFR-CH-3001 | в SRS ядра нет; нормы плана - раздел 12 (ПМ-NN) |
| `docs/01-product/01-plugin-host/srs.md`, `.../02-extension-contracts/srs.md` | `docs/03-requirements/01-plugin-host/srs.md`, `.../02-extension-contracts/srs.md` |
| FR-CH-1018 (сторож хостов и pty-хоста) | FR-CH-1005 (хосты и сторож), FR-CH-1018 (сбой слоя pty) |
| FR-CH-1020 (дисциплина первого этапа тестами) | `checkPlugin` и проверка импортов, FR-CH-7005; SAD 6.1 |
| FR-CH-1021 (pty-хост: persist, list, attach, буфер, resize) | FR-CH-1015 |
| FR-CH-1022 (завершение pty: сирота, выключение, закрытие) | FR-CH-1019 |
| FR-CH-2003 (события сессий в `cyborg.sessions`) | FR-CH-2002; контракт `contracts/sessions.ts` (PL-02) |
| FR-CH-2011 (плагин `trackers`) | нормы нет; SAD, раздел 5, пилот PL-07 |
| FR-CH-2016 (отмена запросов) | FR-CH-2026 |
| FR-CH-2017 (бросок пути, MIME) | нормы нет; SAD 3.8 и раздел 4 |
| FR-CH-2024 (билет `pty.share`) | FR-CH-1015 |
| FR-CH-2028, 2030 (macOS, платформа) | FR-CH-6006, NFR-CH-1009; FR-CH-2028 теперь - уведомления и заголовок окна |
| FR-CH-2029 (динамические сочетания с условиями) | FR-CH-2024 |
| FR-CH-2031 (вклады в меню) | FR-CH-2025 |
| FR-CH-2032 (вклады в промпт запуска агента) | FR-CH-3017 (поставщик текста агенту), `cyborg.session-prompt` |
| FR-CH-2033 (заголовок и фокус окна, буфер обмена) | FR-CH-2028 |
| FR-CH-2034 (каталог, выбранный в диалоге) | FR-CH-3007 |
| FR-CH-2035 (два класса плагинов) | FR-CH-2012; SAD 3.7 |
| NFR-CH-2003, NFR-CH-2004 (задержка шлюза, задержка вывода терминала) | NFR-CH-1001 (накладные расходы); бюджеты D-00, строка 6 |
| FR-CH-3006, 3011, 3012 (сохранность данных, перенос формата и файлов) | ПМ-06, ПМ-11, ПМ-12; FR-CH-5009 |
| FR-CH-3007 (бюджеты производительности) | ПМ-07, NFR-CH-1001 |
| FR-CH-3014 (восстановление сессий условно) | SAD 5.3 |
| FR-CH-3016 (смена ветки) | `cyborg.git` (SAD, вопрос 16) |
| `src/plugins/<id>` | `playground/plugins/<id>`; место встроенных плагинов приложения - решение владельца |

<!-- old-refs:end -->
