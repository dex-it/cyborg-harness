---
level: story
id: ST-2007
feature: 02-extension-contracts
status: review
date: 2026-11-10
origin: derived
traced from: BR-CH-001
---

# ST-2007 Ядро не называет плагины по именам

Как разработчик поставки, я хочу добавлять встроенный плагин без правки `core/src`, чтобы ядро не знало, какие плагины в поставке.

Нормы: FR-CH-2021. Сценарии: UC-EXTENSION-CONTRACTS-2001. SRS - [srs.md](../srs.md).

## Критерии приёмки

1. [FR-CH-2021] [UC-EXTENSION-CONTRACTS-2001#7]
   - Дано встроенный плагин добавлен в `plugins.enabled` поставки и идёт в хост `builtin`
   - Когда разработчик собирает приложение
   - Тогда `core/src` не менялся; в коде ядра нет имён плагинов
2. [FR-CH-2021]
   - Дано новый встроенный плагин в репозитории
   - Когда разработчик прогоняет `npm test` (в нём проверка импортов `core/test/plugin-imports.test.ts`), `npm run typecheck`, `npm run lint`, `npm run smoke`
   - Тогда все гейты зелёные без правок ядра
