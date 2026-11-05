# Cyborg Harness

Проект перестройки Cyborg в **ядро и плагины**: маленькое ядро и все функции приложения как плагины на публичном API, затем сторонние плагины и другие агенты помимо Claude Code. Всё, что работает сегодня, сохраняется.

> Документы перенесены из `docs/cyborg-harness/` репозитория [ai-cyborg](https://github.com/dex-it/ai-cyborg) вместе с кодом ядра. Статус - проектирование, `review`: решения составителя ждут приёмки владельцем. Код - `core/` (ядро) и `playground/` (приложение для проверки ядра вживую) в корне этого репозитория. Пути вида `src/main/...` в документах - файлы Cyborg.

## Идея

Сегодня каждая возможность правит `main.ts`, `preload.ts`, `app.ts` и копится в одном целом (14 тыс. строк, 58 каналов IPC); Claude Code зашит в ядро; расширить приложение снаружи нельзя. Два проекта решили похожую задачу: [bb](research/bb.md) (агентная IDE с плагинами и провайдерами агентов) и [DeepSeek Harness](research/deepseek-harness.md) (харнес «everything is a plugin»). Мы берём из них минимальное ядро с откатом регистраций, манифест с совместимостью, паритет по записанным сессиям и контракт провайдера агента, а масштаб и ритуалы не берём. Контракт для интерактивного `claude` в pty проектируем сами: образцы такое не встраивают. Подробнее - [OVERVIEW](OVERVIEW.md).

## Где что

| Что | Документ |
|---|---|
| Общее описание, ресёрч, архитектура, план, риски, открытые решения | [OVERVIEW.md](OVERVIEW.md) |
| Ресёрч: метод, [bb](research/bb.md), [dsh](research/deepseek-harness.md), [сравнение](research/comparison.md), [Cyborg сегодня](research/cyborg-today.md) | [research/](research/README.md) |
| Идея и обоснование на одной странице, canvas | [00-strategy/one-pager.md](00-strategy/one-pager.md) |
| BRD и три фичи (ядро и загрузчик, точки расширения и провайдеры, миграция и паритет) | [01-product/](01-product/brd.md) |
| Сценарии: пользователь, сбой плагина, автор, мейнтейнер, второй агент, установка | [02-use-cases/](02-use-cases/README.md) |
| SAD2 - общая архитектура: цели ядра, взаимодействие плагинов, базовая часть как пример, этапы, риски; пересматривает границу ядра из SAD | [03-architecture/design/sad2.md](03-architecture/design/sad2.md) |
| Устройство: SAD и 8 ADR | [03-architecture/design/sad.md](03-architecture/design/sad.md), [adr/](03-architecture/adr/) |
| Как проверяем, что ничего не потеряно | [04-verification/parity-plan.md](04-verification/parity-plan.md) |
| Спайк UI во фреймах: память, задержка, мост, клавиши, перетаскивание | [04-verification/spike-iframe-ui.md](04-verification/spike-iframe-ui.md) |
| Спайк хостов плагинов: память на хост, цена вызова, пороги сторожа | [04-verification/spike-hosts.md](04-verification/spike-hosts.md) |
| Дорожная карта по фазам P0-P5 | [05-plans/roadmap.md](05-plans/roadmap.md) |
| Термины | [glossary.md](glossary.md) |

## Структура по плану корпуса

Папка повторяет раскладку корпуса Cyborg ([`docs/README.md`](https://github.com/dex-it/ai-cyborg/blob/master/docs/README.md)): `00-strategy`, `01-product`, `02-use-cases`, `03-architecture`, `04-verification`, `05-plans`. Идентификаторы с префиксом `CH-` (`BR-CH-001`, `FR-CH-1001`, `ADR-CH-0001`) не пересекаются с корпусом Cyborg.
