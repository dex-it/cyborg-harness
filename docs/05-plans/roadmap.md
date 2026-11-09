---
level: plan
feature: cyborg-harness
status: review
date: 2026-11-08
origin: derived
quality-checks: входных записей нет
---

# Дорожная карта Cyborg Harness

> План разработки харнеса в этом репозитории: ядро (`core/`), пакет объявлений (`contracts/`), адаптер Electron (`electron/`, пакет `@cyborg-harness/electron`) и стенд `playground/` поверх него. Цели и этапы задаёт [SAD](../03-architecture/design/sad.md#6-этапы); здесь - что из них сделано и что осталось. Перевод приложения Cyborg на харнес - план репозитория Cyborg, не этого.

Остаток до состояния «микроядро готово к системе плагинов» разложен по итерациям и задачам в [эпике](epic-microkernel.md) ([#15](https://github.com/dex-it/cyborg-harness/issues/15)).

Готово - значит закреплено тестом ядра (`core/test`) или playground (`playground/test`) и пройдено дымовым тестом окна (`npm run smoke`), а в SAD у цели стоит пометка «Сделано».

## 1. Этап 1: ядро без изоляции доступа

| Цель SAD | Сделано | Осталось |
|---|---|---|
| [3.1](../03-architecture/design/sad.md#31-воркспейс-как-главная-сессия) Воркспейс: замок, «Недавние», слои config | `core/src/workspace.ts`, `core/src/recent.ts` | включение без перезапуска плагина, которого не было в графе при запуске |
| [3.2](../03-architecture/design/sad.md#32-загрузка-плагинов) Загрузка, журнал, безопасный режим, ленивая активация | `core/src/loader.ts`, `core/src/graph.ts`, `core/src/status.ts` | - |
| [3.3](../03-architecture/design/sad.md#33-версии-и-миграции) Версии, `migrate`, схема раздела | `core/src/config.ts`, `core/src/json-schema.ts` | - |
| [3.4](../03-architecture/design/sad.md#34-связь-между-плагинами) Реестр контрактов и команд, права через контракт | `core/src/registry.ts`, `core/src/via-contract.ts` | - |
| [3.5](../03-architecture/design/sad.md#35-изоляция-сбоев-хосты-и-сторож) Хосты и сторож | `core/src/host-runtime.ts`, `core/src/transports.ts`, [замер](../04-verification/spike-hosts.md) | - |
| [3.6](../03-architecture/design/sad.md#36-ресурсы-дольше-плагина-pty) pty у ядра: `persist`, `attach`, билет вида | `core/src/pty.ts`, `electron/src/view-terminals.ts` | проверка на Windows |
| [3.7](../03-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) `ctx.os`, права словами, хранилище секретов, `$secret`, `granted` в state | `core/src/os-gateway.ts`, `core/src/permissions.ts` | источник секретов `cyborg.secret-source` плагином; удаление плагина в других воркспейсах ([вопрос 18](../03-architecture/design/sad.md#8-открытые-вопросы)) |
| [3.8](../03-architecture/design/sad.md#38-изоляция-рендера) `<iframe>` и `mount`, тема, элементы ядра, диалоги, замок, документы, порядок фокуса | `core/src/ui-shell.ts`, `core/src/window-layer.ts`, `core/src/documents.ts`, `core/src/layout.ts`, `core/elements/` | расстановка человека (порядок и области после перезапуска) в `state` |
| [3.9](../03-architecture/design/sad.md#39-системные-клавиши-и-события) Клавиши с переназначением, события окна и системы | `core/src/keys.ts`, `core/src/keybindings.ts` (в том числе `ctx.keys.register`), `core/test/keys-registry.test.ts`, `core/test/events.test.ts` | акселераторы меню окна - K-08 |
| [3.10](../03-architecture/design/sad.md#310-главный-конфиг-и-состояние) `config` и `state` по разделам | `core/src/config.ts`, `core/src/workspace.ts` | - |
| [5.3](../03-architecture/design/sad.md#53-восстановление-сессий) Контракт `cyborg.agent`, `agent-claude-code`, восстановление сессий | `contracts/agent.ts`, `playground/plugins/agent-claude-code`, `playground/plugins/sessions` | настройка `sessions.restore` (`lazy`, `eager`, `off`); `cwd` и `projectId` в данных сессии |

Дисциплина, которая держит путь ко второму этапу ([6.1](../03-architecture/design/sad.md#61-этап-1-ядро-без-изоляции-доступа)), проверяется тестами: импорты плагинов - `checkPlugin` (`core/src/plugin-check.ts`, команда `cyborg-plugin check`; тест репозитория - `core/test/plugin-imports.test.ts`), клонируемость данных вызова - канал ядра (`core/src/rpc.ts`).

## 2. Остаток этапа 1

| Работа | Состояние |
|---|---|
| Источник секретов `cyborg.secret-source` - плагин-поставщик по схеме ссылки | отложено владельцем до первого источника |
| Включение плагина, которого не было в графе при запуске | отложено владельцем; сейчас - запись «включатся после перезапуска» |
| Журнал вызовов `@deprecated` | сделано: `provides.<контракт>.deprecated`, запись `deprecated-call` в `checkCall`, `core/test/via-contract.test.ts` |
| Род области и `order` вида в манифесте ([3.8](../03-architecture/design/sad.md#38-изоляция-рендера)) | сделано (K-03): `ui.views.<имя>.area/order/title`, `documents.<тип>.area/order`, `Kernel.layout`; окно playground строит области по снимку |
| Набор тестов контракта, общий для всех поставщиков ([вопрос 10](../03-architecture/design/sad.md#8-открытые-вопросы)) | сделано для `cyborg.agent` (`agentContractSuite`, пакет `@cyborg-harness/testing`); для `cyborg.secret-source` и `cyborg.project-settings` - каркасы, рабочими станут с типами контрактов |
| Замеры на macOS: хосты и фреймы, клавиши во фрейме, шлюз `ctx.os` | хосты и фреймы сняты, [macos-check.md](../04-verification/macos-check.md); шлюз - нет, [spike-gateway.md](../04-verification/spike-gateway.md); клавиши и терминал человеком - [#2](https://github.com/dex-it/cyborg-harness/issues/2) |
| pty на Windows | не проверялся; в области ли Windows - [вопрос 12](../03-architecture/design/sad.md#8-открытые-вопросы) |
| Настройка `sessions.restore`, `cwd` и `projectId` сессии | подъём сейчас ручной |
| pty-хост - отдельный `utilityProcess` ядра, вывод к виду по `MessagePort` ([ADR-CH-0012](../03-architecture/adr/ADR-CH-0012-pty-host.md)) | не начато; `node-pty` и таблица pty в главном процессе |
| Льготное время осиротевшего pty ([3.6](../03-architecture/design/sad.md#36-ресурсы-дольше-плагина-pty)) | сделано в ядре: 60 с по умолчанию, `ptyOrphanGrace` |
| Группы рендера: `ui.group`, `plugins.uiGroups`, origin кадра по группе ([3.8](../03-architecture/design/sad.md#38-изоляция-рендера)) | не начато; origin кадра - по id плагина |
| Закрытая CSP вида `default-src 'none'` с явными источниками ([3.8](../03-architecture/design/sad.md#38-изоляция-рендера)) | не начато; `VIEW_CSP` - `default-src 'self'` |
| Форма API: вклады в меню, отмена запросов ([вопрос 15](../03-architecture/design/sad.md#8-открытые-вопросы)) | `ctx.keys.register` с условием сделан (K-07, [3.9](../03-architecture/design/sad.md#39-системные-клавиши-и-события)); меню и отмена - не начато |
| Сборка и упаковка плагина: `cyborg-plugin build` и `pack` ([поставка плагина](../03-architecture/design/sad.md#1-общая-архитектура)) | сделано (P-06): бандл главной части, виды, проверка состава, предварительный `tar.gz`; осталось: публикация пакета (P-10), загрузка поставки приложением (P-07, T-10), подпись и хеш (этап 2, вопрос 8) |

## 3. Стенд playground

| Работа | Зачем |
|---|---|
| Сжатие бандлов видов | вид `sessions` с xterm - 441 КБ без сжатия |
| `screenReaderMode` у xterm в `sessions` | терминал недоступен экранному диктору |
| Инлайн-стили вида по флагу манифеста | сейчас `style-src 'unsafe-inline'` у всех видов, а нужен только видам с xterm и Monaco |
| Видимость вида при переключении вкладок колонки | «Свернуть» сообщает виду `visible`, вкладка - нет |

## 4. Этап 2: изоляция доступа по поводу

Начинается, когда появится повод ([6.2](../03-architecture/design/sad.md#62-этап-2-изоляция-доступа-по-поводу)): плагин от автора вне команды, которому нужна установка, или каталог плагинов.

| Работа | Источник |
|---|---|
| Процесс на плагин (Electron как Node) с `--permission`; `utilityProcess` этот флаг не применяет | [6.2](../03-architecture/design/sad.md#62-этап-2-изоляция-доступа-по-поводу), [ADR-CH-0003](../03-architecture/adr/ADR-CH-0003-trust-and-isolation.md), п. 9 |
| `Compartment` вторым слоем в этих процессах; спайк `ses` сделан, осталась совместимость с бандлами плагинов (zod, marked) | [вопрос 7](../03-architecture/design/sad.md#8-открытые-вопросы) |
| Окна согласия на права теми же строками, что «Плагины Cyborg» | [3.7](../03-architecture/design/sad.md#37-безопасность-данных-и-контроль-плагинов) |
| Установка: источник, подпись или хеш, повторное согласие при расширении прав | [вопрос 8](../03-architecture/design/sad.md#8-открытые-вопросы) |

Если дисциплина первого этапа соблюдена, переход меняет среду выполнения хоста, а не код плагинов.
