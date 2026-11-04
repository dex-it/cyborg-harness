# Cyborg Harness

Ядро плагинов Cyborg и playground-приложение, на котором оно проверяется вживую. Проект перестройки, ресёрч, требования и архитектура — в [docs/](docs/README.md); общая архитектура ядра — [SAD2](docs/03-architecture/design/sad2.md).

- `core/` — ядро без зависимостей: манифесты, граф контрактов, хосты со сторожем, RPC, слои config, журнал и состояние плагинов. От Electron не зависит, тесты идут на Node 24.
- `contracts/` — `@cyborg/contracts`: типы контрактов по имени и мажорной версии, без логики. Как дополнять и полный пример — [contracts/README.md](contracts/README.md).
- `playground/` — Electron-приложение с одним окном «Плагины Cyborg»: хосты в `utilityProcess`, демо-плагины `echo`, `probe` и `flaky`, заглушка выключенного плагина с причиной, журнал и «Включить снова».

## Команды

| Команда | Что делает |
|---|---|
| `npm install` | ставит electron, esbuild, typescript |
| `npm start` | собирает и открывает playground |
| `npm test` | тесты ядра и playground (`node --test`) |
| `npm run typecheck` | типы ядра и playground |
| `npm run demo` | сценарии ядра в консоли, без Electron |
| `npm run smoke` | дымовой тест окна; на Linux — `xvfb-run --auto-servernum node playground/scripts/smoke.mjs --no-sandbox` после `npm run build` |

Данные playground лежат в своей папке (`~/.config/Cyborg Playground` на Linux): `cyborg.json` с включёнными плагинами и их хостами создаётся при первом запуске, свои плагины кладутся в `plugins/` рядом.
