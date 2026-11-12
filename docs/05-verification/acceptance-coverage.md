---
level: coverage
status: review
date: 2026-11-12
origin: derived
---

# Покрытие критериев приёмки проверками

Таблица собрана из критериев историй, имён тестов и `acceptance.md` командой `npm run check:acceptance -- --write`; руками не правится. `npm run check:acceptance` падает, если у критерия нет ни теста с ключом `ST-NNNN/k` в имени, ни исключения в [acceptance.md](acceptance.md), если есть и то и другое, если ключ указывает на несуществующий критерий или эта таблица расходится с собранной. Исход критерия: «тест» - в имени хотя бы одного включённого теста ключ критерия (запуск - `npm run test:acceptance`); «исключение» - категория из [acceptance.md](acceptance.md); «целевое поведение» - критерий на то, чего ещё нет, проверки не требует. В ячейке «Проверка» путь файла и число тестов с ключом.

Итог: историй 39, критериев 248: тест 194 (тестов с ключом 448), исключение 6, целевое поведение 22, без исхода 26.

Исключения по категориям: замеры 2, окно 3, ручная 1.

## ST-1001 Манифест и обнаружение: плагин с ошибками не запускается, остальные работают

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1001/1 | тест | core/test/loader.test.ts (2), core/test/semver-manifest.test.ts (1) |
| ST-1001/2 | тест | core/test/window.test.ts (1) |
| ST-1001/3 | тест | core/test/manifest-schema.test.ts (1), core/test/plugin-template.test.ts (1) |
| ST-1001/4 | тест | electron/test/plugins.test.ts (2) |
| ST-1001/5 | тест | core/test/graph.test.ts (1), electron/test/plugins.test.ts (2) |
| ST-1001/6 | тест | electron/test/plugins.test.ts (2) |
| ST-1001/7 | тест | core/test/loader.test.ts (3), electron/test/plugins.test.ts (1), playground/test/plugins-model.test.ts (1) |
| ST-1001/8 | тест | core/test/status.test.ts (1) |
| ST-1001/9 | тест | core/test/loader.test.ts (1), core/test/manifest-schema.test.ts (1) |
| ST-1001/10 | тест | core/test/loader.test.ts (1) |
| ST-1001/11 | тест | electron/test/plugins.test.ts (1) |

## ST-1002 Граф контрактов разрешается до запуска кода

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1002/1 | тест | core/test/loader.test.ts (1) |
| ST-1002/2 | тест | core/test/graph.test.ts (1) |
| ST-1002/3 | тест | core/test/graph.test.ts (1) |
| ST-1002/4 | тест | core/test/graph.test.ts (2) |
| ST-1002/5 | тест | core/test/graph.test.ts (1) |
| ST-1002/6 | тест | core/test/graph.test.ts (3) |
| ST-1002/7 | тест | core/test/graph.test.ts (1), core/test/loader.test.ts (1) |

## ST-1003 Сбой плагина остаётся у плагина: хосты и сторож

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1003/1 | тест | core/test/external-plugins.test.ts (1), core/test/loader.test.ts (2) |
| ST-1003/2 | тест | core/test/loader.test.ts (1), electron/test/plugins.test.ts (1) |
| ST-1003/3 | тест | core/test/hosts.test.ts (1), core/test/stress-lifecycle.test.ts (1), core/test/watchdog-stall.test.ts (1) |
| ST-1003/4 | тест | core/test/hosts.test.ts (1), core/test/stress-lifecycle.test.ts (1) |
| ST-1003/5 | тест | core/test/hosts.test.ts (3) |
| ST-1003/6 | тест | core/test/hosts.test.ts (3) |
| ST-1003/7 | тест | core/test/loader.test.ts (1), core/test/stress-hosts.test.ts (1) |
| ST-1003/8 | тест | core/test/ui-shell.test.ts (1) |

## ST-1004 Человек видит причину сбоя и включает плагин снова

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1004/1 | тест | core/test/loader.test.ts (2) |
| ST-1004/2 | тест | core/test/loader.test.ts (1) |
| ST-1004/3 | тест | core/test/loader.test.ts (1), core/test/stress-lifecycle.test.ts (1) |
| ST-1004/4 | тест | core/test/loader.test.ts (1) |

## ST-1005 Выгрузка и откат регистраций без перезапуска окна

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1005/1 | тест | core/test/loader.test.ts (1), core/test/os-lifetime.test.ts (2), core/test/os.test.ts (1), core/test/serve.test.ts (1), core/test/stress-lifecycle.test.ts (1), core/test/window.test.ts (1) |
| ST-1005/2 | тест | core/test/subscriptions.test.ts (3) |
| ST-1005/3 | тест | core/test/lifecycle.test.ts (1), core/test/stress-lifecycle.test.ts (1) |
| ST-1005/4 | тест | core/test/lifecycle.test.ts (1) |
| ST-1005/5 | тест | core/test/lifecycle.test.ts (1), core/test/stress-lifecycle.test.ts (1) |
| ST-1005/6 | тест | electron/test/plugins.test.ts (1) |

## ST-1006 Ленивая активация и бюджет накладных расходов

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1006/1 | тест | core/test/events.test.ts (1) |
| ST-1006/2 | тест | core/test/events.test.ts (2) |
| ST-1006/3 | тест | core/test/events.test.ts (1) |
| ST-1006/4 | тест | core/test/loader.test.ts (1), core/test/window.test.ts (1) |
| ST-1006/5 | исключение | замеры |
| ST-1006/6 | целевое поведение |  |

## ST-1007 Воркспейс как главная сессия: замок, «Недавние», битый файл

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1007/1 | тест | core/test/instance.test.ts (3), core/test/stress-workspace.test.ts (1), core/test/workspace.test.ts (1) |
| ST-1007/2 | тест | core/test/instance.test.ts (1), electron/test/instances.test.ts (1) |
| ST-1007/3 | тест | core/test/config.test.ts (1), core/test/workspace.test.ts (2) |
| ST-1007/4 | тест | core/test/stress-workspace.test.ts (1), core/test/workspace.test.ts (1) |
| ST-1007/5 | тест | core/test/workspace.test.ts (2) |
| ST-1007/6 | тест | core/test/stress-workspace.test.ts (1), core/test/workspace.test.ts (1) |
| ST-1007/7 | исключение | окно |
| ST-1007/8 | тест | core/test/loader.test.ts (1), core/test/workspace.test.ts (1) |
| ST-1007/9 | тест | core/test/os.test.ts (1) |

## ST-1008 Терминальные процессы переживают сбои хостов

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1008/1 | тест | core/test/pty.test.ts (1), core/test/stress-pty.test.ts (2) |
| ST-1008/2 | тест | core/test/pty.test.ts (1), core/test/stress-pty.test.ts (1) |
| ST-1008/3 | тест | core/test/pty.test.ts (2), core/test/stress-pty.test.ts (1) |
| ST-1008/4 | тест | core/test/pty.test.ts (1) |
| ST-1008/5 | тест | core/test/pty-host.test.ts (2) |
| ST-1008/6 | тест | core/test/pty.test.ts (1), core/test/stress-pty.test.ts (2) |

## ST-1009 Ядро остаётся компактным: функция добавляется плагином

| Критерий | Исход | Проверка |
|---|---|---|
| ST-1009/1 | тест | core/test/purity.test.ts (2) |
| ST-1009/2 | исключение | ручная |

## ST-2001 Плагины связываются контрактами по объявлению, без общей шины

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2001/1 | тест | core/test/loader.test.ts (1), core/test/registry.test.ts (1) |
| ST-2001/2 | тест | core/test/registry.test.ts (1), core/test/trust.test.ts (1) |
| ST-2001/3 | тест | core/test/registry.test.ts (2) |
| ST-2001/4 | тест | core/test/trust.test.ts (1) |
| ST-2001/5 | тест | core/test/loader.test.ts (1), core/test/rpc.test.ts (1) |
| ST-2001/6 | тест | core/test/subscriptions.test.ts (4), core/test/trust.test.ts (1) |
| ST-2001/7 | тест | core/test/events.test.ts (2) |
| ST-2001/8 | тест | core/test/loader.test.ts (1), core/test/rpc.test.ts (1) |
| ST-2001/9 | тест | core/test/channel.test.ts (1), core/test/window.test.ts (1) |
| ST-2001/10 | тест | core/test/documents.test.ts (1), playground/test/session-notifications.test.ts (1) |

## ST-2002 Команды, сочетания клавиш и пункты меню объявляются плагином

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2002/1 | тест | core/test/loader.test.ts (1), core/test/trust.test.ts (2) |
| ST-2002/2 | тест | core/test/command-callers.test.ts (2), core/test/graph.test.ts (1) |
| ST-2002/3 | тест | core/test/lifecycle.test.ts (1), electron/test/key-route.test.ts (1) |
| ST-2002/4 | тест | core/test/lifecycle.test.ts (2) |
| ST-2002/5 | тест | core/test/keys-registry.test.ts (6) |
| ST-2002/6 | тест | core/test/loader.test.ts (3) |

## ST-2003 Виды и документы плагина: области, порядок, заглушка при сбое

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2003/1 | тест | core/test/loader.test.ts (3) |
| ST-2003/2 | тест | electron/test/view-files.test.ts (3) |
| ST-2003/3 | тест | electron/test/view-frames.test.ts (3) |
| ST-2003/4 | исключение | окно |
| ST-2003/5 | тест | core/test/loader.test.ts (1), playground/test/pilot-shell.test.ts (1), playground/test/plugins-model.test.ts (1) |
| ST-2003/6 | тест | core/test/documents.test.ts (1) |
| ST-2003/7 | целевое поведение |  |
| ST-2003/8 | тест | core/test/semver-manifest.test.ts (1) |

## ST-2004 Слой окна: диалоги, замок, уведомления

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2004/1 | тест | core/test/window.test.ts (2) |
| ST-2004/2 | тест | core/test/window.test.ts (2), electron/test/window-layer.test.ts (1) |
| ST-2004/3 | тест | core/test/window.test.ts (4) |
| ST-2004/4 | тест | core/test/events.test.ts (1), core/test/os.test.ts (1), core/test/window.test.ts (1) |
| ST-2004/5 | тест | core/test/loader.test.ts (1), core/test/semver-manifest.test.ts (1) |

## ST-2005 Всё, что рисует ядро, доступно с клавиатуры и дикторам

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2005/1 | исключение | окно |
| ST-2005/2 | тест | core/test/window.test.ts (2) |
| ST-2005/3 | целевое поведение |  |
| ST-2005/4 | целевое поведение |  |

## ST-2006 Второй агент подключается плагином без правки ядра

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2006/1 | тест | playground/test/agents.test.ts (1), testing/test/agent-suite.test.ts (1) |
| ST-2006/2 | тест | core/test/pty.test.ts (1), testing/test/agent-suite.test.ts (1) |
| ST-2006/3 | тест | playground/test/agents.test.ts (1) |
| ST-2006/4 | тест | playground/test/agents.test.ts (1) |
| ST-2006/5 | тест | playground/test/agents.test.ts (1) |
| ST-2006/6 | тест | core/test/pty.test.ts (1), playground/test/agents.test.ts (1), playground/test/session-notifications.test.ts (1) |
| ST-2006/7 | тест | playground/test/agents.test.ts (1) |
| ST-2006/8 | тест | testing/test/agent-suite.test.ts (1) |
| ST-2006/9 | тест | playground/test/agents.test.ts (1) |
| ST-2006/10 | тест | playground/test/agents.test.ts (1) |
| ST-2006/11 | тест | playground/test/agents.test.ts (1) |
| ST-2006/12 | тест | playground/test/agents.test.ts (2) |
| ST-2006/13 | тест | playground/test/agents.test.ts (3) |
| ST-2006/14 | тест | playground/test/agents.test.ts (1) |

## ST-2007 Ядро не называет плагины по именам

| Критерий | Исход | Проверка |
|---|---|---|
| ST-2007/1 | тест | core/test/purity.test.ts (1) |
| ST-2007/2 | тест | core/test/plugin-imports.test.ts (2) |

## ST-3001 Права плагина проверяет шлюз ctx.os, у каждого отказа есть запись

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3001/1 | тест | core/test/os.test.ts (1), core/test/trust.test.ts (1) |
| ST-3001/2 | тест | core/test/os.test.ts (3), core/test/security-gateway.test.ts (1) |
| ST-3001/3 | тест | core/test/os.test.ts (3) |
| ST-3001/4 | тест | core/test/os.test.ts (2) |
| ST-3001/5 | тест | core/test/os.test.ts (2) |
| ST-3001/6 | тест | core/test/os.test.ts (1) |
| ST-3001/7 | тест | core/test/os.test.ts (1) |
| ST-3001/8 | тест | core/test/os.test.ts (1), core/test/plugin-check.test.ts (1) |
| ST-3001/9 | тест | core/test/plugin-check.test.ts (1), core/test/trust.test.ts (1), core/test/workspace-trust.test.ts (1) |
| ST-3001/10 | целевое поведение |  |

## ST-3002 Программы, сеть, открытие в системе и локальный сервер под правами

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3002/1 | тест | core/test/os.test.ts (2) |
| ST-3002/2 | тест | core/test/os-lifetime.test.ts (1), core/test/os.test.ts (4), core/test/security-gateway.test.ts (1) |
| ST-3002/3 | тест | core/test/os.test.ts (2), core/test/workspace-trust.test.ts (2) |
| ST-3002/4 | тест | core/test/net-fetch.test.ts (1), core/test/os.test.ts (1) |
| ST-3002/5 | тест | core/test/net-fetch.test.ts (2) |
| ST-3002/6 | тест | core/test/serve.test.ts (4) |
| ST-3002/7 | тест | core/test/os-lifetime.test.ts (4), core/test/os.test.ts (4) |

## ST-3003 Права не передаются через чужие контракты и команды

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3003/1 | тест | core/test/via-contract.test.ts (2) |
| ST-3003/2 | целевое поведение |  |
| ST-3003/3 | тест | core/test/command-callers.test.ts (3) |
| ST-3003/4 | тест | core/test/command-callers.test.ts (1) |
| ST-3003/5 | тест | core/test/graph.test.ts (2), core/test/loader.test.ts (1) |

## ST-3004 Секреты не утекают, удаление плагина стирает его данные

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3004/1 | тест | core/test/os.test.ts (1) |
| ST-3004/2 | тест | core/test/os.test.ts (1) |
| ST-3004/3 | тест | core/test/diagnostics.test.ts (1), core/test/plugin-log.test.ts (1), core/test/secrets-journal.test.ts (1) |
| ST-3004/4 | тест | core/test/uninstall.test.ts (2) |
| ST-3004/5 | тест | core/test/plugin-log.test.ts (3) |

## ST-3005 Вид изолирован: группа рендера, закрытая CSP, окно остаётся на своих адресах

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3005/1 | тест | core/test/loader.test.ts (3), core/test/os.test.ts (1), core/test/workspace-trust.test.ts (1), electron/test/plugins.test.ts (1) |
| ST-3005/2 | тест | electron/test/view-frames.test.ts (2) |
| ST-3005/3 | тест | core/test/no-inner-html.test.ts (1) |
| ST-3005/4 | тест | electron/test/view-files.test.ts (4) |
| ST-3005/5 | тест | electron/test/csp-note.test.ts (1), electron/test/view-files.test.ts (1) |
| ST-3005/6 | тест | electron/test/navigation.test.ts (3) |
| ST-3005/7 | целевое поведение |  |

## ST-3006 Агент не получает больше, чем человек разрешил

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3006/1 | тест | playground/test/agents.test.ts (1) |
| ST-3006/2 | тест | playground/test/agents.test.ts (2) |
| ST-3006/3 | тест | playground/test/agents.test.ts (1) |
| ST-3006/4 | тест | playground/test/agents.test.ts (2) |
| ST-3006/5 | целевое поведение |  |

## ST-3007 Установка стороннего плагина с согласием человека (этап 2)

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3007/1 | целевое поведение |  |
| ST-3007/2 | целевое поведение |  |
| ST-3007/3 | целевое поведение |  |
| ST-3007/4 | целевое поведение |  |
| ST-3007/5 | целевое поведение |  |
| ST-3007/6 | целевое поведение |  |
| ST-3007/7 | тест | core/test/os.test.ts (1), core/test/plugin-check.test.ts (1) |
| ST-3007/8 | целевое поведение |  |

## ST-3008 Безопасный режим, значения не из репозитория и учёт угроз

| Критерий | Исход | Проверка |
|---|---|---|
| ST-3008/1 | тест | core/test/loader.test.ts (1), core/test/window.test.ts (1) |
| ST-3008/2 | тест | core/test/workspace-trust.test.ts (4), core/test/workspace.test.ts (1) |
| ST-3008/3 | целевое поведение |  |

## ST-4001 Каждая операция на границе плагинов даёт одну запись трассы

| Критерий | Исход | Проверка |
|---|---|---|
| ST-4001/1 | тест | core/test/trace.test.ts (1) |
| ST-4001/2 | тест | core/test/trace.test.ts (1) |
| ST-4001/3 | тест | core/test/trace.test.ts (2) |
| ST-4001/4 | тест | core/test/trace.test.ts (1) |
| ST-4001/5 | тест | core/test/trace.test.ts (1) |
| ST-4001/6 | тест | core/test/trace.test.ts (3) |
| ST-4001/7 | тест | core/test/trace.test.ts (1) |
| ST-4001/8 | тест | core/test/trace.test.ts (1) |
| ST-4001/9 | тест | core/test/trace.test.ts (1) |
| ST-4001/10 | исключение | замеры |
| ST-4001/11 | тест | core/test/diagnostics.test.ts (1), core/test/secrets-journal.test.ts (1), core/test/trace.test.ts (2) |

## ST-4002 Журнал плагина: строки ctx.log, вывод хоста и пределы

| Критерий | Исход | Проверка |
|---|---|---|
| ST-4002/1 | тест | core/test/plugin-log.test.ts (1) |
| ST-4002/2 | тест | core/test/host-output.test.ts (3) |
| ST-4002/3 | тест | core/test/plugin-log.test.ts (4) |
| ST-4002/4 | тест | core/test/plugin-log.test.ts (3) |
| ST-4002/5 | тест | core/test/diagnostics-ring.test.ts (2), core/test/diagnostics.test.ts (1) |

## ST-4003 Журнал и трасса переживают закрытие: файл, ротация, причина прошлого сбоя

| Критерий | Исход | Проверка |
|---|---|---|
| ST-4003/1 | тест | core/test/diagnostics.test.ts (1), electron/test/diagnostics.test.ts (1) |
| ST-4003/2 | тест | core/test/diagnostics.test.ts (3) |
| ST-4003/3 | тест | core/test/diagnostics.test.ts (2), electron/test/diagnostics.test.ts (1) |
| ST-4003/4 | тест | core/test/diagnostics.test.ts (2), electron/test/diagnostics.test.ts (1) |
| ST-4003/5 | тест | core/test/diagnostics.test.ts (1), electron/test/diagnostics.test.ts (1) |
| ST-4003/6 | тест | core/test/trace.test.ts (1) |

## ST-4004 Диагностика выгружается одним файлом и остаётся на машине

| Критерий | Исход | Проверка |
|---|---|---|
| ST-4004/1 | тест | core/test/diagnostics.test.ts (1), electron/test/diagnostics.test.ts (1) |
| ST-4004/2 | тест | core/test/diagnostics.test.ts (1) |
| ST-4004/3 | тест | core/test/diagnostics.test.ts (2) |
| ST-4004/4 | тест | core/test/diagnostics.test.ts (2) |
| ST-4004/5 | тест | core/test/diagnostics.test.ts (1) |

## ST-4005 Окно «Плагины Cyborg» объясняет состояние и ресурсы

| Критерий | Исход | Проверка |
|---|---|---|
| ST-4005/1 | тест | core/test/status.test.ts (1), electron/test/plugins.test.ts (1), playground/test/plugins-model.test.ts (2) |
| ST-4005/2 | тест | playground/test/plugins-model.test.ts (2) |
| ST-4005/3 | целевое поведение |  |
| ST-4005/4 | тест | core/test/plugin-log.test.ts (2), core/test/status.test.ts (1) |

## ST-5001 Несовместимый плагин не загружается, остальные работают

| Критерий | Исход | Проверка |
|---|---|---|
| ST-5001/1 | тест | core/test/api-version.test.ts (1), core/test/semver-manifest.test.ts (1) |
| ST-5001/2 | тест | core/test/graph.test.ts (1), core/test/loader.test.ts (1), core/test/semver-manifest.test.ts (1) |
| ST-5001/3 | тест | core/test/semver-manifest.test.ts (2) |
| ST-5001/4 | тест | core/test/graph.test.ts (1), core/test/registry.test.ts (1) |
| ST-5001/5 | тест | core/test/api-version.test.ts (2) |
| ST-5001/6 | тест | core/test/graph.test.ts (1), core/test/registry.test.ts (1) |

## ST-5002 Публичный API стабилен в пределах мажорной версии

| Критерий | Исход | Проверка |
|---|---|---|
| ST-5002/1 | тест | core/test/api-snapshot.test.ts (3) |
| ST-5002/2 | тест | core/test/graph.test.ts (1), core/test/registry.test.ts (2) |
| ST-5002/3 | тест | core/test/api-snapshot.test.ts (7) |
| ST-5002/4 | целевое поведение |  |
| ST-5002/5 | тест | contracts/test/package.test.ts (3), core/test/api-snapshot.test.ts (2) |
| ST-5002/6 | тест | core/test/external-plugins.test.ts (1), core/test/loader.test.ts (1) |
| ST-5002/7 | тест | scripts/test/release.test.ts (2) |
| ST-5002/8 | тест | core/test/loader.test.ts (1), core/test/semver-manifest.test.ts (2) |

## ST-5003 Вызовы устаревших членов видны автору

| Критерий | Исход | Проверка |
|---|---|---|
| ST-5003/1 | тест | core/test/via-contract.test.ts (1) |
| ST-5003/2 | тест | core/test/semver-manifest.test.ts (1), core/test/via-contract.test.ts (1) |
| ST-5003/3 | тест | core/test/journal.test.ts (4) |
| ST-5003/4 | тест | core/test/diagnostics.test.ts (1), core/test/status.test.ts (1) |
| ST-5003/5 | тест | core/test/api-snapshot.test.ts (1) |
| ST-5003/6 | тест | testing/test/kit.test.ts (1) |

## ST-5004 Разделы config и state переживают обновление

| Критерий | Исход | Проверка |
|---|---|---|
| ST-5004/1 | тест | core/test/config.test.ts (1), core/test/loader.test.ts (1) |
| ST-5004/2 | тест | core/test/config.test.ts (1), core/test/loader.test.ts (1) |
| ST-5004/3 | тест | core/test/config.test.ts (1), core/test/json-schema.test.ts (1), core/test/loader.test.ts (1), core/test/workspace.test.ts (1) |
| ST-5004/4 | тест | core/test/config.test.ts (1), core/test/stress-sections.test.ts (1) |
| ST-5004/5 | тест | core/test/workspace.test.ts (1), playground/src/main/legacy-workspace.test.ts (4) |
| ST-5004/6 | тест | core/test/uninstall.test.ts (2) |
| ST-5004/7 | тест | core/test/config.test.ts (1), core/test/stress-sections.test.ts (2), core/test/stress-workspace.test.ts (4) |
| ST-5004/8 | тест | core/test/workspace.test.ts (1) |

## ST-6001 Приложение подключает ядро пакетами и задаёт поставку списком

| Критерий | Исход | Проверка |
|---|---|---|
| ST-6001/1 | нет |  |
| ST-6001/2 | нет |  |
| ST-6001/3 | нет |  |
| ST-6001/4 | нет |  |
| ST-6001/5 | нет |  |
| ST-6001/6 | целевое поведение |  |
| ST-6001/7 | нет |  |
| ST-6001/8 | нет |  |

## ST-6002 Выпуск пакетов проверен сборкой примера, ОС ведут себя одинаково

| Критерий | Исход | Проверка |
|---|---|---|
| ST-6002/1 | нет |  |
| ST-6002/2 | нет |  |
| ST-6002/3 | целевое поведение |  |
| ST-6002/4 | нет |  |

## ST-7001 Автор начинает с шаблона и собирает плагин с проверкой состава

| Критерий | Исход | Проверка |
|---|---|---|
| ST-7001/1 | нет |  |
| ST-7001/2 | нет |  |
| ST-7001/3 | нет |  |
| ST-7001/4 | нет |  |

## ST-7002 Пакет объявлений и checkPlugin: типы, импорты, права словами

| Критерий | Исход | Проверка |
|---|---|---|
| ST-7002/1 | нет |  |
| ST-7002/2 | нет |  |
| ST-7002/3 | тест | core/test/plugin-check.test.ts (1), tools/cyborg-plugin/test/cli.test.ts (1) |
| ST-7002/4 | нет |  |
| ST-7002/5 | целевое поведение |  |
| ST-7002/6 | нет |  |

## ST-7003 Автор проверяет плагин на тест-ките без окна

| Критерий | Исход | Проверка |
|---|---|---|
| ST-7003/1 | нет |  |
| ST-7003/2 | нет |  |
| ST-7003/3 | нет |  |
| ST-7003/4 | нет |  |
| ST-7003/5 | целевое поведение |  |

## ST-7004 Автор проходит путь по руководству, не читая код ядра

| Критерий | Исход | Проверка |
|---|---|---|
| ST-7004/1 | нет |  |
| ST-7004/2 | нет |  |
| ST-7004/3 | нет |  |
| ST-7004/4 | нет |  |
