# Cyborg Harness

Документация разработки Cyborg Harness - ядра плагинов (`core/`), пакета объявлений `@cyborg-harness/contracts` (`contracts/`) и стенда `playground/`. Ядро не знает предметной области: агент, сессии, файлы, проекты и трекеры - равные плагины, а поставка приложения - список встроенных плагинов. Коротко о харнесе - [OVERVIEW](OVERVIEW.md).

> Документы перенесены из `docs/cyborg-harness/` репозитория [ai-cyborg](https://github.com/dex-it/ai-cyborg) вместе с кодом ядра. Статус - `review`: решения составителя ждут приёмки владельцем. Пути вида `src/main/...` в документах - файлы Cyborg.

## Где что

| Что | Документ |
|---|---|
| Обзор: что это, состав репозитория, архитектура коротко | [OVERVIEW.md](OVERVIEW.md) |
| Ресёрч: метод, [bb](research/bb.md), [DeepSeek Harness](research/deepseek-harness.md), [сравнение](research/comparison.md), [Cyborg сегодня](research/cyborg-today.md) | [research/](research/README.md) |
| Стратегия на одной странице: зачем ядро и плагины, для кого, меры успеха | [00-strategy/one-pager.md](00-strategy/one-pager.md) |
| BRD продукта: цели, стороны, бизнес-требования BR-CH-001…010, ограничения | [01-product/brd.md](01-product/brd.md) |
| Сценарии: обновление, сбой плагина, разбор сбоя по трассе, обновление ядра, встраивание ядра, автор плагина, автор встроенного плагина, второй агент, установка стороннего плагина | [02-use-cases/](02-use-cases/README.md) |
| Нормы: SRS семи фич - FR и NFR с методом проверки, какая фича закрывает какое BR | [03-requirements/](03-requirements/README.md) |
| SAD - архитектура: цели ядра, взаимодействие плагинов, базовая часть как пример, этапы, открытые вопросы, риски | [04-architecture/design/sad.md](04-architecture/design/sad.md) |
| Модель угроз: активы, нарушители, границы доверия, угрозы со статусом и задачами | [04-architecture/design/threat-model.md](04-architecture/design/threat-model.md) |
| Решения ADR-CH; где они расходятся с SAD, действует SAD ([раздел 7](04-architecture/design/sad.md#7-расхождения-с-первой-редакцией-пакета)) | [04-architecture/adr/](04-architecture/adr/) |
| Спайк UI во фреймах: память, задержка, мост, клавиши, перетаскивание | [05-verification/spike-iframe-ui.md](05-verification/spike-iframe-ui.md) |
| Спайк хостов плагинов: память на хост, цена вызова, пороги сторожа | [05-verification/spike-hosts.md](05-verification/spike-hosts.md) |
| Замер шлюза `ctx.os`: цена проверок и канала хоста на горячих путях, проверка бюджета | [05-verification/spike-gateway.md](05-verification/spike-gateway.md) |
| Замер горячего пути pty: задержка вывода и склейка | [05-verification/spike-pty.md](05-verification/spike-pty.md) |
| Спайк экрана терминала после `attach`: хвост или снимок на настоящем `claude` | [05-verification/spike-pty-restore.md](05-verification/spike-pty-restore.md) |
| Проверка на macOS: замеры хостов и фреймов, клавиши, терминал | [05-verification/macos-check.md](05-verification/macos-check.md) |
| Эпик «Микроядро»: цель, карта, итерации, реестр задач | [06-plans/epic-microkernel.md](06-plans/epic-microkernel.md) |
| Анализ готовности ядра и инвентарь Cyborg | [research/microkernel-readiness.md](research/microkernel-readiness.md), [research/cyborg-migration-inventory.md](research/cyborg-migration-inventory.md) |
| Сайт документации (источник страниц - `guide/`) | [guide/](guide/index.mdx), сборка - `site/` |
| Дорожная карта по направлениям ядра (безопасность, надёжность, наблюдаемость, производительность, совместимость и другие): сводка норм - что выполнено, что нет; что закрываем сейчас и что позже | [06-plans/roadmap.md](06-plans/roadmap.md) |
| Термины | [glossary.md](glossary.md) |

## Структура

Номера папок идут в порядке вывода документов: каждая следующая зона выводится из предыдущей.

| Зона | Что несёт | Из чего выводится |
|---|---|---|
| `00-strategy` | зачем ядро и плагины, меры успеха | запрос владельца |
| `01-product` | BRD продукта: цели, стороны, BR, ограничения | стратегия |
| `02-use-cases` | сценарий на папку; один сценарий может задевать несколько фич | BR |
| `03-requirements` | SRS фичи в папке `<NN>-<слаг>/`, журнал решений фичи; карта фич - `README.md` | FR - из шагов и расширений сценариев, NFR - из мер BR |
| `04-architecture` | SAD и модель угроз (`design/`), решения ADR-CH (`adr/`) | нормы |
| `05-verification` | замеры и спайки | нормы и устройство |
| `06-plans` | дорожная карта по направлениям, эпик | состояние норм |

Раскладка отличается от корпуса Cyborg ([`docs/README.md`](https://github.com/dex-it/ai-cyborg/blob/master/docs/README.md)). Там SRS лежит в папке фичи рядом с её BRD, а зон после `02-use-cases` на одну меньше. Здесь нормы вынесены в свою зону, чтобы порядок папок совпадал с порядком вывода, а BRD фич нет: десяти BR продукта хватает, и BRD фичи только пересказывал их. Фичи появляются на уровне норм. Решения владельца от 2026-11-08. Идентификаторы с префиксом `CH-` (`BR-CH-001`, `FR-CH-1001`, `ADR-CH-0001`) не пересекаются с корпусом Cyborg.
