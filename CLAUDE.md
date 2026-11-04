## Сборка и гейты

- Сборка - `npm run build` (playground в `playground/dist`)
- Проверка типов - `npm run typecheck`
- Тесты - `npm test` (node --test, Node 24 снимает типы сам)
- Дымовой тест окна - `npm run smoke` (нужен дисплей; на Linux `xvfb-run`)
- CI - `.github/workflows/ci.yml`: сборка, типы, тесты и smoke на macOS и Linux

## Карта

- `core/` - ядро плагинов (SAD2 в репозитории Cyborg) без зависимостей: загрузчик, граф контрактов, хосты со сторожем, журнал и состояние плагинов; тесты `core/test`, сценарии `core/examples`
- `playground/` - Electron-приложение для проверки ядра вживую: `src/main` (служба PluginsService, хосты в utilityProcess, процесс хоста), `src/renderer` (окно «Плагины Cyborg»), `plugins/` (демо-плагины), `scripts/` (build, smoke)

## Правила

- Ядро не импортирует Electron и ничего из playground; playground берёт ядро только через `core/src`.
- Импорты с расширением `.ts`: тесты идут на Node без сборки.
- Параметры-свойства конструктора и `enum` не писать: Node снимает только стираемый синтаксис (`erasableSyntaxOnly`).

## Запреты

- `node_modules/`, `playground/dist/`, `package-lock.json` руками не править
