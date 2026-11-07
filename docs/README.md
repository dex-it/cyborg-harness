# Cyborg Harness

Документация разработки Cyborg Harness - ядра плагинов (`core/`), пакета объявлений `@cyborg-harness/contracts` (`contracts/`) и стенда `playground/`. Ядро не знает предметной области: агент, сессии, файлы, проекты и трекеры - равные плагины, а поставка приложения - список встроенных плагинов. Коротко о харнесе - [OVERVIEW](OVERVIEW.md).

> Документы перенесены из `docs/cyborg-harness/` репозитория [ai-cyborg](https://github.com/dex-it/ai-cyborg) вместе с кодом ядра. Статус - `review`: решения составителя ждут приёмки владельцем. Пути вида `src/main/...` в документах - файлы Cyborg.

## Где что

| Что | Документ |
|---|---|
| Обзор: что это, состав репозитория, архитектура коротко | [OVERVIEW.md](OVERVIEW.md) |
| Ресёрч: метод, [bb](research/bb.md), [DeepSeek Harness](research/deepseek-harness.md), [сравнение](research/comparison.md), [Cyborg сегодня](research/cyborg-today.md) | [research/](research/README.md) |
| Стратегия на одной странице: зачем ядро и плагины, для кого, меры успеха | [00-strategy/one-pager.md](00-strategy/one-pager.md) |
| BRD и фичи: ядро и загрузчик, контракты расширения | [01-product/](01-product/brd.md) |
| Сценарии: обновление, сбой плагина, автор плагина, автор встроенного плагина, второй агент, установка стороннего плагина | [02-use-cases/](02-use-cases/README.md) |
| SAD - архитектура: цели ядра, взаимодействие плагинов, базовая часть как пример, этапы, открытые вопросы, риски | [03-architecture/design/sad.md](03-architecture/design/sad.md) |
| Решения ADR-CH; где они расходятся с SAD, действует SAD ([раздел 7](03-architecture/design/sad.md#7-расхождения-с-первой-редакцией-пакета)) | [03-architecture/adr/](03-architecture/adr/) |
| Спайк UI во фреймах: память, задержка, мост, клавиши, перетаскивание | [04-verification/spike-iframe-ui.md](04-verification/spike-iframe-ui.md) |
| Спайк хостов плагинов: память на хост, цена вызова, пороги сторожа | [04-verification/spike-hosts.md](04-verification/spike-hosts.md) |
| Замер горячего пути pty: задержка вывода и склейка | [04-verification/spike-pty.md](04-verification/spike-pty.md) |
| Проверка на macOS: замеры хостов и фреймов, клавиши, терминал | [04-verification/macos-check.md](04-verification/macos-check.md) |
| Эпик «Микроядро»: цель, карта, итерации, реестр задач | [05-plans/epic-microkernel.md](05-plans/epic-microkernel.md) |
| Анализ готовности ядра и инвентарь Cyborg | [research/microkernel-readiness.md](research/microkernel-readiness.md), [research/cyborg-migration-inventory.md](research/cyborg-migration-inventory.md) |
| Сайт документации (источник страниц - `guide/`) | [guide/](guide/index.mdx), сборка - `site/` |
| Дорожная карта: этапы SAD, что сделано и что осталось | [05-plans/roadmap.md](05-plans/roadmap.md) |
| Термины | [glossary.md](glossary.md) |

## Структура по плану корпуса

Папка повторяет раскладку корпуса Cyborg ([`docs/README.md`](https://github.com/dex-it/ai-cyborg/blob/master/docs/README.md)): `00-strategy`, `01-product`, `02-use-cases`, `03-architecture`, `04-verification`, `05-plans`. Идентификаторы с префиксом `CH-` (`BR-CH-001`, `FR-CH-1001`, `ADR-CH-0001`) не пересекаются с корпусом Cyborg.
