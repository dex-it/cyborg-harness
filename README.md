# Cyborg Harness

Ядро плагинов Cyborg и playground-приложение, на котором оно проверяется вживую. Проект перестройки, ресёрч, требования и архитектура — в [docs/](docs/README.md); общая архитектура ядра — [SAD2](docs/03-architecture/design/sad2.md).

- `core/` — ядро без зависимостей: манифесты, граф контрактов, хосты со сторожем, RPC, слои config, журнал и состояние плагинов. От Electron не зависит, тесты идут на Node 24.
- `contracts/` — `@cyborg/contracts`: типы контрактов по имени и мажорной версии, без логики. Как дополнять и полный пример — [contracts/README.md](contracts/README.md).
- `playground/` — Electron-приложение, где ядро видно вживую. Хосты работают в `utilityProcess`. Демо-плагины:
  - `chat` — канал сообщений с подпиской;
  - `alice` — требует чат и шлёт ему сообщения;
  - `bob` — берёт чат и эхо как optional и отвечает через `echo`;
  - `flaky` — падает при первом запуске.

  В окне четыре панели:
  - «Плагины» — кнопки «Выгрузить» / «Загрузить», «Уронить хост», «Повесить хост», команды плагина, «Включить снова»;
  - «Клавиши» — перехват и конфликт сочетаний;
  - «Сообщения» — лента плагинов и нажатий;
  - «Журнал» ядра.

## Команды

| Команда | Что делает |
|---|---|
| `npm install` | ставит electron, esbuild, typescript |
| `npm start` | собирает и открывает playground |
| `npm test` | тесты ядра и playground (`node --test`) |
| `npm run typecheck` | типы ядра и playground |
| `npm run demo` | сценарии ядра в консоли, без Electron |
| `npm run smoke` | дымовой тест окна; на Linux — `xvfb-run --auto-servernum node playground/scripts/smoke.mjs --no-sandbox` после `npm run build` |

Что попробовать в окне: `Ctrl+Shift+A` (на macOS `Cmd+Shift+A`) — alice пишет bob, тот отвечает через эхо из другого процесса; `F2` занят и у `echo`, и у `bob`, побеждает `bob`; «Выгрузить» у `chat` снимает и `alice`, а `bob` продолжает работать без чата.

Данные playground лежат в своей папке (`~/.config/Cyborg Playground` на Linux): `cyborg.json` с включёнными плагинами и их хостами создаётся при первом запуске, свои плагины кладутся в `plugins/` рядом.
