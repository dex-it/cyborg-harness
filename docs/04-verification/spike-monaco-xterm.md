---
level: verification
feature: cyborg-harness
status: review
date: 2026-11-08
origin: derived
quality-checks: входных записей нет
---

# Пилот PL-05: Monaco и xterm во фреймах на cyborg-plugin://

Задача [#25](https://github.com/dex-it/cyborg-harness/issues/25), остаток [открытого вопроса 11 SAD](../03-architecture/design/sad.md#8-открытые-вопросы). Итог по критериям - в конце документа.

## Как мерили

- Monaco 0.57.0 (лицензия MIT; в зависимостях `dompurify` 3.4.15 с открытыми advisory `npm audit` - исправления в релизах Monaco нет), собран esbuild в `playground/plugins/editor/ui/ui.js` (ESM, 9,5 МБ без сжатия, 4,5 МБ минифицированный, 1,2 МБ gzip) и `ui.css`; значки - `codicon-*.ttf` рядом. Воркеры - пять отдельных файлов `ui/workers/{editor,json,css,html,ts}.worker.js` (классические скрипты), создаются `new Worker(new URL('./workers/…', import.meta.url))` по `MonacoEnvironment.getWorker`.
- Пробный плагин `editor` (`playground/plugins/editor`): файлы `settings.json`, `sample.ts` (ошибка типа в конце) и `broken.json` (синтаксическая ошибка) в каталоге данных плагина; команды `editor.files/open/save/check`. Проверку схемы настроек делает главная часть (`check.ts`), вид показывает её ответ маркерами Monaco (владелец `owner`), как в Cyborg для редактора кнопок.
- Замер: `npm run spike:monaco -- csp` (`playground/scripts/spike-monaco.mjs`): для каждого набора директив запускает playground с `--view-csp=<набор>`, открывает вкладку «Виды», ждёт файл, маркеры от воркеров, шрифт значков и сессию xterm; нарушения CSP берёт из консоли окна. Среда: macOS (Apple Silicon), Electron 45, Node 24.20. Наборы директив сняты только на macOS; smoke на macOS и Linux в CI проходит те же сценарии под `VIEW_CSP`, а не под закрытым набором.

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
- `'unsafe-inline'` в `style-src` нужен: Monaco и xterm создают `<style>` и ставят атрибуты `style` (нарушения `style-src-elem` и `style-src-attr` без него). Это набор для видов с xterm и Monaco: по [дорожной карте](../05-plans/roadmap.md#3-стенд-playground) инлайн-стили вид получает по флагу манифеста (K-05), остальным видам `'unsafe-inline'` не нужен.
- `font-src 'self'` нужен Monaco (шрифт значков); `img-src data:` - Monaco (без него нарушение, редактор работает); `connect-src`, `frame-src`, `object-src` не понадобились.
- CSP по умолчанию в [SAD 3.8](../03-architecture/design/sad.md#38-изоляция-рендера) и [ADR-CH-0007](../03-architecture/adr/ADR-CH-0007-plugin-ui.md) (п. 2) не содержит `font-src`: под ней `default-src 'none'` закрывает шрифт значков Monaco.

## Типы файлов, которые отдаёт схема

К `.html .js .css .svg .png` добавлен `.ttf` (`font/ttf`, `electron/src/view-files.ts`; тест в `electron/test/view-files.test.ts`). Других расширений у Monaco и xterm нет: воркеры - `.js`, таблицы - `.css`. `.woff2`, `.map`, `.wasm` по-прежнему не отдаются.

## Проверка владельца

Вид `editor` не знает схему: при изменении текста через 150 мс зовёт `editor.check`, ответ `[{line, column, message}]` ставится маркерами Monaco (владелец `owner`). Схема настроек покрыта тестами (`playground/test/editor-check.test.ts`, `editor-plugin.test.ts`). В живом окне (smoke): правка `fontSize` до 99 клавишами даёт маркер `owner:2:fontSize - число от 8 до 32`, «Сохранить» уходит командой `editor.save`, повторное открытие файла несёт правку. Файлы `broken.json` и `sample.ts` нарочно с ошибками: маркеры `json:` и `typescript:` приходят из воркеров, то есть воркеры не только запущены, но и отвечают.

## `sandbox` без `allow-same-origin`

Кадр с `sandbox="allow-scripts"` (`npm run spike:monaco -- sandbox`, macOS):

| Плагин | Результат |
|---|---|
| editor (Monaco) | **не работает.** Оболочка вида собралась, но модуль не открылся: «main не открылся - не вид плагина». Главный процесс узнаёт вид по origin кадра; у кадра без `allow-same-origin` origin непрозрачный, и мост его отклоняет. Редактора нет |
| sessions (xterm) | то же: «не вид плагина», ни списка агентов, ни терминала |
| оба, `allow-scripts allow-same-origin` (контроль) | работают: Monaco открыл `settings.json`, список агентов виден |

Кроме того, без `allow-same-origin` `localStorage` и IndexedDB бросают `SecurityError` (с ним - работают). Вывод: `sandbox` без `allow-same-origin` для видов с Monaco и xterm не годится, пока мост опознаёт плагин по origin кадра (K-04: изоляция DOM между плагинами группы остаётся статической проверкой, а границей доверия - группа/origin).

## Буфер обмена (macOS и Linux)

Шаг smoke «буфер обмена» (`playground/scripts/smoke.mjs`) печатает итог на каждой ОС. **Linux** (ubuntu-24.04, Xvfb, CI): `role: copy` и `role: paste` из меню Edit **сработали сами** в Monaco и xterm (`{"copy":true,"paste":true}`), `navigator.clipboard` - `NotAllowedError`, как на macOS. **macOS** (локально):

- **Monaco и xterm принимают `copy` и `paste`**: после выделения (Cmd+A в Monaco, тройной щелчок по строке xterm) `webContents.copy()` кладёт текст в системный буфер, `webContents.paste()` вставляет текст из буфера в Monaco и в pty через xterm. Это то, что делает `role: copy/paste` на Linux и Windows для сфокусированного вложенного кадра.
- **macOS в CI** (раннер без ключевого окна ОС): `webContents.copy()/paste()` до вложенных кадров не доходят, поэтому в CI на macOS отказ этого канала пишется в журнал smoke, а не валит шаг; на macOS проверка идёт локально (строго), на Linux - в CI (строго).
- **Сама `role` из меню на macOS в этом прогоне не сработала** (`{"copy":false,"paste":false}`): на macOS role шлёт действие первому ответчику AppKit, а окно под управлением CDP не было ключевым. Это ограничение способа проверки (нажатие настоящего пункта меню живой клавиатурой не снималось), а не вывод о кадре: прямой вызов того же действия работает.
- **`navigator.clipboard` из кадра вида без атрибута `allow` недоступен**: политика разрешений кадра отвечает `clipboard-read` и `clipboard-write` = нет, и `writeText`/`readText` бросают `NotAllowedError` («blocked because of a permissions policy»). С атрибутом `allow="clipboard-read; clipboard-write"` на `<iframe>` в кадре с фокусом оба вызова работают (`npm run spike:monaco -- sandbox`, Linux; macOS не проверялся); без фокуса документа - `NotAllowedError: Document is not focused`. Терминалу это не мешает: xterm работает через события `copy` и `paste`, которые идут от меню и клавиш. Плагину, которому буфер нужен из кода (r15 - копирование из терминала по OSC 52), годятся `ctx.os.clipboard` главной части или `navigator.clipboard` при атрибуте `allow` на кадре вида.

## Память и время открытия (macOS footprint, Linux PSS)

`npm run spike:monaco -- memory`: окно без `editor` и с ним (`editor` открывает `settings.json`), по три запуска, медианы, открыты обе сессии. Linux снят в CI (ubuntu-24.04, Xvfb, шаг «пилот», PSS), macOS - локально (footprint); меры разные, сравнивать порядок величины.

| | macOS без editor | macOS с editor | Linux без editor | Linux с editor |
|---|---|---|---|---|
| Процессов Electron | 15 | 16 | 15 | 16 |
| Все процессы, МБ | 521 (502-535) | 649 (585-662) | 582 | 708 |
| Процесс кадра editor, МБ | - | 96 | - | 89 |
| Процесс кадра sessions (xterm), МБ | 29 | 29 | 35 | 32 |
| От начала навигации кадра до исполнения `mount`, мс | - | 234 | - | 583 |
| До первого отрисованного файла, мс | - | 314 | - | 724 |

Вид с Monaco стоит ~90-96 МБ своего процесса рендера против 29-35 МБ вида с xterm; прирост по всем процессам +126-128 МБ. Для сравнения, пустой фрейм из [spike-iframe-ui.md](spike-iframe-ui.md) стоит +13-22 МБ PSS (macOS footprint 22-34 МБ): Monaco добавляет ещё ~60-75 МБ к цене фрейма. Воркеры живут в потоках того же процесса, процессов не добавляют (15 -> 16: только процесс кадра). Размеры сборки без сжатия: `ui.js` 9,5 МБ (минифицированный 4,5 МБ, gzip 1,2 МБ), `ui.css` 0,2 МБ, воркеры `editor` 0,6, `json` 0,9, `css` 1,9, `html` 1,3, `ts` 12,8 МБ (грузится, только когда открыт файл TypeScript). Время получено при неминифицированной сборке на загруженной машине (macOS) и на раннере CI (Linux).

## Итог по критериям #25

- Monaco открывает и редактирует файл во фрейме на `cyborg-plugin://`, подсветка и воркеры работают, ошибок CSP нет: закрыто (smoke).
- xterm и Monaco в одном окне: закрыто (smoke).
- Минимальный набор директив CSP и типов файлов: закрыто (раздел выше).
- `sandbox` без `allow-same-origin`: закрыто (не работает, раздел выше).
- `role: copy/paste` и буфер обмена: Linux - закрыто (smoke в CI); macOS - частично: `copy`/`paste` в кадре работают прямым `webContents.copy()/paste()` (локально), сама `role` меню под CDP не сработала, нажатием настоящего пункта меню не проверена.
- Память и время: macOS и Linux сняты, сопоставлено с ценой фрейма (раздел выше).
- Вопрос 11 SAD обновлён: закрыт (`sandbox` не годится, воркеры работают под строгой CSP).
