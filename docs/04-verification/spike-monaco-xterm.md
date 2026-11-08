---
level: verification
feature: cyborg-harness
status: draft
date: 2026-11-08
origin: derived
quality-checks: замер снят на одной машине (macOS); разделы «не проверено» открыты
---

# Пилот PL-05: Monaco и xterm во фреймах на cyborg-plugin://

Задача [#25](https://github.com/dex-it/cyborg-harness/issues/25), остаток [открытого вопроса 11 SAD](../03-architecture/design/sad.md#8-открытые-вопросы). Статус: **часть снята, часть не проверена** (список в конце).

## Как мерили

- Monaco 0.57.0 (лицензия MIT; в зависимостях `dompurify` 3.4.15 с открытыми advisory `npm audit` - исправления в релизах Monaco нет), собран esbuild в `playground/plugins/editor/ui/ui.js` (ESM, 9,9 МБ без сжатия, 4,5 МБ минифицированный, 1,2 МБ gzip) и `ui.css`; значки - `codicon-*.ttf` рядом. Воркеры - пять отдельных файлов `ui/workers/{editor,json,css,html,ts}.worker.js` (классические скрипты), создаются `new Worker(new URL('./workers/…', import.meta.url))` по `MonacoEnvironment.getWorker`.
- Пробный плагин `editor` (`playground/plugins/editor`): файлы `settings.json`, `sample.ts` (ошибка типа в конце) и `broken.json` (синтаксическая ошибка) в каталоге данных плагина; команды `editor.files/open/save/check`. Проверку схемы настроек делает главная часть (`check.ts`), вид показывает её ответ маркерами Monaco (владелец `owner`), как в Cyborg для редактора кнопок.
- Замер: `npm run spike:monaco -- csp` (`playground/scripts/spike-monaco.mjs`): для каждого набора директив запускает playground с `--view-csp=<набор>`, открывает вкладку «Виды», ждёт файл, маркеры от воркеров, шрифт значков и сессию xterm; нарушения CSP берёт из консоли окна. Среда: macOS (Apple Silicon), Electron 45, Node 24.20.

## CSP: что нужно Monaco и xterm

| Набор | Monaco | xterm | Нарушения |
|---|---|---|---|
| `VIEW_CSP` сейчас | работает: подсветка, воркеры json и ts дали маркеры | работает | нет |
| `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'` | работает так же, воркеры json и ts дали маркеры | работает | нет |
| то же + `worker-src 'self'` | работает | работает | нет |
| без `font-src` | значки (`codicon.ttf`) не грузятся | работает | `default-src` |
| без `img-src data:` | работает | работает | `img-src` |
| `style-src` без `'unsafe-inline'` | работает, но Monaco и xterm бьются о CSP | работает | `style-src-elem`, `style-src-attr` |
| `worker-src blob:` вместо файлов | воркеры из файлов отклонены, json-маркера нет | работает | `worker-src` |

**Минимальный набор для Monaco и xterm** (для K-05):

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'
```

- `worker-src` отдельно не нужен: воркеры - файлы того же origin, директива берётся из `script-src 'self'`. Явный `worker-src 'self'` безвреден.
- `blob:` не нужен нигде, а воркер из `blob:` при этом наборе отклоняется (проверено: `new Worker(blob:)` не стартует). Это требует `MonacoEnvironment.getWorker` с воркерами-файлами.
- `'unsafe-inline'` в `style-src` нужен: Monaco и xterm создают `<style>` и ставят атрибуты `style` (нарушения `style-src-elem` и `style-src-attr` без него).
- `font-src 'self'` нужен Monaco (шрифт значков); `img-src data:` - Monaco (без него нарушение, редактор работает); `connect-src`, `frame-src`, `object-src` не понадобились.

## Типы файлов, которые отдаёт схема

К `.html .js .css .svg .png` добавлен `.ttf` (`font/ttf`, `electron/src/view-files.ts`; тест в `electron/test/view-files.test.ts`). Других расширений у Monaco и xterm нет: воркеры - `.js`, таблицы - `.css`. `.woff2`, `.map`, `.wasm` по-прежнему не отдаются.

## Проверка владельца

Вид `editor` не знает схему: при изменении текста через 150 мс зовёт `editor.check`, ответ `[{line, column, message}]` ставится маркерами. Проверка схемы настроек покрыта тестом `playground/test/editor-check.test.ts`. Сама цепочка вида в живом окне (правка `fontSize` -> маркер владельца) написана в smoke, но локально **не прогонялась**.

## Не проверено (критерии #25 не закрыты)

- Вариант `sandbox` без `allow-same-origin` для Monaco и xterm: раздел `sandbox` скрипта написан, не запускался.
- `role: copy/paste` меню Edit и `navigator.clipboard` в терминале (macOS и Linux): шаги написаны в smoke, не запускались, на Linux не гонялись.
- Память и время открытия вида с Monaco (footprint на macOS, PSS на Linux), сопоставление с ценой фрейма из [spike-iframe-ui.md](spike-iframe-ui.md): раздел `memory` скрипта написан, не запускался. Из замеров есть только размеры сборки (выше) и время «файл нарисован» порядка 1,0-1,1 с от начала навигации фрейма при неминифицированной сборке (диагностические прогоны, не медиана).
- Smoke с новыми шагами (Monaco и xterm одновременно): не прогонялся; локально smoke падает на шаге фокуса и на чистой базе.
- Вопрос 11 SAD: остаток назван (sandbox, буфер обмена, память), закрыт не полностью.
