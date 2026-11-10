# Плагины вне репозитория и из упакованной сборки

Задача [T-10](https://github.com/dex-it/cyborg-harness/issues/22). Вопрос: что случится с плагином, который лежит не в `playground/plugins`, а в каталоге пользователя, в каталоге поставки, в `node_modules` или внутри упакованного приложения (asar). До этой проверки всё было видно только на плагинах внутри репозитория, и автор рисковал получить плагин, который работает у разработчика и молча не грузится у пользователя.

Дата сверки: 2026-11-10 (macOS и Linux прогнаны 2026-11-09).

## Итог

- Хост грузит точку входа через `import()`. Тип модуля и снятие типов решает Node 24 по расширению и ближайшему `package.json`, поэтому правила для автора - это правила Node, а не ядра. Ядро их не меняет, но называет причину отказа в журнале.
- Не грузятся: `enum` и параметр-свойство конструктора в `.ts`; `.ts` под `node_modules` и `.ts`-зависимость из `node_modules`; импорт соседа без расширения; ESM-код в области `"type":"commonjs"`; модуль без `export default { activate }`; отсутствующий файл точки входа. Остальное грузится (таблица 1).
- Допущение из задачи, что `.js` без `"type":"module"` не загрузится, на Node 24 **неверно**: файл без `type` разбирается по синтаксису и грузится. Ломается только явный `"type":"commonjs"`. Но без `type` рядом с `package.json` Node пишет в stderr хоста предупреждение `MODULE_TYPELESS_PACKAGE_JSON` и разбирает файл дважды, поэтому правило для автора остаётся: `"type":"module"` или расширение `.mjs`.
- Упакованная сборка (asar) запускает плагины поставки и плагины пользователя: проверено на macOS и Linux (раздел 3). Выносить каталог поставки из asar не нужно.
- Правило «плагин-пакет из npm поставляется только скомпилированным в `.mjs`» подтверждено, и оно уже действует: `cyborg-plugin pack` требует `index.mjs` и отказывает на `.ts` ([P-06](https://github.com/dex-it/cyborg-harness/issues/42)); текст для автора - в разделе 5.

## 1. Матрица: тип файла

Тест [`core/test/external-plugins.test.ts`](../../core/test/external-plugins.test.ts): каждый вариант - плагин во временном каталоге вне репозитория, свой хост через `forkHosts`, ожидание - активен либо запись `failed` в журнале с причиной. Node 24.20.0, macOS. Столбец «причина» - то, что автор видит в журнале «Плагины Cyborg» (после T-10 перед сообщением Node стоит «точка входа <файл> не загрузилась», а в скобках - что менять).

| Вариант | Итог | Причина в журнале |
|---|---|---|
| `index.ts`, `package.json` нет | грузится | - |
| `index.ts`, `"type":"module"` в этом каталоге | грузится | - |
| `index.ts`, `"type":"module"` в каталоге выше | грузится | - |
| `index.ts`, `package.json` без `type` | грузится | - |
| `index.ts`, `"type":"commonjs"` | не грузится | `Unexpected token 'export'` + подсказка про `"type":"module"` и `index.mjs` |
| `index.js`, `"type":"module"` (здесь или выше) | грузится | - |
| `index.js`, `package.json` нет | грузится (определение синтаксиса) | - |
| `index.js`, `package.json` без `type` | грузится, в stderr хоста предупреждение `MODULE_TYPELESS_PACKAGE_JSON` | - |
| `index.js`, `"type":"commonjs"`, ESM-код | не грузится | `Unexpected token 'export'` + та же подсказка |
| `index.js`, `"type":"commonjs"`, `module.exports = {...}` | грузится | - |
| `index.mjs` (с любым `package.json`) | грузится | - |
| бандл `cyborg-plugin build` (`index.mjs`) | грузится | - ([`tools/cyborg-plugin/test/build.test.ts`](../../tools/cyborg-plugin/test/build.test.ts), каталог без `node_modules`) |
| `.ts` с `enum` | не грузится | `TypeScript enum is not supported in strip-only mode` + подсказка про стираемый синтаксис |
| `.ts` с параметром-свойством конструктора | не грузится | `TypeScript parameter property is not supported in strip-only mode` + та же подсказка |
| `.ts`, импорт соседнего `.ts` с расширением (`./helper.ts`) | грузится | - |
| `.ts`, импорт соседа без расширения (`./helper`) | не грузится | `Cannot find module '.../helper'` |
| точка входа не отдаёт `export default { activate }` | не грузится | «загружена, но не отдаёт объект с activate» |
| файла точки входа нет | не грузится | `Cannot find module '<путь>/index.mjs'` |

Отказ одного плагина другим не мешает: в тесте 24 плагина в 24 хостах, девять отказов, остальные 15 активны.

## 2. Матрица: источник

| Источник | `.ts` | `.js` / `.mjs` | Как проверено |
|---|---|---|---|
| Каталог пользователя `<userData>/plugins` (только с `--user-plugins`, [K-17](https://github.com/dex-it/cyborg-harness/issues/55)) | грузится, ограничения те же | грузится | тест из раздела 1 (каталог вне репозитория) и настоящий Electron (раздел 3) |
| Каталог поставки (`builtinDir`) | грузится | грузится | настоящий Electron, и в asar, и вне его |
| Внутри asar (`app.asar/.../plugins/<id>`) | грузится | грузится | настоящий Electron 45.2.2, macOS и Linux (раздел 3) |
| `node_modules` (плагин-пакет из npm) | **не грузится**: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | грузится, в том числе `.js` без `type` | тест `*-in-node-modules` в `core/test/external-plugins.test.ts` |
| `.ts` в каталоге плагина, импортирующий `.ts` из его `node_modules` | не грузится, та же ошибка | - | тест `ts-dependency-in-node-modules` |

Каталог плагинов пользователя ядро обходит на один уровень (`<userData>/plugins/<id>`), а ядро в `node_modules` не ищет: «плагин из `node_modules`» значит каталог, который приложение раскладывает туда само или доставляет пакетом npm. Правило одно: Node не снимает типы у файлов под `node_modules`, поэтому пакет поставляется собранным.

## 3. Упакованное приложение (asar)

**Как упаковывали.** В репозитории упаковщика нет (нет electron-builder и forge), поэтому проверка одноразовая и в репозиторий не добавлена: собранный `playground/dist` и `node_modules/node-pty` (`.node` и `spawn-helper` вынесены из asar) упакованы `@electron/asar pack` в `app.asar`; `main` - `playground/dist/main.js`. В `playground/dist/plugins` внутри asar добавлены шесть плагинов-вариантов (`in-*`), в `<userData>/plugins` вне asar - те же шесть (`ext-*`). Запуск: `electron app.asar --user-data-dir=<каталог> --user-plugins`, `plugins.enabled` перечисляет базовые плагины стенда и варианты. Результат читался из журнала ядра в stderr приложения (`[plugins] {...}`).

Варианты: `ts`, `js-module` (`"type":"module"` в каталоге плагина или выше), `js-typeless` (без `package.json` в каталоге; внутри asar тип задаёт `playground/dist/plugins/package.json`), `js-untyped-package` (`package.json` без `type`), `mjs`, `ts-enum`.

| Вариант | macOS: asar (поставка) | macOS: каталог пользователя | Linux: asar | Linux: каталог пользователя |
|---|---|---|---|---|
| `ts` | активен | активен | активен | активен |
| `js-module` | активен | активен | активен | активен |
| `js-typeless` | активен | активен | активен | активен |
| `js-untyped-package` | активен, предупреждение `MODULE_TYPELESS_PACKAGE_JSON` | активен, то же | активен, предупреждение `MODULE_TYPELESS_PACKAGE_JSON` | активен, то же |
| `mjs` | активен | активен | активен | активен |
| `ts-enum` | `failed`: «точка входа .../app.asar/.../index.ts не загрузилась: TypeScript enum is not supported in strip-only mode (...)» | `failed`, та же причина | `failed`, та же причина | `failed`, та же причина |

Базовые плагины стенда (поставка из asar) на macOS активны, кроме демонстрационного `flaky`, который падает по замыслу. `import()` из asar работает и для ESM, и для `.ts` без `asarUnpack` (проверено; типы снимаются, потому что путь не содержит `node_modules`). Вне asar нужен только `node-pty` (нативный `.node` и `spawn-helper`), и это уже решено: `electron-rebuild` и `--unpack` для `build/Release`.

Среда: macOS 27.2 (arm64), Electron 45.2.2 (Node 24.22.2, Chromium 156.0.8078.80). Linux: Debian (образ `node:24`) в OrbStack, aarch64, тот же Electron 45.2.2 (Node 24.22.2, Chromium 156.0.8078.80), `xvfb-run`, `--no-sandbox`; приложение работало до `timeout` (код 124 - так и задумано), результат читался из `[plugins]` в stderr. Архитектура x64 вручную не запускалась: CI на `ubuntu-24.04` гоняет `smoke`, но не варианты T-10.

## 4. Что исправлено в коде

- **Хост** ([`core/src/entry-load.ts`](../../core/src/entry-load.ts)): отказ загрузки точки входа называет файл (`точка входа <url> не загрузилась: <сообщение Node>`) и для известных причин - что менять (стираемый синтаксис, `.ts` под `node_modules`, ESM в области `"type":"commonjs"`); модуль без `export default { activate }` получает своё сообщение вместо «Cannot read properties of undefined». Хост на `child_process`, хост на `utilityProcess` и `inlineHosts` идут через одну функцию в `host-runtime`.
- **`discoverPlugins`** ([`electron/src/plugins.ts`](../../electron/src/plugins.ts)): нет файла точки входа - в `problems` строка «нет точки входа (ищутся index.mjs, index.js, index.ts)», а ядру отдаётся путь первого кандидата, и журнал называет файл, которого нет, вместо «Cannot find package '<id>'»; каталог с именем `index.mjs` точкой входа не считается; несколько точек входа в каталоге - в `problems` сказано, какая загружается («точек входа несколько (index.js, index.ts), загружается index.js»); набор имён `ENTRY_FILES` совпадает с набором `check` и `build` (тест).

## 5. Ограничения плагина на `.ts` (текст для P-04)

Передан в [P-04](https://github.com/dex-it/cyborg-harness/issues/38) ссылкой на этот раздел; формулировки - готовый текст для руководства автора.

> **Главная часть на `.ts` без сборки.** Ядро грузит её через `import()`, а Node 24 снимает типы сам и только стираемые. Поэтому:
>
> - нельзя `enum`, `namespace` с кодом и параметры-свойства конструктора (`constructor(private x: number)`): плагин не загрузится, в журнале будет «TypeScript enum is not supported in strip-only mode». Используйте объект с `as const`, объявите поле и присвойте его в теле конструктора. В `tsconfig` включите `erasableSyntaxOnly`, тогда компилятор покажет эти места до запуска.
> - импорты своих файлов пишите с расширением: `import { x } from './helper.ts'`; `./helper` Node не найдёт.
> - рядом с плагином должен быть `package.json` с `"type":"module"` (или в каталоге выше), иначе при явном `"type":"commonjs"` ESM-код не разберётся. Без `type` плагин тоже грузится, но Node пишет предупреждение и разбирает файл дважды.
> - типы не снимаются у файлов под `node_modules`: плагин, лежащий в `node_modules`, и `.ts`-зависимость внутри него не загрузятся. Плагин-пакет из npm поставляется только скомпилированным в `.mjs`; `cyborg-plugin build` собирает такой каталог, а `cyborg-plugin pack` отказывает, если в нём есть `.ts` или нет `index.mjs`.
> - точка входа - первый из `index.mjs`, `index.js`, `index.ts`; если лежат несколько, загружается первый, а «Плагины Cyborg» покажут предупреждение.
>
> Собранный `cyborg-plugin build` каталог (`index.mjs`, зависимости внутри) этих ограничений не имеет: бандл - обычный ESM.

## 6. Что не проверено

- Подписанное приложение и нотаризация macOS: упаковка одноразовая и без подписи; поведение `import()` из подписанного asar не проверено.
- Windows: не входил в задачу.
- Упаковщик (electron-builder, forge) и `asarUnpack` каталога поставки: не настраивались, потому что `import()` из asar работает без них; если упаковщик положит плагины иначе, проверку нужно повторить.
- `node-pty` в упакованной сборке: на macOS его собирал `electron-rebuild`; на Linux сборка из репозитория не пересобиралась, нативный модуль в проверке не участвовал (плагин `sessions` вне вариантов T-10).
- Node другой мажорной версии, чем в Electron 45 (Node 24): плагины `.ts` рассчитаны именно на 24; вопрос версий - в `engines.node` ([P-02](https://github.com/dex-it/cyborg-harness/issues/34)).
