# Журнал изменений @cyborg-harness/contracts

Формат - [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии - [semver](https://semver.org/lang/ru/) по правилам из [README](README.md#установка-и-версии). Запись обязательна в каждом изменении, которое меняет `api-snapshot.txt`.

## Правило записи

- Каждое изменение карты `Contracts`, `PluginContext`, `UiContext`, `PluginPermissions` или другого экспортируемого типа - строка в разделе `Unreleased` в том же PR.
- Строка начинается с затронутого имени в обратных кавычках и называет, что повышает версию: `[major]`, `[minor]` или `[patch]`.
- Для контракта (`cyborg.agent`) добавляется его мажорная версия: `cyborg.agent` v1.
- При выпуске `Unreleased` переименовывается в номер версии и дату (`## 1.1.0 - 2026-12-01`), версия в `package.json` и в `api-snapshot.txt` повышается тем же коммитом.

## Unreleased

### Добавлено
- Пакет собирается в декларации (`dist/*.d.ts`) без расширений `.ts` в путях и ставится по номеру версии; в `exports` только условие `types`, кода выполнения в пакете нет.
- Снимок деклараций `api-snapshot.txt` и проверка `npm run check:contracts`: изменение публичных типов без повышения версии пакета - ошибка CI.

## 1.0.0 - не выпущена

Первая версия набора: `cyborg.agent` v1, `cyborg.agent-tool` v1, `cyborg.session-prompt` v1, API плагина (`PluginModule`, `PluginContext`, `UiModule`, `UiContext`), `ctx.os`, элементы ядра `cy-*`. Выпуск в реестр - задача P-10 после заморозки API (K-21).
