# Сценарии

Папка на фичу, файл на сценарий: `<слаг фичи>/UC-{ФИЧА}-NNNN-<слаг сценария>.md`. Номер сценария берётся из блока номеров фичи (фича `01` - с `1001`, `02` - с `2001`) и выдаётся счётчиком `docs/.req_counter/NN.UC`. Сценарий лежит в папке той фичи, чьи нормы он разворачивает в основном; остальные фичи, которых он касается, названы в поле шапки `touches` и в колонке «Задевает» ниже. Сценарии привязаны к требованиям [BRD](../01-product/brd.md); устройство, на которое они опираются, - [SAD](../04-architecture/design/sad.md). Этап - по [SAD, раздел 6](../04-architecture/design/sad.md#6-этапы). Какой критерий приёмки покрывает какую ветку сценария - [таблица покрытия](../03-requirements/coverage.md); истории с критериями лежат в `stories/` своей фичи ([нормы](../03-requirements/README.md)).

| ID | Сценарий | Фича | Задевает | Актор | Требования | Этап |
|---|---|---|---|---|---|---|
| UC-PLUGIN-HOST-1001 | [Плагин падает, приложение работает](plugin-host/UC-PLUGIN-HOST-1001-plugin-failure-isolated.md) | 01 | 02, 04 | Пользователь, автор плагина | BR-CH-006 | 1 |
| UC-EXTENSION-CONTRACTS-2001 | [Автор встроенного плагина добавляет функцию](extension-contracts/UC-EXTENSION-CONTRACTS-2001-maintainer-adds-feature.md) | 02 | 01 | Разработчик поставки | BR-CH-001 | 1 |
| UC-EXTENSION-CONTRACTS-2002 | [Подключение второго агента](extension-contracts/UC-EXTENSION-CONTRACTS-2002-second-agent.md) | 02 | 07 | Автор поставщика агента, пользователь | BR-CH-003 | 1 |
| UC-SECURITY-TRUST-3001 | [Установка стороннего плагина с проверкой прав](security-trust/UC-SECURITY-TRUST-3001-third-party-install-permissions.md) | 03 | - | Пользователь | BR-CH-004, BR-CH-005 | 2 |
| UC-OBSERVABILITY-4001 | [Причина вчерашнего сбоя видна по трассе операций](observability/UC-OBSERVABILITY-4001-diagnose-failure-by-trace.md) | 04 | - | Пользователь, мейнтейнер | BR-CH-006 | 1 |
| UC-COMPATIBILITY-5001 | [Пользователь после обновления](compatibility/UC-COMPATIBILITY-5001-user-after-upgrade.md) | 05 | 01, 02 | Пользователь | BR-CH-002 | 1 |
| UC-COMPATIBILITY-5002 | [Плагин переживает обновление ядра](compatibility/UC-COMPATIBILITY-5002-plugin-survives-core-upgrade.md) | 05 | - | Автор плагина, пользователь | BR-CH-008 | 1 |
| UC-DELIVERY-6001 | [Приложение подключает ядро пакетами](delivery/UC-DELIVERY-6001-app-embeds-core.md) | 06 | - | Разработчик приложения | BR-CH-009 | 1 |
| UC-AUTHOR-KIT-7001 | [Автор создаёт плагин вне поставки](author-kit/UC-AUTHOR-KIT-7001-author-writes-plugin.md) | 07 | 03 | Автор плагина вне поставки | BR-CH-004, BR-CH-010 | 1 |
