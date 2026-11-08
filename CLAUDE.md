## Цель

Cyborg Harness - микроядро для настольных приложений на плагинах: ядро не знает предметной области, агент, сессии, файлы, проекты и трекеры - равные плагины на одном API, а поставка приложения - список встроенных плагинов. Первый потребитель - Cyborg, рабочее место с несколькими сессиями агентов (docs/00-strategy/one-pager.md). Продукт репозитория - ядро `core/` и контракты `contracts/`.

Плагины в `playground/plugins`, базовые тоже, - исключительно для проверки, пилота и демонстрации ядра: ими проверяют API и контракты, замеряют и показывают ядро вживую. Продуктом они не являются. Что должен соблюдать любой плагин, закрепляется в ядре и контрактах, а не только в плагине стенда.

## Сборка и гейты

- Сборка - `npm run build` (playground в `playground/dist`); перед ним, `typecheck`, `lint` и `test` сами идут `npm run build:core` (пакет ядра в `core/dist`) и `npm run build:electron` (адаптер Electron в `electron/dist`)
- Проверка типов - `npm run typecheck` (строгий tsconfig; TS 7 из алиаса `typescript7`, а `typescript` - TS 6 под API typescript-eslint, поэтому `npx tsc` - не тот компилятор)
- Линтер - `npm run lint` (ESLint с strictTypeChecked, ноль предупреждений; отключение правила - только директивой с `-- причина`)
- Тесты - `npm test` (node --test, Node 24 снимает типы сам); подделки сообщений хоста - `core/test/trust.test.ts`
- Дымовой тест окна - `npm run smoke` (нужен дисплей; на Linux `xvfb-run`)
- CI - `.github/workflows/ci.yml`: сборка, типы, линтер, тесты и smoke на macOS и Linux

## Карта

- `docs/` - проект Cyborg Harness: ресёрч, BRD и SRS фич (`CH-`), сценарии, SAD и ADR-CH, замеры хостов и фреймов, дорожная карта; вход - docs/README.md
- `core/` - ядро плагинов по SAD без зависимостей: загрузчик, граф контрактов, хосты со сторожем, журнал и состояние плагинов; тесты `core/test`, сценарии `core/examples`
- `contracts/` - пакет объявлений `@cyborg-harness/contracts`: карта контрактов имя -> мажорная версия -> тип; правила и пример - `contracts/README.md`, проверки компилятора - `core/test/contracts-types.ts`
- `electron/` - пакет адаптера `@cyborg-harness/electron`: всё, что связывает ядро с Electron (служба PluginsService, хосты в utilityProcess и вход хоста, среда ctx.os, схема cyborg-plugin и мост видов, каналы IPC, preload, слой окна, оболочка вида); граница «что даёт пакет, что делает приложение» и пример - `electron/README.md`, тесты `electron/test`
- `playground/` - Electron-приложение для проверки ядра вживую поверх адаптера: `src/main` (аргументы, воркспейс, окно, замер фреймов - spike), `src/renderer` (раскладка окна: сессия агента слева, справа вкладки плагинов, видов, документов, сообщений, журнала и клавиш; страница замера spike и пробный вид probe), `plugins/` (базовые sessions, agent-claude-code, agent-shell, session-isolation, next-actions, pin-lock; демо echo, chat, alice, bob, flaky, later; код вида плагина - в его `ui/`), `scripts/` (build, smoke, spike-iframe и spike-hosts - замеры фреймов и хостов, xtest.py - настоящий ввод X11 для замера фреймов, fake-claude.mjs - подставной claude для smoke)
- `site/` - сборка сайта документации (Astro и Starlight); страницы лежат в `docs/guide/`; `npm run build` и `npm run verify` внутри `site/`, публикация - `.github/workflows/docs-site.yml`

## Правила

- Ядро не импортирует Electron и ничего из playground; playground берёт ядро только как пакет `@cyborg-harness/core` (точки входа - `core/package.json`, `exports`; workspace, сборка `npm run build:core` в `core/dist`) и только публичными именами точек входа (перечень - `core/test/public-api.test.ts`, описание - `core/README.md`); окно не импортирует главный вход: он тянет `node:*`. Адаптер `electron/` не импортирует `playground/` и внутренности ядра (проверка - `electron/test/boundary.test.ts`), playground берёт адаптер только точками входа его `exports` (`electron/test/public-api.test.ts`); код, связывающий ядро с Electron, живёт в адаптере, а не в `playground/src/main`.
- Импорты с расширением `.ts`: тесты идут на Node без сборки.
- Параметры-свойства конструктора и `enum` не писать: Node снимает только стираемый синтаксис (`erasableSyntaxOnly`).

## Запреты

- `node_modules/`, `playground/dist/`, `core/dist/`, `electron/dist/`, `package-lock.json` руками не править
