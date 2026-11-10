---
level: research
feature: cyborg-harness
status: review
date: 2026-11-10
origin: derived
---

> Анализ готовности ядра к системе плагинов, 2026-11-06. Основа эпика [микроядра](../06-plans/epic-microkernel.md). Составлен чтением кода и документов без запуска приложения и тестов: ключи K-, T-, P- в тексте - рабочие номера анализа, не задач GitHub (соответствие - в реестре эпика); утверждения о коде проверяются в задачах.

# Cyborg Harness: анализ готовности микроядра к системе плагинов

Репозиторий: /Users/anonymous/Desktop/Work/Agents/cyborg-harness (dex-it/cyborg-harness), master, последний коммит fb4190f (2026-11-06). 38 коммитов за 2026-11-04..06.

## 0. Метод и оговорки

Прочитано полностью: CLAUDE.md, README.md, docs/README.md, docs/OVERVIEW.md, docs/04-architecture/design/sad.md (разделы 1-10), sad2-disputed-points.md, все 9 ADR-CH (0001, 0002, 0003, 0004, 0005, 0007, 0008, 0012, 0014), docs/06-plans/roadmap.md, docs/01-product/** (brd, обе фичи: brd-feat, decision-log, srs), docs/05-verification/*, docs/02-use-cases/*, docs/00-strategy/one-pager.md. Из docs/research: заголовки sad2-validation.md, начало cyborg-today.md, строки со ссылками.

Код, прочитан целиком: core/src/{manifest,loader,host-runtime,graph,registry,semver,journal,status,config,workspace,recent,permissions,keys,via-contract,documents,window-layer,ui-shell,pty,errors,wire,rpc,transports,host-entry,disposable,index}.ts; contracts/*.ts и contracts/README.md; playground/src/main/{main,plugins,plugin-hosts,plugin-host,os-env,view-files,views}.ts; playground/scripts/build.mjs; манифесты плагинов playground; .github/workflows/ci.yml; eslint.config.mjs; package.json. Просмотрено частично: core/src/os-gateway.ts (строки 1-260, 380-560, 680-760), json-schema, serve, elements-model, core/elements/elements.ts, core/examples, playground/plugins/{sessions,agent-claude-code,pin-lock}, playground/test/agents.test.ts (начало), playground/scripts/smoke.mjs (заголовки), core/test/plugin-imports.test.ts и hosts.test.ts (начало), renderer. Тесты core/test читались по именам и выборочно.

НЕ делал: не запускал npm, Electron, тесты, smoke, lint, typecheck, build; не читал ai-cyborg и issue/PR на GitHub (в т.ч. issue #2); не запускал настоящий claude. "Покрыт тестом" ниже = в core/test или playground/test есть тест с таким предметом, а не "тест сейчас зелёный". Число тестов - статический подсчёт строк test(/it(: core около 211, playground около 35, всего около 246, плюс smoke (487 строк).

Размер: S до 2 чел.-дней, M 3-8, L больше 8 (мои оценки, в документах их нет). "Владелец" = владелец продукта; "автор" = автор/составитель SAD. Где документы решающего не называют, назначение - моё предложение.

---

## 1. Что такое ядро сейчас

### 1.1. Карта каталогов

| Каталог | Строк | Что |
|---|---|---|
| core/src | около 6160 (30 файлов) | ядро без npm-зависимостей и без Electron, только node:* и типы @cyborg/contracts |
| core/elements | 450 | элементы cy-* (Custom Elements) для видов; идут в браузерный бандл оболочки вида; отдельный tsconfig с DOM |
| core/examples | около 420 + 16 каталогов плагинов | консольные сценарии (npm run demo) и демо-плагины (files, projects, viewer, sessions, editor, tabs, clock, monitor, pin-lock, flaky, cycle-a/b, future, broken-manifest, lock-alt, clock-user) на вымышленных контрактах; это не реализации SAD 5 |
| core/test | 33 *.test.ts + fake-pty.ts, contracts-types.ts, fixtures/ | тесты ядра на Node 24 |
| contracts | 717 (6 файлов) | @cyborg/contracts: только типы (index, plugin, view, os, agent, elements) + README.md (258 строк). package.json: private:true, версия 1.0.0, types: ./index.ts, без сборки |
| playground/src/main | около 2,5 тыс. вкл. тесты и спайки | склейка ядра с Electron: main.ts (313), plugins.ts (545, PluginsService), plugin-hosts/plugin-host (utilityProcess), os-env.ts (safeStorage, node-pty, shell, dialog), views.ts/view-files.ts (схема cyborg-plugin://, CSP, оболочка), preload.ts, view-terminals.ts, view-drag.ts, theme.ts |
| playground/src/renderer | около 0,9 тыс. | окно: панели плагинов, видов, документов, журнала, клавиш; слой диалогов; фокус |
| playground/plugins | 12 плагинов | базовые: sessions, agent-claude-code, agent-shell, session-isolation, next-actions, pin-lock; демо: echo, chat, alice, bob, flaky, later |
| playground/scripts | build.mjs, smoke.mjs, spike-*.mjs, xtest.py | сборка esbuild, smoke по DevTools Protocol, замеры. В рабочей копии лежит НЕотслеживаемый smoke-diag.mjs (494 строки, копия smoke.mjs с диагностикой в одном месте) |
| .github/workflows | один ci.yml | macOS + ubuntu-24.04, Node 24: npm ci, build, typecheck, lint, test, smoke |

Ключевое наблюдение для "переезда ai-cyborg": между core/ и работающим приложением лежит слой склейки в playground (около 1,4 тыс. строк главного процесса + 0,9 тыс. рендерера): хосты на utilityProcess, адаптер ОС, протокол cyborg-plugin:// с CSP и оболочкой вида, preload-мост, IPC-каналы view:* и plugins:*, перехват клавиш, сервис состояния. Он не оформлен как пакет и не документирован. Ядро тоже не пакет: core/package.json = { "type": "module" }, playground импортирует `../../../core/src/index.ts`. В документах нет ни слова о том, как ai-cyborg получит ядро (пакет, субмодуль, монорепо). См. P-02, P-03.

### 1.2. Модули core/src: назначение, цель SAD, FR, тесты

Тест указан по имени файла в core/test (или playground/...), если предмет совпадает; "прямого теста не нашёл" - только косвенное покрытие.

| Файл (строк) | Что делает | Цель SAD | FR-CH | Тесты |
|---|---|---|---|---|
| manifest.ts (395) | разбор манифеста до кода: поля, права, команды, сочетания, ui.views/overlay, documents, config/state, lock, host, activation; незнакомое поле - ошибка; при чужом API причина одна - версия | 3.2, 3.3 | 1001, 2001, 2004, 2012 | semver-manifest, loader, window, lifecycle |
| semver.ts (63) | версии и диапазоны (^, ~, префикс, *), allowsMajor | 3.3 | 1002, 1012 | semver-manifest |
| graph.ts (131) | граф requires/optional/consumes до запуска кода, циклы (Тарьян), порядок (Кан), каскад отказов, повтор id, engines | 3.2, 3.4 | 1002, 1004 | graph |
| registry.ts (125) | реестр контрактов: get/all/onChange, проверка объявленности и мажорной версии | 3.4, 4 | 2001 | registry |
| rpc.ts (127) | Endpoint запрос-ответ/уведомления, NotCloneable | 3.4, 4 п.5 | 2002 | rpc, untrusted-input |
| wire.ts (52) | parseWire для сообщений хоста, виды аргументов команд, own() | 4 п.10, 3.5 | 2004 | untrusted-input, trust |
| errors.ts (41) | CoreError, toWire/fromWire | 4 | - | rpc, untrusted-input |
| disposable.ts (63) | Disposable, DisposableStore (обратный порядок) | 3.2 | 1006 | прямого теста не нашёл; косвенно loader, stress-lifecycle |
| host-runtime.ts (699) | среда хоста: сборка ctx, прокси чужих контрактов, подписки/колбэки, секции config/state, ctx.os как RPC, события системы, слушатели pty/watch/serve | 3.4, 3.5, 3.7, 3.9 | 1005, 1006, 2001, 2002, 2007, 2008 | loader, subscriptions, trust, events, os |
| transports.ts (63), host-entry.ts (15) | inlineHosts (в процессе), forkHosts (fork) | 3.5 | 1005 | hosts, loader |
| loader.ts (1169) | load(): единое замыкание около 830 строк: разбор, граф, хосты, сторож, активация (в т.ч. ленивая), выгрузка/включение с каскадом, run команд, сочетания и plugins.keybindings, документы, память вида, диалоги/замок, события, beforeQuit, unload, setEnabled | 3.1, 3.2, 3.5, 3.8, 3.9 | 1001-1010, 1014, 2004-2006 | loader, lifecycle, events, hosts, trust, stress-*, window |
| status.ts (179) | состояние плагина по журналу, описания словами | 3.2, 3.5 | 1003, 1010 | status, playground/test/plugins-model |
| journal.ts (65) | ограничение (1000) и склейка повторов отказов | 3.7 | 1010 | journal |
| config.ts (172) | слои, resolveSection, migrate, SectionStore | 3.3, 3.10 | 2008 | config, stress-sections, loader |
| json-schema.ts (198) | подмножество JSON Schema | 3.3 | 2008 | json-schema |
| workspace.ts (370) | воркспейс: замок .lock с pid, ключ state от realpath, слои, перенос старого формата, слежение | 3.1, 3.10 | 1014, 2008 | workspace, stress-workspace |
| recent.ts (53) | "Недавние" (до 10, realpath) | 3.1 | 1014 | workspace, stress-workspace |
| permissions.ts (111) | разбор permissions и права словами | 3.7 | 2007, 2012 | os |
| via-contract.ts (65) | guard в provides | 3.7, 4 п.8 | 2007 | via-contract |
| os-gateway.ts (797) | шлюз ctx.os: fs (области, маски, realpath, защищённые пути), process (группы процессов), pty, net, env, notify, clipboard, secrets, shell, dialog/granted, security.roots, serve | 3.7 | 2007, 2014 | os, os-lifetime, security-gateway, via-contract, untrusted-input |
| serve.ts (128) | локальный HTTP на 127.0.0.1 (Host/Origin/размер/таймаут) | 3.7, 5 | 2007 | serve |
| pty.ts (289) | PtyTable: spawn/list/attach, хвост, билеты share, persist, park/detach | 3.6 | 1015 | pty, stress-pty, playground/.../view-terminals.test |
| window-layer.ts (186) | очередь диалогов, замок окна, команды окна F6/Shift+F6 | 3.8, 3.9 | 2006 | window |
| documents.ts (137) | таблица документов, restorable, лимиты | 3.8 | 2005 | documents |
| keys.ts (75) | нормализация сочетаний, keyOfInput | 3.9 | 2004 | lifecycle (сочетания) |
| ui-shell.ts (256) | UiContext поверх ViewBridge, connectView, терминалы вида, keepFocus, mountModule | 3.8 | 2005, NFR 2001 | ui-shell, window |
| elements-model.ts (112) + core/elements/elements.ts (450) | модель и DOM элементов cy-* | 3.8 | NFR 2001 | elements (только модель); DOM-часть только smoke |
| index.ts (22), plugin.ts (1) | публичный экспорт (export * почти из всех модулей) | - | - | - |

В ядре нет агента, сессий, файлов, проектов, трекеров, шины событий, inject. Поиск по core/src: предметные имена (projects, trackers, jira, lastProjectId) есть только в migrateLegacy в core/src/workspace.ts (строки 116-133) - зафиксированное исключение SAD 3.10 (см. T-02). core/src не импортирует Electron и не имеет npm-зависимостей (по импортам node:*), автоматического теста на это нет (T-05).

---

## 2. Статус по целям SAD 3.1-3.10 и разделам 4-6

| Цель | Статус | Подтверждение в коде | Что осталось | Расхождение с roadmap/SAD |
|---|---|---|---|---|
| 3.1 Воркспейс, Недавние, слои | сделано | workspace.ts, recent.ts; в playground requestSingleInstanceLock, --workspace=, --no-workspace (main.ts) | включение без перезапуска плагина вне графа (отложено владельцем); migrateLegacy с предметными именами в ядре | флаг в SAD/FR-1014 `--workspace <файл>`, в main.ts `--workspace=<файл>` |
| 3.2 Загрузка, журнал, безопасный режим, ленивая активация | сделано в ядре, не доведено в приложении | loader.ts (safeMode, activation lazy), graph.ts, status.ts | переключателя безопасного режима в playground нет (grep safeMode в playground/src пуст): FR-1009, ADR-0003 п.8, сценарий plugin-failure-isolated 6а это признают | roadmap ставит "-" |
| 3.3 Версии, migrate, схемы, @deprecated | частично | config.ts, json-schema.ts, manifest.ts, graph.ts | журнал @deprecated (нет и формы объявления: ядро не видит TS-типов); нет теста стабильности API (ADR-0002 п.3); PLUGIN_API_VERSION='1.0.0' определён в playground/src/main/plugins.ts, не в ядре | roadmap называет только @deprecated |
| 3.4 Реестр контрактов и команд | сделано | registry.ts, loader.ts (invoke, callAs, run), via-contract.ts | отмена запросов (вопрос 15); нет commands.onChange/списка команд | - |
| 3.5 Хосты и сторож | сделано с оговорками | loader.ts (startHost, hostDown), transports.ts, plugin-hosts.ts | замеры macOS (issue #2); в host-entry.ts и plugin-host.ts нет обработчиков uncaughtException/unhandledRejection (T-01, запуском не проверено) | в SAD у 3.5 нет пометки "Сделано в ядре", хотя roadmap определяет готовность через неё |
| 3.6 pty | частично | pty.ts, os-gateway.ts, билеты share, view-terminals.ts | pty-хост отдельным процессом (ADR-0012 п.4); вывод по MessagePort (п.5); льготное время сироты (п.6); Windows; хвост vs снимок (вопрос 14) | roadmap в таблице 1 пишет только "Windows", раздел 2 перечисляет ещё pty-хост и льготное время; SAD 6.1 числит pty-хост в "что входит" этапа 1 |
| 3.7 Безопасность, ctx.os, секреты | частично (этап 1 сделан, есть хвост) | os-gateway.ts, permissions.ts, serve.ts, os-env.ts | cyborg.secret-source (отложен); удаление плагина с зачисткой; задержка шлюза не мерилась; решение по fs.write+shell.openPath не принято; нет квот на pty/процессы; код стороннего плагина не изолирован (по замыслу этапа 1) | SAD 6.1 "грузятся только плагины из поставки", код и FR-1003 грузят каталог пользователя |
| 3.8 Рендер, iframe, элементы, диалоги, замок, документы, фокус | частично | ui-shell.ts, window-layer.ts, documents.ts, core/elements, playground views.ts/view-files.ts | род области и order (manifest.ts readUi знает только views и overlay); группы рендера (ui.group, plugins.uiGroups, origin по группе); CSP default-src 'none' и флаг инлайн-стилей; видимость при переключении вкладок; канал главная часть -> вид (сейчас долгий опрос в sessions); playground показывает только первый вид плагина | ADR-0007 (расхождения) утверждает, что roadmap считает 3.8 закрытой - устарело; в таблице 1 roadmap остаток 3.8 неполон |
| 3.9 Клавиши и события | сделано по манифесту; частично по API | keys.ts, loader.ts (bindKeys, applyUserKeys), events.test | ctx.keys.register с when и вклады в меню (вопрос 15); проверка клавиатурой на macOS (вопрос 11) | - |
| 3.10 config и state | сделано | config.ts, workspace.ts | config:reveal и копия повреждённого файла .corrupt-<время> (disputed #17) не решены; при битом файле ядро файл не трогает, копии нет | - |
| 4 Правила 1-10 | сделано | см. 3.4 | - | - |
| 4 Правило 11 | организационное, кода нет | ADR-0005 п.11: проверки нет | contributes.menus нет в TOP_LEVEL manifest.ts | - |
| 5 Базовая часть | частично | в playground: sessions, agent-claude-code, agent-shell, session-isolation, next-actions, pin-lock | files, viewer, projects, git, trackers, command-buttons, search как реальных плагинов нет (демо-заглушки в core/examples); контракты cyborg.sessions, cyborg.git, cyborg.tree-decoration, cyborg.project-settings, cyborg.secret-source в @cyborg/contracts не объявлены; sessions не поставляет cyborg.sessions (в манифесте только consumes) | SAD 5.1-5.2 описывают как существующее то, чего нет; это забота ai-cyborg/плагинов |
| cyborg.agent | сделано | contracts/agent.ts, agent-claude-code, agent-shell, playground/test/agents.test.ts | причины authRequired, rateLimited, resumeFailed объявлены, не выдаются; признак стабилизации не определён; второй настоящий агент (вопрос 13) | - |
| 5.3 Восстановление сессий | частично | документ session + sessions.restore | настройка sessions.restore, cwd/projectId; это поведение плагина | - |
| 5.4 pin-lock | демо | playground/plugins/pin-lock | в коде PIN 0000 зашит, нет scrypt/хранилища/config | SAD 5.4 описывает целевую реализацию |
| 6.1 Этап 1 | частично | см. выше | раздел 3 отчёта | "цели раздела 3 сделаны, кроме названного" верно только с учётом всех "Ещё нет" |
| 6.2 Этап 2 | не начато (по замыслу) | SpawnHost как точка замены среды хоста; тест дисциплины импортов | процесс на плагин, Compartment, окна согласия, установка | - |

Что roadmap называет "сделано", а в коде не так: (1) 3.2 "осталось: -" - нет переключателя безопасного режима; (2) 3.6 "осталось: Windows" - не сделан pty-хост и льготное время; (3) таблица 1 не называет группы рендера и строгую CSP как остаток 3.8; (4) определение "готово = пометка Сделано в SAD" - у 3.4, 3.5, 3.10 пометки нет. Обратных случаев (roadmap "осталось", а в коде уже есть) не нашёл.

---

## 3. Работа до состояния "микроядро готово к системе плагинов"

### 3.0. Предлагаемое определение готовности (моё предложение)

1. Цели 3.1-3.10 без "Ещё нет", кроме явно вынесенных (блок X, secret-source, включение без перезапуска).
2. В core/src нет предметных имён и npm-зависимостей - проверяет тест, а не ревью.
3. API плагина (PluginContext, UiContext, манифест, элементы cy-*) зафиксирован как 1.0: снимок API под тестом, справочник и руководство опубликованы.
4. ai-cyborg может подключить ядро и @cyborg/contracts без копирования файлов из playground: есть пакеты и пакет-адаптер Electron.
5. У автора плагина есть шаблон, сборка, тест-кит, проверка импортов/манифеста вне этого репозитория.
6. Бюджеты заданы числами и проверяются в CI; macOS подтверждён замерами и реальной клавиатурой.
7. Принята политика загрузки сторонних плагинов в этапе 1.
8. SAD и ADR приняты владельцем (сейчас review/proposed).

### 3.1. Решения, блокирующие реализацию (открытые вопросы SAD раздел 8 и смежные)

В SAD 16 пунктов (вопрос 16 решён, 7 и 11 закрыты частично).

| № | Вопрос | Состояние | Кто решает | Блокирует | Предложение |
|---|---|---|---|---|---|
| 1 | Просмотр файла: превью на месте терминала или вкладка | открыт | владелец | не ядро; влияет на состав областей в K-03 | как в Cyborg сейчас (превью) |
| 2 | Диапазоны order встроенных плагинов | открыт | автор | K-03 | шаг 100 в диапазоне 0-1000, резерв под поставку |
| 3 | Поля секций project-settings: в контракте или манифесте | открыт | автор | не ядро; "в манифесте" добавит поле в manifest.ts | решить с авторами projects/trackers |
| 4 | Связь сессии с проектом | открыт | автор | не ядро | - |
| 5 | Списки опасных флагов git/gh/glab/claude | открыт | автор + владелец | частично блокирует форму правил process/pty: сейчас только префикс аргументов (ruleRefusal), запретить флаг в середине нельзя | решить до API 1.0 (K-07) |
| 6 | Аннотация прав на членах: из типов или в манифесте | де-факто решён кодом (guard в provides) | автор подтверждает | K-06 | зафиксировать в SAD; для @deprecated взять ту же схему |
| 7 | Среда выполнения | хосты сделано; осталась совместимость ses с zod/marked | автор | только этап 2 (X-02) | вне ядра |
| 8 | Установка сторонних плагинов (источник, подпись/хеш, повторное согласие) | открыт | владелец | только этап 2 (X-04); косвенно P-06 | вне ядра |
| 9 | Бюджеты горячих путей | открыт; в disputed #16 предложение: шлюз p99 не больше 1 мс, вывод терминала не больше 16 мс | владелец (числа), автор (методика) | приёмка NFR-CH-1001, T-08, P-10 | принять числа disputed #16, замерить базу Cyborg |
| 10 | Общий набор тестов контрактов | открыт; есть только для cyborg.agent и привязан к списку PROVIDERS | автор | P-08 | вынести в тест-кит |
| 11 | Остаток спайка UI: клавиши на macOS, бросок файла ОС, Monaco на кастомной схеме, Monaco/xterm под sandbox, role copy/paste | частично | исполнитель замеров | K-05, приёмка 3.9 на macOS | T-09 |
| 12 | Windows в области этапа 1 | открыт | владелец | pty на Windows, CI-раннер, fs.watch, кнопки зависания (отключены на win32) | Windows вне v1, записать явно (CI проверяет macOS и Linux) |
| 13 | Второй настоящий агент для cyborg.agent (D-11) | открыт | владелец | стабилизация контракта (ADR-0004 п.7; признак не определён) | не блокирует ядро |
| 14 | Хвост pty или снимок состояния терминала | открыт, решает спайк с настоящим claude | автор (спайк) | K-01: формат backlog (строка) может смениться на снимок | спайк до K-01 |
| 15 | Форма API: contributes.menus, ctx.keys.register с условием, отмена запросов | открыт | автор + владелец | K-07, K-20, K-11 | главный блокер заморозки API |
| 16 | Владелец git | решён (плагин git, cyborg.git) | - | - | - |
| вне нумерации | Цепочка fs.write + shell.openPath (SAD 3.7, конец) | "решение не принято" | автор + владелец | K-16 | выбрать один из двух вариантов SAD |
| disputed #14 | Нужны ли сторонние плагины, какой второй агент | открыт | владелец | повод этапа 2, K-17 | - |
| disputed #15 | Трекеры: CLI или HTTP API | открыт | владелец | не ядро | оставить CLI |
| disputed #17 | path:open область shell, config:reveal, копия повреждённого файла, experimental_ | открыт | автор | K-18 | - |
| новый | Как ai-cyborg получает ядро и @cyborg/contracts; где живёт адаптер Electron | не поставлен | владелец + автор | P-01, P-02, P-03 | поставить в SAD |
| новый | Политика загрузки пользовательского каталога в этапе 1 (SAD 6.1 vs код) | не поставлен | владелец | K-17, P-04 | см. K-17 |
| приёмка | Статусы: SAD и ADR-0001..0008 review; ADR-0012 и ADR-0014 proposed (0012 решает центральную работу K-01) | ждёт владельца | владелец | старт K-01 | не начинать K-01 до принятия ADR-0012 |

### 3.2. Блок K: остаток ядра (этап 1)

K-01. Pty-хост отдельным процессом.
- Что: вынести PtyTable и PtyBackend из главного процесса в utilityProcess ядра со своим сторожем; вывод pty к виду по MessagePort (главный процесс раздаёт концы портов), ввод и размер обратно; API ctx.os.pty и ctx.terminal не менять; падение pty-хоста: владельцы получают завершение, хост перезапускается, запись в журнале.
- Места: core/src/pty.ts, core/src/os-gateway.ts (#ptyTable, openTerminal), core/src/transports.ts, playground/src/main/{os-env,view-terminals,plugin-hosts}.ts.
- Ссылки: SAD 3.6, разд. 1, разд. 9; ADR-CH-0012 п.4-5; FR-CH-1015 (текст требует главный процесс - переписать); disputed #1.
- Приёмка: (1) SIGSTOP pty-хоста не блокирует ввод/вывод в виде другого плагина и не замораживает окно (тест/smoke); (2) падение pty-хоста даёт onExit владельцам и запись host-down, новые spawn работают после перезапуска; (3) pty.test, stress-pty, view-terminals.test проходят без смены ожиданий API; (4) smoke зелёный на macOS и Linux; (5) поток 4 МиБ до вида не медленнее текущего.
- Размер: L. Зависимости: принятие ADR-0012; вопрос 14 до начала; P-03. Параллельно с K-03, K-06, K-09, T-*.

K-02. Льготное время осиротевшего pty.
- Что: настройка ядра (в LoadOptions); по истечении после падения хоста/выключения с оставлением pty persist без attach завершается; запись в журнале.
- Места: pty.ts (detach, park), loader.ts. Ссылки: SAD 3.6, ADR-0012 п.6.
- Приёмка: тест с подменой таймера: плагин не вернулся за T - процесс убит, журнал называет причину; вернувшийся до T - attach работает.
- Размер: S. Зависимости: нет (после K-01 переносится в pty-хост). Параллельно.

K-03. Род области, order и kind вида в манифесте.
- Что: расширить ui.views.<имя> формой с областью (боковая колонка, основная область, панель инструментов, всплывающий слой) и order, строка "./ui.js" остаётся краткой записью; то же для типов документов; ядро отдаёт упорядоченный снимок раскладки (Kernel.layout); playground перестаёт выбирать главный вид по имени (playground/src/renderer/plugins-panel.ts:63 `{ id: 'sessions', ... }`).
- Места: manifest.ts (readUi, TOP_LEVEL), loader.ts, contracts/*, playground renderer.
- Ссылки: SAD 3.8 (начало), вопросы 1-2; ADR-0007 п.1 (проверка "нет"); ADR-0001 расхождение 2; FR-CH-2005.
- Приёмка: неизвестная область - ошибка с именем поля; снимок сортирует по order, при равенстве по id (тест); в playground/src/renderer нет строковых имён плагинов (grep в тесте); манифесты без новой формы грузятся.
- Размер: M. Зависимости: вопрос 2; согласовать с K-04. Параллельно с K-06, K-09.

K-04. Группы рендера.
- Что: ui.group в манифесте, plugins.uiGroups в config (user/workspace, как plugins.hosts), origin cyborg-plugin://<группа>/, один процесс рендера на группу; сторонний по умолчанию в своей группе, запись group-isolated и предупреждение. В SAD нет описания, как мост узнаёт плагин внутри группы: senderPlugin(event) берёт плагин из origin (playground/src/main/views.ts), а права view:run/callAs "только свои команды" требуют знать плагин; нужно дописать (брать из пути/параметра адреса кадра, доверие только внутри группы).
- Места: manifest.ts, workspace.ts (pluginsOf), loader.ts, playground/src/main/{views,view-files,preload,main}.ts, playground/src/shared/views.ts.
- Ссылки: SAD 3.8, разд. 9; disputed #2; ADR-0007 п.2.
- Приёмка: два плагина одной группы делят процесс рендера (processId кадров/метрики), разных групп - нет; плагин группы не вызывает чужую команду подменой адреса вне группы (тест в духе view-files-security); сторонний в общей группе - предупреждение в PluginRow; память при 10 видах не хуже спайка.
- Размер: L (ядро M, адаптер M). Зависимости: K-03, P-03.

K-05. Строгая CSP и флаг инлайн-стилей.
- Что: VIEW_CSP (playground/src/main/view-files.ts) сейчас `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`; перейти на default-src 'none' с явными источниками, 'unsafe-inline' для стилей включать флагом манифеста (xterm/Monaco); worker-src для Monaco после проверки (вопрос 11).
- Места: view-files.ts, manifest.ts, view-files.test.ts. Ссылки: SAD 3.8 (CSP), ADR-0007 п.2, roadmap разд. 2-3.
- Приёмка: заголовок CSP зависит от флага (юнит-тест); sessions с xterm работает с флагом (smoke); вид без флага не применяет инлайн-стиль; запросы наружу и на чужие origin блокируются (smoke).
- Размер: M. Зависимости: вопрос 11, P-03. Параллельно с K-03.

K-06. Журнал вызовов @deprecated.
- Что: ядро не видит TS-типов; нужна форма объявления, например provides.<контракт>.deprecated: ["член"] рядом с guard; при invoke/callAs запись deprecated-call (вызывающий, контракт, член) со склейкой повторов как у denied; текст в describeEntry.
- Места: manifest.ts (readProvides), loader.ts (invoke, callAs), journal.ts, status.ts, contracts/README.md. Ссылки: SAD 3.3; ADR-0002 п.5; FR-CH-1012; вопрос 6.
- Приёмка: вызов помеченного члена пишет одну запись на пару (вызывающий, член) за окно склейки; непомеченного - ничего; запись видна словами в снимке окна.
- Размер: M. Зависимости: подтверждение вопроса 6. Параллельно с K-03.

K-07. Форма API: условные сочетания, вклады в меню, отмена запросов.
- Что: после решения вопроса 15 реализовать ctx.keys.register({ key, command, when }) с общим реестром конфликтов (включая акселераторы меню), contributes.menus в манифесте, идентификатор запроса и сообщение отмены в rpc.ts, доведённые до ctx.contracts и commands.run; при необходимости форма запрета аргументов в правилах process (вопрос 5).
- Места: rpc.ts, loader.ts, keys.ts, manifest.ts, host-runtime.ts, contracts/{plugin,view}.ts, окно playground (меню). Ссылки: SAD 3.9, разд. 4 правило 11, вопрос 15; disputed #10; ADR-0007 п.8.
- Приёмка: документ решения принят; регистрации снимаются при выгрузке и откате (тест как в lifecycle); конфликт динамического сочетания с манифестным виден в журнале; отмена: обработчик поставщика получает сигнал, вызывающий получает отказ, подписки не текут.
- Размер: L. Зависимости: ответ по вопросу 15; блокирует K-20.

K-08. Удаление плагина с зачисткой данных.
- Что: Kernel.uninstall(id) после disable: plugin-data/plugin-temp, секреты <id>/* (в SecretStore нет перечисления/удаления по префиксу - расширить интерфейс), $granted.byPlugin[id], $views (<id>/*), $documents, оставшиеся pty; решить судьбу разделов config/state.
- Места: loader.ts, os-gateway.ts (SecretStore, forget), documents.ts, config.ts, os-env.ts (fileSecrets). Ссылки: SAD 3.7 ("Удаления в ядре пока нет"), секреты; FR-CH-2014 ("Отложено"); roadmap разд. 2.
- Приёмка: после uninstall нет файлов в dataDir/<id>, нет ключей <id>/*, нет записей $granted/$views/$documents; новый плагин с тем же id ничего не наследует (тест); uninstall активного плагина отказывает или сначала выключает с вопросом о pty.
- Размер: M. Зависимости: нет. Желателен до выдачи ядра стороннему пользователю, нужен для этапа 2.

K-09. Переключатель безопасного режима в приложении.
- Что: startPlugins принимает safeMode, флаг --safe-mode и пункт в окне (в P-03 адаптере); ядро уже умеет.
- Места: playground/src/main/{main,plugins}.ts, renderer. Ссылки: FR-CH-1009 ("Ещё нет"), ADR-0003 расхождение 8, сценарий plugin-failure-isolated 6а, BR-CH-005.
- Приёмка: smoke: запуск с --safe-mode - ни один хост не стартовал, у каждого плагина запись safe-mode, lock.onStart не закрыл окно, управление плагинами доступно.
- Размер: S. Зависимости: нет. Параллельно.

K-10. Достаточность ctx.os для базовых плагинов.
- Что: сверить сценарии Cyborg (docs/research/cyborg-today.md разд. 4: дерево, просмотр, git, поиск, трекеры, расширения) с OsFs/process/net. В contracts/os.ts у fs: readText, list, stat, readSlice (текст), watch, writeText, mkdir, remove - нет двоичного чтения/записи (картинки), rename/copy/append, проверки существования без исключения; process.run до конца и со строками (нет потока stdout, двоичного вывода); net.fetch с текстовым телом. Решить, что добавлять в ядро по критерию компактности SAD разд. 2.
- Места: contracts/os.ts, os-gateway.ts, host-runtime.ts, permissions.ts. Ссылки: SAD 3.7 (таблица), разд. 2; FR-CH-2007.
- Приёмка: таблица "сценарий Cyborg -> вызовы ctx.os" без пробелов; каждый пробел закрыт (код + тест + права словами) либо отнесён к плагину/этапу 2.
- Размер: M. Зависимости: список функций от команды ai-cyborg. Нужно до K-20.

K-11. Канал главная часть -> вид и диалоги из главной части.
- Что: вид не получает толчков от плагина (комментарий в playground/plugins/sessions/index.ts:157, долгий опрос sessions.actions(билет, версия)); UiRemote в contracts/view.ts оставляет только методы, подписок нет. Добавить типизированный канал по имени вида в обе стороны с лимитом размера и снятием при выгрузке; решить, нужны ли dialogs и уведомления из главной части (headless-плагин вроде git не может спросить человека).
- Места: contracts/{plugin,view}.ts, ui-shell.ts, host-runtime.ts, loader.ts, preload/IPC адаптера. Ссылки: SAD 3.8, разд. 4 п.5; ADR-0007 п.3.
- Приёмка: sessions переведён с долгого опроса на канал (код опроса удалён), тест в ui-shell.test и smoke; сообщения доходят только до видов своего плагина; выгрузка закрывает каналы; превышение размера - Invalid.
- Размер: M. Зависимости: P-03; согласовать с K-07.

K-12. Квоты и пределы ресурсов.
- Что: нет ограничений на число pty на плагин, одновременных process.run, размер pty.write, число команд/контрактов/подписок. Уже есть: диалоги в очереди 8, документы 200, fs.watch 64, serve 4, тело serve 1 МиБ, net 16 МиБ, срез 1 МиБ, журнал отказов 1000. Значения в LoadOptions/OsEnvironment.
- Места: os-gateway.ts, pty.ts, loader.ts.
- Приёмка: тест на каждый предел: превышение - Invalid с причиной без утечки состояния; пределы описаны в contracts/README.md.
- Размер: S-M. Параллельно.

K-13. Пространство cyborg.* только для встроенных.
- Что: ADR-0002 п.6 не проверяется. Сторонний плагин из каталога пользователя может объявить provides для cyborg.* и при кратности one сделать встроенного потребителя ambiguous (граф отказывает потребителю). Проверка при разборе графа: контракт cyborg.* и id cyborg* допустимы только для плагинов из bundled.
- Места: graph.ts/loader.ts (bundled уже передаётся).
- Приёмка: сторонний плагин с provides { 'cyborg.agent': '1.0' } отвергается записью rejected; встроенные потребители не затронуты.
- Размер: S. Зависимости: нет.

K-14. Включение плагина вне графа без перезапуска: отложено владельцем, вне готового микроядра (нужно для установки, этап 2).

K-15. Источник секретов cyborg.secret-source: отложен владельцем до первого источника, вне готового микроядра; пока ссылка со схемой даёт Unavailable (ADR-0014). Вход: первый потребитель (Vault/1Password/pass); тогда нужны контракт в @cyborg/contracts, выбор по схеме, тест-кит (P-08).

K-16. Цепочка fs.write + shell.openPath.
- Что: принять одно из двух решений SAD 3.7 (запретить openPath в областях записи плагина либо перейти на разрешённый список типов документов) и реализовать в os-gateway.ts (shell.openPath, EXECUTABLE).
- Приёмка: плагин с fs.write и shell на одну область не может записать файл с расширением вне списка и открыть его; выбор отражён в правах словами.
- Размер: S-M. Зависимости: решение автора/владельца.

K-17. Политика загрузки плагинов из каталога пользователя в этапе 1.
- Что: SAD 6.1 "Загружаются только плагины из поставки", при этом SAD 3.5, FR-CH-1003, сценарий author-writes-plugin и код (discoverPlugins([builtinDir, userData/plugins])) грузят каталог пользователя. Такой код в этапе 1 может достать node:fs и обойти шлюз, проверка импортов его не касается (ADR-0003 расхождение 1; сценарий author-writes-plugin 4б). Решить: отключить по умолчанию (включать флагом разработчика), либо оставить с видимым предупреждением в окне и журнале, либо ограничить доверенным списком.
- Места: playground/src/main/plugins.ts (discoverPlugins) и адаптер, status.ts/describePermissions, SAD 6.1.
- Приёмка: политика зафиксирована в SAD и FR-CH-1003; тест поведения по умолчанию; плагин из каталога пользователя помечен в окне.
- Размер: S. Зависимости: решение владельца. Блокирует P-04.

K-18. Мелочи ядра из disputed #17: (а) область shell для открытия путей из вывода сессии; (б) команда ядра "показать файл воркспейса" вместо config:reveal; (в) копия повреждённого файла <файл>.corrupt-<время>; (г) судьба experimental_. Размер S-M. Приёмка: по каждой строке тест или явная запись "не делаем".

K-19. Задержка шлюза и бюджеты: см. T-08.

K-20. Заморозка API 1.0 (веха).
- Что: после K-03, K-06, K-07, K-10, K-11 снимок публичного API (PluginContext, UiContext, PluginPermissions, поля PluginManifest, теги cy-*, CoreErrorCode) под тестом (T-06), справочник (P-04), версии (P-01).
- Приёмка: изменение снимка без повышения версии роняет тест. Размер: S (после предшественников).

### 3.3. Блок T: технический долг, дефекты, пропущенные проверки

T-01. Падение хоста от необработанной ошибки вне вызова (по коду, запуском не подтверждено). В core/src/host-entry.ts и playground/src/main/plugin-host.ts нет process.on('uncaughtException'|'unhandledRejection') (поиск по core, playground/src, docs: обработчики только в тестах). Исключение в таймере или фоновом промисе плагина по умолчанию роняет процесс хоста; незавершённого вызова нет, culprits пуст, счёт идёт на хост (hostFailures), после трёх сбоев за окно - host-abandoned и выключение всех плагинов хоста. Для общего хоста builtin это значит, что ошибка одного встроенного плагина выключает соседей, что противоречит SAD 3.5 ("отказывает только этот плагин") и NFR-CH-1002. Сделать: обработчики в runHost/точках входа, атрибуция по стеку (путь модуля плагина), запись в журнал, политика (держать процесс, засчитать страйк плагину). Приёмка: тест forkHosts: плагин с setTimeout(() => { throw }) и с отклонённым промисом не роняет соседа по хосту; журнал называет плагин; три раза - выключен только он. M. Сначала воспроизвести.

T-02. Предметные имена в core/src/workspace.ts: migrateLegacy (projects, trackers, jira, lastProjectId, settings.projects) - единственное исключение критерия "нет предметной области"; SAD 3.10 обещает удалить. Вынести в хук приложения (openWorkspace({ migrate })), ядру оставить механизм "старый формат -> копия .v1.bak -> новый документ". Приёмка: grep core/src не находит projects|trackers|jira|lastProjectId (тест T-05); workspace.test проходит через хук. S. Зависимость: P-03.

T-03. Источник версии API: PLUGIN_API_VERSION='1.0.0' в playground/src/main/plugins.ts, у contracts/package.json версия 1.0.0 отдельно, у core версии нет. Одна константа в ядре, связка с версией пакета контрактов. S. Зависимость: P-01.

T-04. Демо-контракты в боевом пакете: contracts/index.ts содержит cyborg.files (две мажорные версии - пример миграции), cyborg.projects ({id,name,path} против SAD 5.2 {id,name,description,repos}), cyborg.lock, cyborg.tab. Это примеры из core/examples в закреплённом пространстве cyborg.*. Вынести в пакет примеров (по образцу playground/plugins/contracts.ts), в карте оставить реальные (cyborg.agent, cyborg.agent-tool, cyborg.session-prompt). Приёмка: core/test/contracts-types.ts и typecheck проходят; cyborg.projects в карте отсутствует или совпадает с SAD 5.2. S. Зависимость: P-01.

T-05. Тест чистоты ядра (ADR-0001 расхождение): (а) в core/src нет имён плагинов/предметных слов; (б) не импортирует electron, playground, плагины; (в) нет npm-зависимостей времени выполнения кроме @cyborg/contracts. Приёмка: core/test/purity.test.ts падает при добавлении import 'electron' или слова из списка. S. Зависимость: T-02.

T-06. Снимок API (ADR-0002 п.3): тест-снимок типов PluginContext/UiContext/PluginPermissions/полей манифеста/тегов cy-*, сверяемый с версией. M. K-20 использует.

T-07. Секрет не попадает в журнал (ADR-0014 п.4): тест, что строка секрета не встречается в journal, describeEntry, onLog после secrets.resolve, net.fetch с секретным заголовком, отказов правил. S.

T-08. Задержка шлюза ctx.os на горячих путях (вопрос 9, NFR-CH-1001): цена RPC измерена (spike-hosts.md), шлюза нет. Замер fs.readText, fs.watch, pty.write, secrets.get, net.fetch (локальный сервер), p50/p95/p99 при 64 Б - 64 КиБ. Приёмка: таблица в docs/05-verification и CI-проверка бюджета (P-10). S-M. Зависимость: числа бюджета.

T-09. macOS: хосты, фреймы, клавиши, drag. Linux мерился в репозитории, macOS только в ресёрче-2 (M1: 15 МБ на хост, 70-100 мс, другая метрика); issue #2. Повторить npm run spike и spike:hosts, проверить before-input-event на настоящей клавиатуре при фокусе во фрейме, startDrag (блокирующий ли на macOS), role copy/paste. M. Нужен исполнитель с macOS. Закрывает вопрос 11 частично.

T-10. Разбиение loader.ts: load() - замыкание около 830 строк в файле 1169; состояние (хосты, подписки, страйки, ожидающие, документы, диалоги) смешано. Не блокирует готовность, но осложнит K-01, K-04, K-07. Разбить на host-pool, activation, lifecycle, keybindings, views-state без смены поведения. Приёмка: все тесты без правок ожиданий; публичный Kernel неизменен. M-L. Делать до K-04/K-07 (не параллельно с ними - конфликты в одном файле).

T-11. Публичный экспорт ядра: core/src/index.ts почти целиком export *; playground иногда обходит индекс (../../../core/src/manifest.ts, window-layer.ts, recent.ts). Определить публичный API для встраивающего приложения и скрыть остальное. S-M. Зависимости: P-02, P-03.

T-12. Playground показывает только первый вид плагина (PluginRow.view - один адрес в plugins.ts snapshot), манифест допускает несколько ui.views. Адаптер для ai-cyborg должен поддерживать несколько видов. S (в рамках P-03).

T-13. Гигиена: (а) core/src/loader.ts стр. 129 осиротевший комментарий "Граф решён, код плагинов ещё не запускался." перед полем platform; (б) host-runtime.ts стр. 62 комментарий про ctx.os прилип к классу HostPtys; (в) pty.ts комментарий "pty всех плагинов..." над Tail, а не над PtyTable; (г) core/examples/run.ts печатает `npm run core:demo`, скрипт называется demo; (д) неотслеживаемый smoke-diag.mjs; (е) журнал в loader.ts неограничен для записей кроме denied (мелочь). S.

T-14. cyborg.agent: причины выхода authRequired, rateLimited, resumeFailed не выдаются (ADR-0004 расхождение 5); признак стабилизации контракта не определён (п.7). Зрелость контракта, не ядра. M (плагин). Вне готовности ядра.

T-15. Загрузка .ts/.js плагинов из каталога пользователя вне репозитория (не проверено). Хост импортирует index.mjs/js/ts (ENTRY_FILES в plugins.ts) через import(): .ts работает за счёт снятия типов Node 24 (ограничения erasableSyntaxOnly - нет enum и параметров-свойств - автору плагина нигде не сказаны, только CLAUDE.md репозитория), .js без "type":"module" в предках зависит от определения типа модуля (playground/plugins/package.json существует именно для этого), поведение внутри asar и в node_modules не проверено. Нужна проверка упакованной сборки и инструкция автору. M. Зависимости: P-05, P-06.

T-16. Windows: fs.watch каталога в workspace.ts, killGroup (ветка win32), pty, кнопки зависания (отключены), пути ~. Работы нет, пока не решён вопрос 12; L, если будут поддерживать.

### 3.4. Блок P: процессы, дистрибуция, документация, CI

P-01. Версионирование и публикация @cyborg/contracts.
- Что: сейчас private:true, types: ./index.ts, версия 1.0.0 ни с чем не связана. Определить канал (GitHub Packages/npm приватный/git-зависимость), semver-политику пакета (мажор пакета и мажор контракта - разные вещи), CHANGELOG, exports со сборкой .d.ts (потребителю не нужны TS-исходники с allowImportingTsExtensions), проверку совместимости в PR (T-06), примечание в README, что стороннее declare module дополняет карту.
- Ссылки: SAD 3.3 (владение cyborg.*), ADR-0002 п.6, FR-CH-1013; в roadmap нет.
- Приёмка: ai-cyborg и стороннее демо ставят пакет по номеру версии и собирают плагин; релиз выпускается по тегу workflow'ом (P-10); изменение карты без повышения версии роняет CI.
- Размер: M. Зависимости: решение владельца о канале, T-03, T-04, T-06. Параллельно с P-02.

P-02. Ядро как пакет для ai-cyborg.
- Что: core/package.json без имени/версии/exports; нужен пакет (рабочее имя @cyborg/core) с ESM-сборкой (js + d.ts), engines.node (Node 24; Electron 45 несёт Node 24 - версию Electron в ai-cyborg не проверял), точкой входа без core/elements DOM. Альтернатива - субмодуль или перенос исходников; решение владельца.
- Приёмка: пустой проект с import { load } from '@cyborg/core' собирается и запускает сценарий core/examples; playground переведён на импорт пакета.
- Размер: M-L. Зависимости: новый вопрос о поставке, T-11.

P-03. Адаптер Electron как пакет (embedder).
- Что: вынести из playground/src/main в пакет (рабочее имя @cyborg/electron): utilityHosts и точка входа хоста, electronOs (safeStorage, node-pty, shell, dialog, clipboard, notify), registerViewScheme/serveViews/resolveViewRequest и оболочку (ui-shell.ts + renderer/shell), preload-мост (каналы view:*), PluginsService, перехват клавиш before-input-event, перенос фокуса, RecentWorkspaces, одиночный экземпляр, события питания/окна. Окно playground остаётся примером. Описать ответственность: что обязано сделать приложение (раскладка по областям, меню, уведомления), что даёт пакет.
- Места: playground/src/main/*, src/renderer/*, src/shared/*, scripts/build.mjs.
- Приёмка: playground собирается поверх пакета без дублирования (остаётся раскладка окна); smoke зелёный; в пакете нет импортов из playground; README адаптера с минимальным примером "окно + ядро".
- Размер: L. Зависимости: P-02; предшествует адаптерным частям K-01, K-04, K-05, K-09, K-11. Новый вопрос о месте жизни.

P-04. Документация для авторов плагинов.
- Что: сейчас доступны сценарий author-writes-plugin (без кода), contracts/README.md (плотный справочник), SAD. Нужно: (1) руководство "первый плагин за 15 минут"; (2) справочник ctx.* и UiContext, генерируемый из TSDoc; (3) справочник манифеста + JSON Schema манифеста (ключ $schema манифест принимает, самой схемы в репозитории нет - проверено поиском); (4) жизненный цикл: порядок активации, deactivate, activationTimeout 10 с, migrate, onBeforeQuit, падение хоста; (5) рецепты прав ($SHELL с закреплённым скриптом, guard, config:); (6) правила хоста: синхронная работа дольше 1 с недопустима (spike-hosts.md), клонируемые данные; (7) ограничения стриппинга типов (T-15); (8) отладка (журнал, ctx.log, консоль хоста и вида); (9) упаковка и распространение (P-06); (10) честная граница этапа 1 (код не изолирован).
- Приёмка: человек, не участвовавший в разработке, по документу за один заход собирает и запускает плагин с видом, командой, контрактом и разделом config; ссылки проверяет CI (P-10).
- Размер: M-L. Зависимости: K-17, K-20.

P-05. Шаблон плагина и минимальный пример.
- Что: каталог templates/plugin или генератор (manifest, index.ts, ui/ui.ts, config.schema.json, тест, сборка, tsconfig); минимальный пример без домена. Сегодняшние примеры - либо демо ядра на вымышленных контрактах, либо реальные плагины на 10 КБ кода.
- Приёмка: шаблон проходит lint/typecheck/test/build в CI и загружается ядром (smoke-подобный тест на forkHosts). S-M. Зависимости: P-06, P-08.

P-06. Сборка и упаковка плагинов.
- Что: playground/scripts/build.mjs копирует плагины как .ts и собирает только ui/*.ts в ESM; главная часть грузится как есть. Нет: бандла главной части (плагин с zod/marked без бандла не загрузится, на этапе 2 сканер ses отвергает часть бандлов), сборки видов за пределами репозитория, формата поставки плагина (каталог/архив), проверки состава (manifest, entry, схемы, модули ui существуют), связи версии плагина с engines.cyborg. Инструмент cyborg-plugin build|check|pack.
- Приёмка: плагин с npm-зависимостью собирается в каталог manifest.json + index.mjs + ui/*.js, грузится ядром в forkHosts и в Electron; check падает на запрещённом импорте и на ссылке на отсутствующий файл.
- Размер: M-L. Зависимости: формат распространения (вопрос 8 частично), P-09.

P-07. Загрузка из каталога поставки.
- Что: bundled сейчас = "найден в builtinDir" (startPlugins), точка входа угадывается по именам файлов (ENTRY_FILES), manifest.json обязателен. Нужно: явная точка входа (поле main или закреплённое соглашение), сборка поставки (копирование/бандл/asar), контрольные суммы поставки (подготовка к этапу 2), тест "поставка Cyborg = N плагинов, все активны".
- Приёмка: упакованное приложение (asar, подпись macOS) запускает встроенные плагины; сторонний с тем же id отвергается; bundled не зависит от угадывания.
- Размер: M. Зависимости: P-03, P-06, T-15.

P-08. Тест-кит для авторов и набор тестов контрактов.
- Что: утилиты, которые лежат в тестах репозитория: inlineHosts/forkHosts (экспортируются), fakePty (core/test/fake-pty.ts, не экспортируется), память для SectionStore, setup() из playground/test/agents.test.ts. Опубликовать @cyborg/testing: startKernel({ plugins, os }), поддельные OsEnvironment/pty/секреты, ожидание журнала. Общий набор тестов контракта (вопрос 10): agentContractSuite(provider) из agents.test.ts; заготовки для cyborg.secret-source, cyborg.project-settings.
- Приёмка: agent-claude-code и agent-shell проходят agentContractSuite из пакета; сторонний пример проходит свой тест по документу.
- Размер: M. Зависимости: P-02. Параллельно с P-05.

P-09. Проверка плагина вне репозитория: violations() из core/test/plugin-imports.test.ts экспортирована из теста и привязана к PLUGIN_ROOTS репозитория. Сделать checkPlugin(dir)/CLI: манифест (parseManifest + engines), импорты (только @cyborg/contracts, свой пакет контрактов, свои модули; виду - npm), права словами. S-M. Зависимость: P-02. Нужен для P-06.

P-10. CI и релизы.
- Сейчас: один workflow (macOS и ubuntu-24.04, действия закреплены по SHA, timeout 15 мин). Нет: релизного workflow, dependabot/аудита, проверки ссылок документации, замеров производительности, Windows-раннера. Работы: (а) релиз пакетов по тегу (P-01..P-03); (б) задание замеров бюджета (T-08, spike:hosts) с порогами; (в) ссылочный чекер для docs/ (20+ перекрёстных ссылок и якорей); (г) npm audit/dependabot; (д) Windows - после вопроса 12; (е) кэш electron-rebuild (postinstall `electron-rebuild -f -w node-pty` требует нативной сборки).
- Приёмка: тег публикует пакеты; PR с падением бюджета красный; битая ссылка в docs красная. M. Зависимости: P-01..P-03, вопрос 9.

P-11. Приёмка документов: перевести SAD и ADR из review/proposed в принятые после правок раздела 5. S + время владельца.

### 3.5. Блок X: этап 2

Вывод: НЕ входит в "готовое микроядро". Обоснование: SAD 6.2 привязывает этап к поводу (плагин от автора вне команды или каталог плагинов), disputed #14 без ответа владельца, вопрос 8 открыт; этап 1 сохраняет путь (SpawnHost, тест дисциплины импортов, клонирование вызовов). Три дешёвые страховки входят в готовое ядро: K-13 (cyborg.* только для встроенных), K-17 (политика пользовательского каталога), P-06 (бандл главной части, без которого переход под ses сломается).

| ID | Работа | Размер | Ссылки | Условие входа |
|---|---|---|---|---|
| X-01 | Процесс на плагин (Electron как Node) с --permission; сеть и окружение держит шлюз | L | SAD 6.2; ADR-0003 п.9; ресёрч-2 2.2 | повод этапа 2 |
| X-02 | Compartment (ses) вторым слоем; совместимость бандлов (zod, marked не проходят сканер), @endo/evasive-transform | L | вопрос 7; ресёрч-2 2.3 | X-01 |
| X-03 | Окна согласия теми же строками, что describePermissions | M | SAD 3.7, 6.2; сценарий third-party-install-permissions | X-01 |
| X-04 | Установка: источник, подпись/хеш, повторное согласие при расширении прав | L | вопрос 8; ресёрч-2 4.4 | решение владельца |
| X-05 | openat/O_NOFOLLOW против подмены компонента пути между realpath и операцией | M | SAD 3.7 "Известное ограничение"; FR-CH-2007 | X-01 |
| X-06 | Включение плагина вне графа без перезапуска (K-14), удаление (K-08) | M | roadmap | установка |

### 3.6. Порядок и параллельность

Волна 0 (решения, параллельно, без кода): принять ADR-0012/0014; ответы по вопросам 9, 12, 15, 2, 5; новые вопросы (поставка ядра, место адаптера, политика пользовательского каталога); спайк вопроса 14 (S-M).
Волна 1 (независимые, одновременно): K-09, K-02, K-12, K-13, K-16, T-01 (сначала воспроизвести), T-02, T-03, T-04, T-05, T-07, T-13, T-09, T-08, P-05 (черновик), P-04 (каркас), P-11.
Волна 2: P-01, P-02, затем P-03; K-03, K-06, K-08, K-10 (анализ), K-17, T-10 (до K-04/K-07), P-08, P-09.
Волна 3: K-11, K-05, K-04, K-01 (после ADR-0012, вопроса 14, P-03), K-07 (после ответа 15), P-06, P-07.
Волна 4: K-20, T-06, P-04 (полная), P-10, проверка критериев 3.0.
Критический путь: решение о поставке (P-02/P-03) -> K-03/K-04/K-11 -> K-07 (ждёт вопрос 15) -> K-20. Самые долгие независимые: K-01 (L), K-04 (L), K-07 (L).

---

## 4. Что нужно именно для "системы плагинов": поверхность автора и пробелы

### 4.1. Манифест (core/src/manifest.ts)

| Поле | Есть | Пробел |
|---|---|---|
| id, version, engines.cyborg | да | нет name/description/author/homepage/иконки (для списка плагинов и каталога) |
| provides (+guard), requires, optional, consumes | да | нет deprecated (K-06) |
| commands (схема аргументов), keybindings | да | нет when, нет contributes.menus (K-07) |
| permissions | да, 14 прав | нет формы запрета аргументов (вопрос 5) |
| config/state (version, schema) | да | JSON Schema манифеста для редактора отсутствует |
| ui.views, ui.overlay, documents, lock, activation, host | да | нет ui.group, области, order (K-03, K-04), флага инлайн-стилей (K-05) |
| точка входа | поля нет: хост угадывает index.mjs/js/ts рядом с manifest.json | поле main или соглашение (P-07) |
| $schema | принимается | самой схемы нет |

### 4.2. Главная часть: PluginContext (contracts/plugin.ts) и ctx.os (contracts/os.ts)

| Член | Есть | Пробел |
|---|---|---|
| pluginId, subscriptions, log(message) | да | log без уровней и структуры |
| contracts.provide/get/all/onChange | да | нет отмены запроса (K-07) |
| commands.register/run | да | нет list/onChange |
| config, state (PluginSection, опциональные) | да | get() возвращает Record<string, unknown>, обобщения нет (пример SAD 5.4 get<LockConfig>() не компилируется) |
| secrets.resolve, os.secrets | да | для схем - Unavailable (K-15) |
| window.onFocusChange, system.*, documents.* | да | - |
| os.fs, process, pty, net, env, notify, clipboard, shell, dialog, serve, security, ui.lock | да | fs только текст, нет rename/copy/append/exists; process без потока и бинарных данных; net без потока (K-10) |
| диалоги, уведомления, канал к видам из главной части | нет | K-11 |

### 4.3. Вид: UiContext (contracts/view.ts)

Есть: commands.run (только свои), contracts.get (только методы, ответ - данные), theme, visible/onVisibilityChange, logs/onLog, terminal.open(ticket), state (до 64 КБ), dialogs.show (ask/menu), keys.of, drag. Нет: подписок на события контракта (весь push идёт долгим опросом), documents (ADR-0007 п.3 включает их в UiContext, интерфейс не содержит), config, канала к главной части (K-11). Элементов cy-* семь (cy-button, cy-field, cy-list, cy-tree, cy-tabs, cy-empty, cy-spinner): нет таблицы, переключателя/чекбокса, выпадающего списка - набор минимальный по замыслу (SAD разд. 9).

### 4.4. Контракты

В @cyborg/contracts реальные: cyborg.agent, cyborg.agent-tool, cyborg.session-prompt; демо: cyborg.files, cyborg.projects, cyborg.lock, cyborg.tab (T-04). Названы в SAD, но не объявлены: cyborg.sessions, cyborg.git, cyborg.tree-decoration, cyborg.project-settings, cyborg.secret-source. Для микроядра обязательны механизм и правила; контракты предметной области объявляют владельцы плагинов (правило 11), но до появления реальных поставщиков их типы - работа команды ai-cyborg.

### 4.5. Жизненный цикл (реализован, единого документа нет)

Разбор манифестов -> граф -> раскладка по хостам -> активация по порядку графа (ленивая: по команде, сочетанию, показу вида, потребителю) -> секции (миграция, схема) -> activate(ctx) с таймаутом 10 с -> работа -> deactivate (тот же таймаут) -> снятие регистраций, подписок, наблюдений, серверов, диалогов, процессов; сторож: пинг 1 с, порог 5 с, 3 страйка за 10 минут. Автору эти числа не опубликованы.

### 4.6. Документация, пример, шаблон, тест-утилиты

См. P-04, P-05, P-06, P-08, P-09: ни одного из пяти нет в виде, пригодном для автора вне репозитория. Есть: contracts/README.md, сценарий автора, примеры внутри репозитория, playground/test/agents.test.ts как образец теста.

---

## 5. Противоречия и пробелы в документации

1. Загрузка сторонних плагинов. SAD 6.1: "Загружаются только плагины из поставки"; там же ниже, SAD 3.5, FR-CH-1003, сценарий author-writes-plugin и код (discoverPlugins) грузят каталог пользователя. См. K-17.
2. pty-хост. SAD разд. 1 (таблица процессов), 6.1 (входит в этап 1), ADR-0012 п.4 описывают его как существующий; FR-CH-1015 и код - pty в главном процессе; таблица 1 roadmap о нём молчит.
3. Roadmap vs SAD о "готово": у 3.4, 3.5, 3.10 нет пометки "Сделано"; OVERVIEW: "пометками «Сделано» у каждой цели".
4. ADR-0007, "Расхождения", п.1: "Дорожная карта цель 3.8 считает закрытой" - roadmap так не считает.
5. Origin по группам vs по id: SAD 3.8, ADR-0007 п.2, disputed #2 - группы; FR-CH-2005 в тексте требования всё ещё cyborg-plugin://<id>/.
6. Устаревшие предпосылки про ses: BRD разд. 7 ("не проверено, спайк до этапа 2"), one-pager ("Риски: ses может не заработать") - SAD вопрос 7 и ADR-0003 считают спайк сделанным (осталась совместимость бандлов).
7. ctx.security.setRoots (SAD 5.2) vs ctx.os.security.setRoots (код, contracts/os.ts).
8. UiContext и документы: ADR-0007 п.3 перечисляет документы, contracts/view.ts их не содержит.
9. SAD 5.4 (pin-lock) vs код: SAD - scrypt-хеш в ctx.os.secrets, раздел config, ctx.config.get<LockConfig>(); код - PIN 0000 зашит, config нет; PluginContext.config опционален и get() не обобщён.
10. Контракты SAD 5 vs пакет: SAD 5.2 Project { id, name, description, repos }, пакет Project { id, name, path }; cyborg.sessions и ещё 4 контракта в пакете нет; sessions в манифесте только consumes.
11. Нумерация открытых вопросов: SAD разд. 8 (1-16), sad2-disputed-points.md (1-17 с другим смыслом: 14 = сторонние плагины и второй агент, 15 = трекеры, 16 = бюджеты), sad2-validation.md разд. 6 (новые 12-17 с третьим смыслом: 15 = восстановление сессий, 17 = ProjectStore). Ссылка "вопрос 13" в disputed #4 ведёт на текст, которого нет в SAD. Roadmap использует нумерацию SAD.
12. Внешние артефакты без пометки в месте ссылки: src/main/sessions.ts:121, src/main/workspaces.ts, scripts/measure.mjs, FR-1015, FR-1029, FR-1033, FR-2014, FR-5006, FR-9001, FR-10007, FR-12001, static-guards, "P1"/"P5" (фазы снятого плана миграции); единственная оговорка - абзац в docs/README.md.
13. Имя "SAD2" осталось в имени файла sad2-disputed-points.md и текстах; в нём пункт 4 одновременно говорит, что requestSingleInstanceLock "не годится", и ниже (пересмотр), что playground им пользуется.
14. ADR: нет номеров 0006, 0009, 0010, 0011, 0013 (слиты/сняты; docs/research/comparison.md ссылается на несуществующий ADR-CH-0006); имена файлов устарели (ADR-CH-0005-extension-points.md - заголовок "Связь плагинов", ADR-CH-0007-ui-slots-and-commands.md - слотов нет); статусы смешаны (review и proposed).
15. BR-CH-005 требует безопасный режим: в ядре есть, в приложении переключателя нет (фиксирует только FR-CH-1009, BRD нет).
16. BR-CH-003 MOE считает требование выполненным на agent-shell (агент без следов); SAD вопрос 13 и ADR-0004 п.7 говорят, что настоящий второй агент нужен для стабилизации.
17. SAD 3.7, таблица прав не содержит launch, serve, security.roots (описаны ниже и в FR-CH-2007, contracts/README.md).
18. Манифест vs SAD: SAD 3.8 и ADR-0007 п.1 обещают в манифесте род области и order, SAD разд. 4 правило 11 - contributes.menus; TOP_LEVEL в manifest.ts их не знает (roadmap учтён только для области/order).
19. Дыра проекта групп рендера: мост узнаёт группу по origin и плагины группы "неразличимы", но права моста требуют знать плагин; решение внутри группы не описано (K-04).
20. "Ядро знает роды областей" (SAD 3.8) - на деле не знает, раскладка целиком в рендерере приложения (playground называет вид по имени); граница ядро/приложение для раскладки не описана.
21. Бюджеты: one-pager и BR-CH-007 заявляют меру "в бюджете" при незаданных числах (вопрос 9) - мера непроверяема. Замеры с двух платформ (Linux в репозитории, macOS в ресёрче-2, разные метрики PSS и footprint) не сведены.
22. CLI: SAD 3.1 и FR-CH-1014 `--workspace <файл>`, код `--workspace=<файл>`; core/examples/run.ts печатает `npm run core:demo`, скрипт demo.
23. Шапки: roadmap `date: 2026-11-05` при содержании от 2026-11-06; во всех документах `quality-checks: входных записей нет`.
24. Отсутствует вовсе: способ поставки ядра в ai-cyborg; описание embedder-слоя; справочник API для автора; требуемые версии Node/Electron (Node 24 со снятием типов, process.parentPort); политика поддержки платформ.

---

## 6. Риски

| Риск | Откуда | Влияние | Мера |
|---|---|---|---|
| Ошибка встроенного плагина вне вызова роняет общий хост builtin и после трёх сбоев выключает всех встроенных | T-01 (не подтверждено запуском) | потеря рабочего места | T-01; до исправления делить встроенные на несколько хостов |
| Ядро не оформлено как продукт для ai-cyborg (нет пакета ядра, адаптера, версии) | P-01..P-03 | перенос превратится в копирование playground; расхождение версий | решение владельца о поставке в волне 0 |
| API заморозят до решения вопроса 15 | K-07, K-20 | либо ломающие изменения после выхода, либо обходные пути (как долгий опрос в sessions) | не объявлять 1.0 до K-07; поставить вопрос владельцу сейчас |
| Код стороннего плагина в этапе 1 не изолирован, а каталог пользователя грузится | K-17 | плагин может require('node:fs'); provides cyborg.* отказывает встроенным (K-13) | политика, предупреждение, K-13 |
| pty в главном процессе: node-pty может заморозить окно | ADR-0012, SAD разд. 9 | потеря сессий агентов | K-01, принять ADR-0012 |
| Бюджеты не заданы | вопрос 9 | спор на приёмке, незаметные регрессии | числа disputed #16 + T-08 + CI |
| macOS не проверен (клавиши во фрейме, drag, замеры) при разработке и CI на macOS | вопрос 11, issue #2 | before-input-event во фрейме на macOS мог не гасить сочетание; startDrag мог вернуться сразу | T-09 до заморозки API |
| Формат хвоста pty (строка) может смениться на снимок | вопрос 14 | смена PtyHandle.backlog после K-01 | спайк до K-01 |
| Плагины с npm-зависимостями не загрузятся (нет бандла главной части); на этапе 2 сканер ses отвергнет часть бандлов | P-06, ресёрч-2 2.3 | авторы упираются в первую же зависимость | P-06, проверка zod/marked заранее |
| Упаковка (asar, подпись, нативный node-pty, снятие типов для .ts) не проверена | T-15, P-07 | собранный пакет не запускает плагины | проверить упакованную сборку до объявления готовности |
| loader.ts как единое замыкание замедляет K-01, K-04, K-07 | T-10 | конфликты правок, регрессии | разбить до волны 3 |
| Секреты на Linux без keyring недоступны; fileSecrets хранит зашифрованные значения в secrets.json | ADR-0014, os-env.ts | интеграции без секретов на части машин | документировать |
| Нет квот на pty/процессы | K-12 | плагин исчерпывает ресурсы машины | K-12 |
| Все документы review/proposed, решения составителя не приняты | шапки | решения могут быть пересмотрены после начала работ | P-11, волна 0 |
| Оценки основаны на тестах, которые я не запускал; 38 коммитов за три дня одной линией | метод отчёта | оценки могут быть оптимистичны | перед стартом прогнать npm test, typecheck, lint, smoke на чистой машине |

---

## 7. Что не удалось проверить

- Результаты npm test, typecheck, lint, build, smoke: не запускались по условию задачи.
- Поведение T-01 подтверждено чтением кода (нет обработчиков), не воспроизведено.
- Совместимость с Electron/Node в ai-cyborg; состояние ai-cyborg; issue #2 и PR #1/#3 на GitHub.
- os-gateway.ts прочитан выборочно (около 40%), serve.ts, json-schema.ts, elements-model.ts, elements.ts и renderer - по заголовкам; возможны дефекты, не отражённые здесь.
- Загрузка .js/.ts плагинов вне репозитория и из asar.
- Windows целиком.