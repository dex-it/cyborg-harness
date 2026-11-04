## Сборка и гейты

- Сборка - `npm run build` (playground в `playground/dist`)
- Проверка типов - `npm run typecheck` (строгий tsconfig; TS 7 из алиаса `typescript7`, а `typescript` - TS 6 под API typescript-eslint, поэтому `npx tsc` - не тот компилятор)
- Линтер - `npm run lint` (ESLint с strictTypeChecked, ноль предупреждений; отключение правила - только директивой с `-- причина`)
- Тесты - `npm test` (node --test, Node 24 снимает типы сам); подделки сообщений хоста - `core/test/trust.test.ts`
- Дымовой тест окна - `npm run smoke` (нужен дисплей; на Linux `xvfb-run`)
- CI - `.github/workflows/ci.yml`: сборка, типы, линтер, тесты и smoke на macOS и Linux

## Карта

- `docs/` - проект Cyborg Harness: ресёрч, BRD и SRS фич (`CH-`), сценарии, SAD, SAD2 и ADR-CH, план паритета, дорожная карта; вход - docs/README.md
- `core/` - ядро плагинов по SAD2 без зависимостей: загрузчик, граф контрактов, хосты со сторожем, журнал и состояние плагинов; тесты `core/test`, сценарии `core/examples`
- `contracts/` - пакет объявлений `@cyborg/contracts`: карта контрактов имя -> мажорная версия -> тип; правила и пример - `contracts/README.md`, проверки компилятора - `core/test/contracts-types.ts`
- `playground/` - Electron-приложение для проверки ядра вживую: `src/main` (служба PluginsService, хосты в utilityProcess, процесс хоста), `src/renderer` (окно: плагины, клавиши, сообщения, журнал), `plugins/` (демо-плагины echo, chat, alice, bob, flaky), `scripts/` (build, smoke)

## Правила

- Ядро не импортирует Electron и ничего из playground; playground берёт ядро только через `core/src`.
- Импорты с расширением `.ts`: тесты идут на Node без сборки.
- Параметры-свойства конструктора и `enum` не писать: Node снимает только стираемый синтаксис (`erasableSyntaxOnly`).

## Запреты

- `node_modules/`, `playground/dist/`, `package-lock.json` руками не править
