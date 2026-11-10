---
level: verification
feature: cyborg-harness
status: draft
date: 2026-11-10
origin: derived
---

# План верификации

Подход и уровни проверки Cyborg Harness. Что именно проверяет каждая команда и какие тесты за ней стоят - в руководстве [«Тесты и CI»](../guide/development/tests-ci.md); здесь только план: что проверяется на каком уровне и чем доказывается норма. Метод проверки каждой нормы записан в её поле `verification` в [SRS фич](../03-requirements/README.md); критерии приёмки по ветвям сценариев - в историях (`stories/` фичи), полнота с двух сторон - в [таблице покрытия](../03-requirements/coverage.md).

## Подход

- Норма (FR, NFR) закрыта, когда у неё есть проверка, падающая на коде, где норма нарушена. Тест пишется до правки и показывается красным.
- Ядро проверяется без Electron и без сети; всё, что без настоящего окна проверить нельзя, проверяет дымовой тест.
- Число, заявленное нормой (память, задержка, бюджет), доказывается замером в [`05-verification/`](.) с командой, средой и датой; замер на другой платформе - отдельная строка.
- Все семь фич идут в регресс: проверки не снимаются вместе с задачей, которая их завела.

## Уровни

| Уровень | Чем | Где | Когда |
|---|---|---|---|
| Статика | `npm run typecheck`, `npm run lint` (strictTypeChecked, ноль предупреждений) | весь репозиторий | каждый PR, CI |
| Модульные и сценарные | `npm test` (`node:test`): ядро, контракты, адаптер Electron, тест-кит, `cyborg-plugin`, шаблон | `core/test`, `contracts/test`, `electron/test`, `testing/test`, `playground/test`, `tools/cyborg-plugin/test`, `templates/plugin/test` | каждый PR, CI на macOS и Linux |
| Границы доверия | подделки сообщений хоста, недоверенный ввод, шлюз `ctx.os`, секреты вне журнала | `core/test/trust.test.ts`, `untrusted-input`, `security-gateway`, `secrets-journal` и другие | каждый PR |
| Снимок API | эталон `core/test/api-snapshot/<версия>.txt`, `npm run check:contracts` | `core/test/api-snapshot.test.ts`, `contracts/` | каждый PR; правила - `contracts/README.md` |
| Окно | `npm run smoke`: настоящий Electron под DevTools Protocol, хосты, виды во фреймах, CSP, слой окна, воркспейс, шаблон плагина | `playground/scripts/smoke.mjs` | каждый PR, CI на macOS и Linux |
| Пакеты | установка собранных архивов в пустой проект; `cyborg-plugin check`, `build`, `pack` на шаблоне | `core/test/consumer.test.ts`, `testing/test`, шаг CI «шаблон плагина» | каждый PR |
| Покрытие требований | `npm run check:docs-trace`: каждая норма дала критерий приёмки, каждая ветка сценария покрыта критерием или названа открытой; таблица - [coverage.md](../03-requirements/coverage.md) | `scripts/check-docs-trace.ts`, шаг CI «ссылки в docs», `scripts/test/check-docs-trace.test.ts` | каждый PR, CI |
| Замеры | память хоста и кадра, задержка, шлюз, pty, Monaco и xterm | [спайки и замеры](../README.md#где-что) в этой папке, скрипты `npm run spike*`; бюджет шлюза в CI - `spike:gateway` | при изменении устройства, которое влияет на число |
| Ручная проверка | клик и настоящая клавиатура на macOS, живой `claude` (`CYBORG_SMOKE_CLAUDE`) | [macos-check.md](macos-check.md) | перед выпуском |

## Критерий готовности изменения

Зелёные сборка, типы, линтер, тесты и дымовой тест; покрытие ветвей новых файлов не ниже 75% (`node --test --experimental-test-coverage`); изменённое поведение закреплено тестом, красным до правки; затронутые документы (SRS, SAD, ADR, руководство) приведены к коду.

## Не входит

- Нагрузочные испытания приложения вне ядра: бюджеты старта и памяти не заданы числами ([дорожная карта](../06-plans/roadmap.md)).
- Файлы `.feature`: в корпусе их нет, это производная форма критериев приёмки, собираемая по запросу ([отступления от раскладки](../README.md#отступления-от-раскладки)).
