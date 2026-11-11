## Цель

Cyborg Harness - микроядро для настольных приложений на плагинах: ядро не знает предметной области, агент, сессии, файлы, проекты и трекеры - равные плагины на одном API, а поставка приложения - список встроенных плагинов. Первый потребитель - Cyborg, рабочее место с несколькими сессиями агентов (docs/00-strategy/IDEA-01-cyborg-harness.md). Продукт репозитория - ядро `core/` и контракты `contracts/`.

Плагины в `playground/plugins`, базовые тоже, - исключительно для проверки, пилота и демонстрации ядра: ими проверяют API и контракты, замеряют и показывают ядро вживую. Продуктом они не являются. Что должен соблюдать любой плагин, закрепляется в ядре и контрактах, а не только в плагине стенда.

## Сборка и гейты

- Сборка - `npm run build` (playground в `playground/dist`); перед ним, `typecheck`, `lint` и `test` сама идёт `npm run build:packages` (`build:core` - пакет ядра в `core/dist`, `build:testing` - тест-кит в `testing/dist`, `build:electron` - адаптер Electron в `electron/dist`, `build:tools` - `cyborg-plugin` в `tools/cyborg-plugin/dist`)
- Проверка типов - `npm run typecheck` (строгий tsconfig; TS 7 из алиаса `typescript7`, а `typescript` - TS 6 под API typescript-eslint, поэтому `npx tsc` - не тот компилятор)
- Линтер - `npm run lint` (ESLint с strictTypeChecked по процессу на пакет, `scripts/lint.mjs`; ноль предупреждений; отключение правила - только директивой с `-- причина`)
- Тесты - `npm test` (node --test, Node 24 снимает типы сам); подделки сообщений хоста - `core/test/trust.test.ts`; снимок API плагина - `core/test/api-snapshot.test.ts`, эталон `core/test/api-snapshot/<версия>.txt`, обновление `npm run snapshot:api` (правила - `contracts/README.md`)
- Дымовой тест окна - `npm run smoke` (нужен дисплей; на Linux `xvfb-run`)
- CI - `.github/workflows/ci.yml`: сборка, типы, линтер, тесты и smoke на macOS и Linux

## Карта

- `docs/` - проект Cyborg Harness: ресёрч, BRD продукта, SRS и истории с критериями приёмки фич (`CH-`), сценарии (`UC-{ФИЧА}-NNNN`), SAD и ADR-CH, замеры хостов и фреймов, дорожная карта; вход - docs/README.md
- `core/` - ядро плагинов по SAD без зависимостей: загрузчик, граф контрактов, хосты со сторожем, журнал и состояние плагинов; тесты `core/test`, сценарии `core/examples`
- `contracts/` - пакет объявлений `@cyborg-harness/contracts`: карта контрактов имя -> мажорная версия -> тип; правила и пример - `contracts/README.md`, проверки компилятора - `core/test/contracts-types.ts`
- `electron/` - пакет адаптера `@cyborg-harness/electron`: всё, что связывает ядро с Electron (служба PluginsService, хосты в utilityProcess и вход хоста, среда ctx.os, схема cyborg-plugin и мост видов, каналы IPC, preload, слой окна, оболочка вида); граница «что даёт пакет, что делает приложение» и пример - `electron/README.md`, тесты `electron/test`
- `testing/` - тест-кит автора плагина `@cyborg-harness/testing` поверх пакета ядра: `startKernel`, `fakePty`, память слоёв и секретов, `agentContractSuite`; тесты `testing/test`, сборка `npm run build:testing`
- `tools/cyborg-plugin/` - пакет `cyborg-plugin` (инструмент автора плагина): `check`, `build` (бандл главной части, сборка видов), `pack`; README пакета; стенд собирает им свои плагины
- `playground/` - Electron-приложение для проверки ядра вживую поверх адаптера: `src/main` (аргументы, воркспейс, окно, замер фреймов - spike), `src/renderer` (раскладка окна: сессия агента слева, справа вкладки плагинов, видов, документов, сообщений, журнала и клавиш; страница замера spike и пробный вид probe), `plugins/` (базовые sessions, agent-claude-code, agent-shell, session-isolation, session-notifications, next-actions, pin-lock; демо echo, chat, alice, bob, flaky, later; пробный editor с Monaco - пилот PL-05; trackers - пилот PL-07 (срез трекеров: `gh api`, `glab api`, `jira` пулом на 6 с тайм-аутом, пределом вывода и отменой; подставные программы - `scripts/fake-trackers.mjs`, `test/trackers-kit.ts`, тесты - `test/pilot-trackers.test.ts`, не включён в `DEFAULT_CONFIG`); files, git, viewer - пилот PL-04: дерево по событиям `fs.watch`, отметки git и открытие файла на трёх хостах, в `DEFAULT_CONFIG` не включены, тесты - `playground/test/pilot-*.test.ts`, замер на настоящих репозиториях - `npm run pilot:files`; код вида плагина - в его `ui/`), `scripts/` (build, smoke, pilot-files - замер PL-04, spike-iframe и spike-hosts - замеры фреймов и хостов, spike-monaco - пилот Monaco и xterm: наборы CSP, sandbox, память (общий запуск окна - cdp.mjs), xtest.py - настоящий ввод X11 для замера фреймов, fake-claude.mjs - подставной claude для smoke и пилота PL-01, pilot-sessions - замер PL-01: сессия `sessions` под нагрузкой на подставном claude, `npm run pilot:sessions`, smoke-session-load - шаг smoke с живым claude)
- `templates/plugin` - шаблон плагина для авторов (P-05): копируется в свой репозиторий; манифест, главная часть, контракт, схема `config`, вид, тест на `@cyborg-harness/testing`; проверяется в `npm run typecheck`, `lint`, `npm test` и отдельным шагом CI (`cyborg-plugin check`, `build`, `pack`)
- `site/` - сборка сайта документации (Astro и Starlight); страницы лежат в `docs/guide/`; `npm run build` и `npm run verify` внутри `site/`, публикация - `.github/workflows/docs-site.yml`

## Правила

- Ядро не импортирует Electron и ничего из playground; playground берёт ядро только как пакет `@cyborg-harness/core` (точки входа - `core/package.json`, `exports`; workspace, сборка `npm run build:core` в `core/dist`) и только публичными именами точек входа (перечень - `core/test/public-api.test.ts`, описание - `core/README.md`); окно не импортирует главный вход: он тянет `node:*`. Адаптер `electron/` не импортирует `playground/` и внутренности ядра (проверка - `electron/test/boundary.test.ts`), playground берёт адаптер только точками входа его `exports` (`electron/test/public-api.test.ts`); код, связывающий ядро с Electron, живёт в адаптере, а не в `playground/src/main`.
- Подделки для тестов (`fakePty`, память слоёв `memoryStore`, `memorySecrets`, `sandbox`) берутся из `@cyborg-harness/testing`, копий в тестах не заводить (держит `testing/test/package.test.ts`); в пакете нет импортов из playground.
- Импорты с расширением `.ts`: тесты идут на Node без сборки.
- Параметры-свойства конструктора и `enum` не писать: Node снимает только стираемый синтаксис (`erasableSyntaxOnly`).

## Запреты

- `node_modules/`, `playground/dist/`, `core/dist/`, `electron/dist/`, `package-lock.json` руками не править
