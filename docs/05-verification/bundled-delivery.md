# Проверка поставки встроенных плагинов в упакованном приложении

Результат задачи [#43](https://github.com/dex-it/cyborg-harness/issues/43) (P-07), 2026-11-10. Устройство - [SAD, 3.2 и 6.1](../04-architecture/design/sad.md#61-этап-1-ядро-без-изоляции-доступа) («Поставка плагинов приложения»), норма - [FR-CH-1003](../03-requirements/01-plugin-host/srs.md#fr-ch-1003-обнаружение-и-состояния).

## Что проверялось и как

Упаковщика приложения в репозитории нет (выпуск пакетов - P-10, приложение Cyborg живёт вне репозитория), поэтому проверка идёт пробой `playground/scripts/pack-delivery.mjs` (`npm run pack:delivery`, шаг CI «упакованная поставка» на macOS и Linux). Проба не выпуск приложения, а повторение его существенных свойств из готового Electron и `@electron/asar`:

1. `npm run build` собирает `playground/dist/delivery`: плагины стенда бандлом `cyborg-plugin delivery` (`index.mjs`, виды, схемы) и `delivery.json` с sha256 всех файлов.
2. Проба кладёт код приложения и `delivery` в `app.asar`, `node-pty` - в `app.asar.unpacked` (`asarUnpack: **/node_modules/node-pty/**`), убирает `default_app.asar`. На macOS пакет подписывается ad hoc (`codesign --sign -`, сертификата Developer ID в пробе нет) и проверяется `codesign --verify --deep --strict`.
3. Упакованное приложение запускается с `--delivery` и `--user-plugins`; окно читается по DevTools Protocol, главный процесс - по инспектору.

Три сценария:

| Сценарий | Что утверждается |
|---|---|
| поставка в asar | главный процесс исполняется из `app.asar/main.js`; нативный `pty.node` лежит в `app.asar.unpacked`, а `node-pty` из `app.asar` в отдельном процессе упакованного Electron (режим Node) делает настоящий spawn в pty и получает вывод; все плагины каталога поставки (число берётся из `delivery.json`, не из текста пробы) в ожидаемом состоянии: `active`, ленивый `later` - `waiting`, демо `flaky` - `stopped` с причиной из кода плагина (значит, код выполнен из asar); у всех пометка `bundled`; «Не дошло до ядра» пусто |
| подмена | в `<userData>/plugins/echo` лежит плагин с `id` встроенного (версия 9.9.9) и `--user-plugins`; `echo` остаётся `bundled` и `active`, в «Не дошло до ядра» есть `повтор id echo`, код подмены в вывод хоста не попал |
| изменён файл поставки | asar дописать нельзя, поэтому приложение запускается исходным Electron из той же подготовленной папки без asar, в `delivery/echo/index.mjs` дописана строка; `echo` активен, в «Не дошло до ядра» строка `контрольная сумма поставки: echo/index.mjs: контрольная сумма не совпала (…)` |

## Результат на macOS

macOS 27.2, arm64, Electron 45.2.2, Node 24.20.0. Итог пробы: `ПРОЙДЕНО`, код возврата 0, около 7 с.

```
pack-delivery: app.asar: app.asar, app.asar.unpacked
pack-delivery: codesign --verify --deep --strict: подпись ad hoc цела
pack-delivery: главный процесс: {"main":".../Cyborg Playground.app/Contents/Resources/app.asar/main.js",...,"packed":true}
pack-delivery: node-pty из app.asar: spawn в pty отдал «из-asar», pty.node распакован: app.asar.unpacked/node_modules/node-pty/build/Release/pty.node
  flaky: stopped · agent-claude-code, agent-shell, alice, bob, chat, echo, editor, next-actions, panels, pin-lock, session-isolation, sessions: active · later: waiting
pack-delivery: подмена встроенного из каталога пользователя: echo: bundled, active; подмена отвергнута, её код не выполнялся
pack-delivery: изменён файл поставки: контрольная сумма поставки: echo/index.mjs: контрольная сумма не совпала (в delivery.json 1e691cebd014, на диске 8eb6a682b172)
pack-delivery: ПРОЙДЕНО
```

Из 14 плагинов поставки 12 активны, один ждёт вызова, один остановлен по замыслу демо; хосты поднялись в процессах из asar (`builtin`, `agents`, `a`, `b`, `c`). Каждый плагин поставки загружен по `index.mjs`.

Что это снимает из рисков задачи: `import()` ES-модуля из asar работает (все плагины поставки - `.mjs` из asar); `utilityProcess.fork` точки входа в asar работает (хосты поднялись); подпись ad hoc пакета с asar и распакованным `node-pty` не ломается и проверяется `--deep --strict`.

## Linux

Локально не запускалось (машина разработки - macOS). Проба идёт в CI на Linux под `xvfb-run` с `--no-sandbox`: шаг «упакованная поставка (Linux)» в PR #156 прошёл.

## Не проверено

- Подпись Developer ID, нотаризация и Gatekeeper: сертификата нет, а упаковка и подпись приложения Cyborg вне репозитория харнеса. Проверена только подпись ad hoc, то есть целостность пакета с asar и распакованным модулем.
- Сквозной pty через pty-хост самого приложения в упакованной сборке: spawn проверен из `app.asar` отдельным процессом, но сессия в окне не открывалась. Сквозной pty покрывает `npm run smoke` на неупакованном стенде.
- Электрон-упаковщик (electron-builder, forge) не использовался: его правила `asarUnpack` и подписи могут отличаться от пробы. Эту проверку делает T-10 и приложение Cyborg.
- Контрольные суммы на этапе 1 информационные (SAD, 6.1): подмена файла внутри уже подписанного пакета ловится только записью в журнал и «Не дошло до ядра», отказа нет.
