---
level: story
id: ST-2006
feature: 02-extension-contracts
status: review
date: 2026-11-10
origin: derived
traced from: BR-CH-003, BR-CH-005
---

# ST-2006 Второй агент подключается плагином без правки ядра

Как автор поставщика агента, я хочу подключить свою программу как плагин `cyborg.agent`, чтобы она появилась рядом с Claude Code и ядро и `sessions` не менялись.

Нормы: FR-CH-1015, FR-CH-2007, FR-CH-2009, FR-CH-2010, FR-CH-2012, FR-CH-2015, FR-CH-2016, FR-CH-2017, FR-CH-2018, FR-CH-2019, FR-CH-2020. Сценарии: UC-COMPATIBILITY-5001, UC-EXTENSION-CONTRACTS-2002. SRS - [srs.md](../srs.md).

## Критерии приёмки

1. [FR-CH-2009] [FR-CH-2012] [UC-EXTENSION-CONTRACTS-2002#1] [UC-EXTENSION-CONTRACTS-2002#2]
   - Дано манифест поставщика с `"provides": { "cyborg.agent": "1.0" }` и правом `launch` на программу
   - Когда автор подключает плагин
   - Тогда поставщик отдаёт `facts`, `launch`, `watch`, `ended`, `history`; прав `pty` ему не нужно, процесс запускает потребитель; регистрации агента в ядре нет
2. [FR-CH-2009] [FR-CH-2007] [UC-EXTENSION-CONTRACTS-2002#6] [UC-EXTENSION-CONTRACTS-2002#6а]
   - Дано потребитель запускает `ctx.os.pty.spawn` с `describedBy`; в одном случае программы нет в праве `pty` потребителя, в другом - в праве `launch` поставщика
   - Когда описание сверяется
   - Тогда учитываются и право `pty` потребителя, и право `launch` поставщика - права пересекаются; программа вне любого из двух прав даёт `PermissionDenied` и запись `denied`, процесс не запущен
3. [FR-CH-2009]
   - Дано поставщик без `capabilities.resume`
   - Когда потребитель просит продолжить сессию
   - Тогда `resumeId` потребитель не просит: только при объявленном `capabilities.resume`
4. [FR-CH-2015] [UC-EXTENSION-CONTRACTS-2002#4] [UC-EXTENSION-CONTRACTS-2002#5]
   - Дано установлено два плагина-поставщика `cyborg.agent`
   - Когда человек включает плагины
   - Тогда `sessions` показывает кнопку новой сессии на каждого, добавление поставщика не меняет код ядра и `sessions`
5. [FR-CH-2009] [FR-CH-1015] [UC-EXTENSION-CONTRACTS-2002#5]
   - Дано человек нажал кнопку агента
   - Когда `sessions` спрашивает `facts`
   - Тогда `launch` отдаёт описание запуска с фрагментами промпта от `cyborg.session-prompt`, процесс запускает `ctx.os.pty.spawn` с `persist` и `describedBy`
6. [FR-CH-2009] [FR-CH-1015] [UC-EXTENSION-CONTRACTS-2002#7]
   - Дано процесс агента запущен
   - Когда вид `sessions` открывает терминал
   - Тогда терминал открыт по билету, события `watch` (`cwd`, `session`, `activity`, `prompt`, `turnEnd`, `waiting`) приходят от поставщика
7. [FR-CH-2016] [UC-EXTENSION-CONTRACTS-2002#5а]
   - Дано `facts` ответил `found: false`
   - Когда человек нажимает кнопку агента
   - Тогда сессия не создана, команда отвечает ошибкой «<название>: программа не найдена», кнопка подписана тем же
8. [FR-CH-2017] [UC-EXTENSION-CONTRACTS-2002#7а]
   - Дано процесс агента вышел с кодом 127
   - Когда `ended` вызван
   - Тогда причина `notFound`
9. [FR-CH-2018] [UC-EXTENSION-CONTRACTS-2002#1а]
   - Дано поставщик с `capabilities.events: false`
   - Когда человек открывает сессию
   - Тогда запуск, вывод и ввод работают, `watch` молчит, «ждёт» не показывается
10. [FR-CH-2019] [UC-EXTENSION-CONTRACTS-2002#7б] [UC-COMPATIBILITY-5001#6б]
   - Дано поставщик без `capabilities.resume`
   - Когда приложение перезапущено
   - Тогда сессия поднимается новой в той же вкладке, `resumeId` не передаётся
11. [FR-CH-2020] [UC-EXTENSION-CONTRACTS-2002#7в]
   - Дано агент не знает MCP
   - Когда открыта сессия
   - Тогда нет инструментов `cyborg.agent-tool` и кнопок следующих шагов, остальное не меняется
12. [FR-CH-2010]
   - Дано плагин `agent-claude-code`
   - Когда запускается сессия Claude Code
   - Тогда запуск `$SHELL -lc 'exec claude --settings "$CYBORG_SETTINGS" "$@"'` по праву `launch`; токен MCP в `CYBORG_MCP_TOKEN` и файле `--mcp-config`, не в argv; `--settings` разрешает без вопроса только сервер `cyborg`, режим разрешений не задаёт; в `--mcp-config` один сервер
13. [FR-CH-2010]
   - Дано хуки `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `Notification` пишут в файл сессии; после `Stop` сессия молчит 30 с
   - Когда агент закончил ход без фоновой работы
   - Тогда `watch` через `fs.watch` и `fs.readSlice` отдаёт «ждёт»; `resumeId` равен `session_id` хука `SessionStart`; `history` - интерактивные сессии каталога и его worktree
14. [FR-CH-2009] [UC-COMPATIBILITY-5001#6]
   - Дано поставщик с `capabilities.resume` и сессия прошлого запуска
   - Когда человек выбирает её в «Сессии прошлого запуска»
   - Тогда сессия поднимается через `resume` поставщика, `resumeId` передан