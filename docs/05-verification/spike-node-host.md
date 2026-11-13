# Спайк TR-20: хост плагинов как процесс Node против utilityProcess

Результат задачи TR-20 ([#248](https://github.com/dex-it/cyborg-harness/issues/248), этап В1 стека [#243](https://github.com/dex-it/cyborg-harness/issues/243)), 2026-11-13. Исследование: [план, TR-20](../research/trust-and-isolation/06-work-plan.md#62-задачи), [5.3, п. 2, 3 и 5](../research/trust-and-isolation/05-decision.md), [вопрос 2](../research/trust-and-isolation/07-open-questions.md#71-вопросы-владельцу), [7.2, п. 5 и 6](../research/trust-and-isolation/07-open-questions.md#72-что-не-проверено), [опыты Б.1 (Г)](../research/trust-and-isolation/08-sources-and-measurements.md). Решение по итогам - [ADR-CH-0018](../04-architecture/adr/ADR-CH-0018-node-host-fuses-agent-config.md). Образец замера - [spike-hosts.md](spike-hosts.md).

## Вердикт

| Вопрос | Ответ |
|---|---|
| Работает ли весь протокол ядра в процессе Node под `--permission` с пустым `env`? | **Да, если канал `advanced` читают обе стороны.** Вызов, исключение, клонирование (`Map`, `Set`, `Date`, `BigInt`, `Uint8Array`, `Error`), отказ на функции (`NotCloneable`), пинг сторожа, зависание, падение, перезапуск - работают и под запретами (`core/test/fork-permission.test.ts` на Node 24 без Electron; весь замер на ядре в Electron - ниже) |
| **Но** отдельный бинарник Node с каналом `advanced` не работает | V8 в Electron 45.2.3 - 15.6, в Node 24.x - 13.6; хост на отдельном Node выходит с кодом 1 на первом сообщении ядра (сериализация нового V8 не читается старым). Канал `json` работает, но теряет типы structuredClone (таблица клонирования). **Это главный результат спайка:** TR-21 на отдельном Node начинается с кодека типов, см. [ADR-CH-0018](../04-architecture/adr/ADR-CH-0018-node-host-fuses-agent-config.md), п. 4 |
| Бюджеты шлюза (`ctx.os` не более 1 мс на p99 до 64 КиБ, NFR-CH-1001) | **Node (канал json) укладывается на Linux, Электрон как Node - нет.** `ctx.os.fs.readText` 64 КиБ, p99 по трём прогонам, мс. Linux: utilityProcess 0,75-0,79, Node 0,74-0,88, Электрон как Node 0,94-1,30. macOS (нагрузка, load average около 20): 0,69-0,86, Node 0,69-4,9 (два прогона из трёх со всплесками, в остальных ячейках их нет), Электрон как Node 0,60-1,24. Это весь круг плагин -> ядро -> шлюз -> плагин; бюджет 1 мс относится к цене шлюза за вычетом голого действия (чтение 64 КиБ - сотые доли миллисекунды: [spike-gateway.md](spike-gateway.md)), так что запас у Node на Linux есть, а у Электрона как Node - 0,2-0,5 мс сверх `utilityProcess` (причина не выяснялась). Разница p50 с `utilityProcess` не больше 0,17 мс. Хвост вызова контракта между хостами при 64 КиБ через json - 1,75 мс на Linux (p50 0,54). Блокирующая проверка `npm run check:budgets` остаётся за TR-21: там замер идёт на реальном способе запуска |
| Память и старт (порогов у владельца нет, предложение «не хуже базы на 10%») | **Не хуже `utilityProcess`.** Linux: PSS на хост 39 МБ у Node против 58 МБ у `utilityProcess` для первого хоста и 28,5 против 41,9 МБ на хост при пяти (-32%), RSS 64 против 115 МБ; старт хоста до `activated` 44 против 49 мс. macOS (мера другая - `footprint`): 34 МБ против 27 МБ (+7 МБ), RSS 72 против 85 МБ; старт 63 против 88 мс. Базы Cyborg по хостам для сравнения «+10%» нет ([cyborg-baseline.md](cyborg-baseline.md) память хостов не измеряла), порог владелец не задал. |
| `RunAsNode` против отдельного бинарника | **Отдельный бинарник Node, `RunAsNode` выключен** (Node 116-118 МБ поверх приложения 253 МБ на macOS и 279 МБ на Linux, +42-46%). Режим Node в бинарнике приложения даёт любому процессу пользователя личность приложения; цена - размер, своя подпись и кодек типов для канала `json` |
| Способ загрузки проверенных байтов | `module.registerHooks` (граф модулей из памяти; адреса `file:` или своя схема) или `data:` URL (один файл) работают под `--permission`, когда хост читать каталог плагина не может; **хук должен быть и `resolve`, и `load`** (одного `load` этапа Б под `--permission` мало); повторное открытие файла - `ERR_ACCESS_DENIED` |
| Что в итоге брать для TR-21 | Отдельный Node, `--permission`, пустой `env`, канал `json` с кодеком типов, загрузка через `registerHooks`; запасной путь стенда - Electron в режиме Node |

## Как мерили

- Код: `playground/src/main/spike-node-host.ts` (замеры в главном процессе Electron на настоящем ядре, как в приложении; хосты - `utilityHosts` и `forkHosts`), `playground/scripts/spike-node-host.mjs` (запуск, три части и медиана прогонов), `spike-node-host-load.mjs` (загрузка байтов), `spike-node-host-binary.mjs` (размер, подпись, фьюз), `fuses.mjs` (чтение и переключение фьюзов без пакета `@electron/fuses`). Плагины замера - `playground/bench` (поставщик, потребитель и пустой плагин из [spike-hosts.md](spike-hosts.md); новые `os-read.ts` и `clone.ts`). Запуск: `npm run spike:node-host -- --runs=3 --node-bin=<node>`; на Linux - `xvfb-run … -- --no-sandbox`.
- Режимы: **utilityProcess** - как сегодня; **Node, advanced** - отдельный бинарник Node, `--permission`, пустой `env`, канал `advanced` (не запускается, см. вердикт); **Node, json** - то же с каналом `json`; **Электрон как Node** - бинарник Electron под `ELECTRON_RUN_AS_NODE=1`, `--permission`, из `env` только этот флаг, канал `advanced`. Хосту разрешено читать каталог бандла хоста и каталог плагинов замера (`--allow-fs-read=…`), без `--allow-child-process`, `--allow-worker`, `--allow-addons`.
- Каждая ячейка - медиана трёх прогонов приложения (как у бюджетов шлюза: `playground/budgets.json`). Вызов - 300 вызовов после 30 разогревочных; `ctx.os.fs.readText` - тоже 300, файл заданного размера читает шлюз по праву `fs.read`; старт - девять запусков нового ядра с одним пустым плагином до записи `activated`; сторож - три попытки на строку.
- **Оговорка по шуму.** macOS: ноутбук под параллельной нагрузкой, load average около 20 (десять ядер), справочная платформа ([budgets.json](../../playground/budgets.json): блокирует Linux). Хвосты p99 при таких условиях шумят (у Node (json) в двух прогонах из трёх p99 вышел 3-7 мс при p50 в полмиллисекунды), поэтому выводы строятся на p50, на повторяемости по трём прогонам и на Linux; контейнер Linux шёл на том же ноутбуке, нагруженность хоста на него влияла меньше, но не исключена.

## Результаты: macOS (справочная платформа)

Среда: macOS 27.2, Electron 45.2.3, Node 24.22.2 внутри, darwin-arm64, Apple M1 Pro (10 ядер); отдельный Node 24.20.0. Прогонов: 3 (медиана каждой ячейки). Столбцы «PSS» на macOS - физический след (`footprint`), мера другая, чем PSS на Linux; сравнивать режимы можно внутри платформы.

### Старт, память, сторож

| Режим | Старт хоста до activated, мс (p50 / p95) | PSS на хост (1 хост), МБ | RSS (1 хост), МБ | PSS на хост (5 хостов), МБ | Сторож 1000/5000: зависание, мс | падение, мс | перезапуск после падения, мс |
|---|---|---|---|---|---|---|---|
| utilityProcess | 88,3 / 93,2 | 27 | 84,7 | 27 | 5413 | 5 | 90 |
| Node, json | 63,1 / 75,1 | 34 | 72,1 | 34 | 5413 | 2 | 59 |
| Electron как Node (RunAsNode) | 90,4 / 98,2 | 25 | 77,7 | 25 | 5390 | 5 | 91 |

### Вызов из главного процесса в хост (команда), мс

| Режим | 64 Б p50 / p99 | 4 КиБ p50 / p99 | 64 КиБ p50 / p99 |
|---|---|---|---|
| utilityProcess | 0,051 / 0,147 | 0,063 / 0,146 | 0,129 / 0,219 |
| Node, json | 0,058 / 0,223 | 0,066 / 0,189 | 0,232 / 0,492 |
| Electron как Node (RunAsNode) | 0,051 / 0,295 | 0,058 / 0,295 | 0,167 / 0,346 |

### Вызов контракта между хостами (разные хосты), мс

| Режим | 64 Б p50 / p99 | 4 КиБ p50 / p99 | 64 КиБ p50 / p99 |
|---|---|---|---|
| utilityProcess | 0,134 / 0,263 | 0,15 / 0,28 | 0,283 / 0,48 |
| Node, json | 0,125 / 0,222 | 0,144 / 0,318 | 0,459 / 1,168 |
| Electron как Node (RunAsNode) | 0,111 / 0,397 | 0,128 / 0,296 | 0,383 / 0,579 |

### Вызов `ctx.os.fs.readText` из плагина (хост -> ядро -> шлюз -> хост), мс

| Режим | 64 Б p50 / p99 | 4 КиБ p50 / p99 | 64 КиБ p50 / p99 | p99 64 КиБ минус utilityProcess |
|---|---|---|---|---|
| utilityProcess | 0,397 / 0,775 | 0,408 / 0,675 | 0,5 / 0,803 | основа |
| Node, json | 0,44 / 1,041 | 0,408 / 0,916 | 0,549 / 3,032 | 2,229 |
| Electron как Node (RunAsNode) | 0,431 / 0,769 | 0,447 / 1,132 | 0,557 / 1,191 | 0,388 |

### Поток 1024 x 4 КиБ, МиБ/с

| Режим | главный -> хост (команды конвейером) | хост -> хост (события) |
|---|---|---|
| utilityProcess | 260,6 | 256,6 |
| Node, json | 189,3 | 235 |
| Electron как Node (RunAsNode) | 245,7 | 252,7 |

### Пинг в занятый хост (мс до ответа при синхронной работе плагина)

| Режим | блок 100 мс | блок 1000 мс | блок 3000 мс |
|---|---|---|---|
| utilityProcess | 79,2 | 979,2 | 2979,1 |
| Node, json | 80,6 | 979,3 | 2979,1 |
| Electron как Node (RunAsNode) | 79,2 | 979,3 | 2979,7 |

### Структурное клонирование через канал хоста

| Значение | utilityProcess | Node, json | Electron как Node (RunAsNode) |
|---|---|---|---|
| Map/Set/Date/BigInt | Object {m,s,d} | Object {m,s,d} | Object {m,s,d} |
| Uint8Array | Uint8Array 1,2,3 | Object {0,1,2} | Uint8Array 1,2,3 |
| ArrayBuffer 1 МиБ | ArrayBuffer 1048576 | Object {} | ArrayBuffer 1048576 |
| Error | Error RangeError: cause=y | Object {} | Error RangeError: cause=y |
| циклическая ссылка | Object {self} | отказ NotCloneable | Object {self} |
| разреженный массив, -0, NaN, undefined | Array 5: 0,2,3,4 true | Array 5: 0,1,2,3,4 false | Array 5: 0,2,3,4 true |
| экземпляр класса | Object {x} | Object {x} | Object {x} |
| RegExp | RegExp /a+/gi | Object {} | RegExp /a+/gi |
| функция | отказ NotCloneable | Object {} | отказ NotCloneable |
| Symbol | отказ NotCloneable | object | отказ NotCloneable |

Node, advanced: не запускается - вызов: команды bench-clone.echo нет; журнал ядра: host-down: crash, switched-off


## Результаты: Linux (блокирующая платформа)

Среда: Electron 45.2.3, Node 24.22.2 внутри, linux-arm64 (контейнер `node:24-bookworm-slim`, 4 процессора, Xvfb, `--no-sandbox`); отдельный Node 24.22.3. Прогонов: 3 (медиана каждой ячейки).

### Старт, память, сторож

| Режим | Старт хоста до activated, мс (p50 / p95) | PSS на хост (1 хост), МБ | RSS (1 хост), МБ | PSS на хост (5 хостов), МБ | Сторож 1000/5000: зависание, мс | падение, мс | перезапуск после падения, мс |
|---|---|---|---|---|---|---|---|
| utilityProcess | 49,1 / 59,4 | 57,9 | 115,4 | 41,9 | 5462 | 3 | 51 |
| Node, json | 44,3 / 46,9 | 39,2 | 63,8 | 28,5 | 5466 | 1 | 45 |
| Electron как Node (RunAsNode) | 46,8 / 60,1 | 55,4 | 108,6 | 40 | 5458 | 2 | 50 |

### Вызов из главного процесса в хост (команда), мс

| Режим | 64 Б p50 / p99 | 4 КиБ p50 / p99 | 64 КиБ p50 / p99 |
|---|---|---|---|
| utilityProcess | 0,127 / 0,306 | 0,129 / 0,595 | 0,222 / 0,369 |
| Node, json | 0,052 / 0,45 | 0,056 / 0,398 | 0,231 / 0,949 |
| Electron как Node (RunAsNode) | 0,044 / 0,633 | 0,043 / 0,48 | 0,126 / 0,463 |

### Вызов контракта между хостами (разные хосты), мс

| Режим | 64 Б p50 / p99 | 4 КиБ p50 / p99 | 64 КиБ p50 / p99 |
|---|---|---|---|
| utilityProcess | 0,272 / 0,765 | 0,289 / 0,731 | 0,492 / 0,697 |
| Node, json | 0,105 / 0,58 | 0,136 / 0,589 | 0,541 / 1,75 |
| Electron как Node (RunAsNode) | 0,091 / 0,59 | 0,113 / 0,613 | 0,316 / 0,817 |

### Вызов `ctx.os.fs.readText` из плагина (хост -> ядро -> шлюз -> хост), мс

| Режим | 64 Б p50 / p99 | 4 КиБ p50 / p99 | 64 КиБ p50 / p99 | p99 64 КиБ минус utilityProcess |
|---|---|---|---|---|
| utilityProcess | 0,28 / 0,684 | 0,262 / 0,64 | 0,338 / 0,76 | основа |
| Node, json | 0,175 / 1,484 | 0,174 / 0,83 | 0,361 / 0,851 | 0,091 |
| Electron как Node (RunAsNode) | 0,149 / 0,757 | 0,407 / 1,089 | 0,504 / 1,155 | 0,395 |

### Поток 1024 x 4 КиБ, МиБ/с

| Режим | главный -> хост (команды конвейером) | хост -> хост (события) |
|---|---|---|
| utilityProcess | 193,6 | 177,5 |
| Node, json | 136,1 | 144,5 |
| Electron как Node (RunAsNode) | 138,8 | 224,3 |

### Пинг в занятый хост (мс до ответа при синхронной работе плагина)

| Режим | блок 100 мс | блок 1000 мс | блок 3000 мс |
|---|---|---|---|
| utilityProcess | 76,6 | 975,8 | 2975,8 |
| Node, json | 80,3 | 980,3 | 2980,4 |
| Electron как Node (RunAsNode) | 79,6 | 980,3 | 2980,3 |

### Структурное клонирование через канал хоста

| Значение | utilityProcess | Node, json | Electron как Node (RunAsNode) |
|---|---|---|---|
| Map/Set/Date/BigInt | Object {m,s,d} | Object {m,s,d} | Object {m,s,d} |
| Uint8Array | Uint8Array 1,2,3 | Object {0,1,2} | Uint8Array 1,2,3 |
| ArrayBuffer 1 МиБ | ArrayBuffer 1048576 | Object {} | ArrayBuffer 1048576 |
| Error | Error RangeError: cause=y | Object {} | Error RangeError: cause=y |
| циклическая ссылка | Object {self} | отказ NotCloneable | Object {self} |
| разреженный массив, -0, NaN, undefined | Array 5: 0,2,3,4 true | Array 5: 0,1,2,3,4 false | Array 5: 0,2,3,4 true |
| экземпляр класса | Object {x} | Object {x} | Object {x} |
| RegExp | RegExp /a+/gi | Object {} | RegExp /a+/gi |
| функция | отказ NotCloneable | Object {} | отказ NotCloneable |
| Symbol | отказ NotCloneable | object | отказ NotCloneable |

Node, advanced: не запускается - вызов: команды bench-clone.echo нет; журнал ядра: host-down: crash, switched-off


## Протокол ядра: что подтверждено

- Структурное клонирование: таблицы выше. `utilityProcess` и «Электрон как Node» (`advanced`) дают одинаковый результат, включая отказ `NotCloneable` на функциях и `Symbol`. Канал `json` теряет `Uint8Array`, `ArrayBuffer`, `Error`, `RegExp`, сохраняет `-0`/`undefined` в массивах не так, как `advanced`, а функцию не отвергает, а превращает в `{}` (в ядре её запрет держит `NotCloneable` из `structuredClone`: при `json` этой проверки нет).
- Пинг и сторож: зависание находится за порогом плюс до интервала (5,4 с при 1000/5000, 2,7 с при 500/2500), как у `utilityProcess`; падение - по `exit`, за миллисекунды; перезапуск до `activated` у Node быстрее (старт процесса Node проще старта `utilityProcess`).
- Синхронная работа плагина под `--permission`: `JSON.parse` и пинг ведут себя как в [spike-hosts.md](spike-hosts.md); `readdirSync` по каталогу вне разрешённых - `ERR_ACCESS_DENIED` (плагину остаётся `ctx.os.fs`, это и есть цель).
- Под запретами проверено отдельно, на настоящем ядре и процессах (`core/test/fork-permission.test.ts`): `process.permission` определён; чтение вне разрешённых каталогов и запуск процесса - `ERR_ACCESS_DENIED`; `env` пуст (на macOS ОС кладёт в любой процесс `__CF_USER_TEXT_ENCODING`, это не окружение ядра); перезапущенный сторожем хост снова под запретами.

## RunAsNode против отдельного бинарника

| | macOS arm64 | Linux arm64 |
|---|---|---|
| Приложение Electron 45.2.3 целиком (`dist`) | 253,4 МБ (`Electron.app`; фреймворк 252 МБ, исполняемый файл 33 КБ) | 278,7 МБ (исполняемый файл `electron` 216,4 МБ) |
| Отдельный Node 24.x | 116,3 МБ (24.20.0; 121 911 744 байт) | 117,7 МБ (24.22.3) |
| Прирост поставки | +46% | +42% |
| Фьюзы | `Electron Framework` (общий для приложения и помощников: на один исполняемый файл фьюз не включить) | в самом `electron` |

**Подпись (macOS).** Node с nodejs.org подписан `Developer ID Application: Node.js Foundation (HX7739G8FX)`, hardened runtime, права `allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`, `disable-executable-page-protection`, `disable-library-validation`, `get-task-allow`. В приложение его кладут с подписью приложения: пересобранная ad hoc копия Node с hardened runtime и двумя правами (`allow-jit`, `allow-unsigned-executable-memory`) запускается под `--permission` и игнорирует `DYLD_INSERT_LIBRARIES`, то есть лишние права из подписи Node.js Foundation не нужны. Бинарник Electron в пакете `electron` с npm подписан ad hoc (в выпуске его подписывает приложение). Подпись с нашей личностью и нотаризация не выполнялись: нет сертификата.

**Поведение фьюза `RunAsNode`** (измерено на копии Electron с переключённым фьюзом, `playground/scripts/spike-node-host-binary.mjs`):

| | `RunAsNode` включён | `RunAsNode` выключен |
|---|---|---|
| `ELECTRON_RUN_AS_NODE=1 electron -p …` | Node: печатает `24.22.2 45.2.3`, выходит | `-p` не выполняется, поднимается приложение |
| `ELECTRON_RUN_AS_NODE=1 electron --version` | `v24.22.2` (версия Node) | `v45.2.3` (версия Electron) |
| `child_process.fork(хост, { execPath: бинарник Electron, env: { ELECTRON_RUN_AS_NODE: '1' } })` | хост отвечает, `process.type` не определён (Node) | **скрипт хоста исполняется как главный процесс Electron** (`process.type === 'browser'`, полный Electron API), а не как Node; на Linux под root без `--no-sandbox` процесс вообще не стартует |

То есть при выключенном фьюзе «Электрон как Node» невозможен, а `forkHosts` с `execPath: process.execPath` запустил бы полный Electron на каждый хост. Документация Electron говорит, что `child_process.fork` при этом «бросает»; на 45.2.3 он не бросает, а запускает приложение.

**Несовместимость V8 (главная находка).** Канал `child_process.fork` с `serialization: 'advanced'` - это `v8.serialize`. V8 в бинарнике Electron 45.2.3 - 15.6.75, в Node 24.20 - 13.6, в Node 24.22.3 - 13.6. Хост на отдельном Node, запущенный ядром в Electron, выходит с кодом 1 на первом сообщении (в журнале ядра `host-down: crash`, затем `switched-off`); ядро на Node, читающее сообщение хоста-Electron, падает с «Unable to deserialize cloned data due to invalid or unsupported version». С `serialization: 'json'` обе стороны читают друг друга, но структурное клонирование теряется (таблицы клонирования). У `utilityProcess` и «Электрона как Node» V8 одинаковый - у них проблемы нет. Версию V8 стандартного Node под V8 Electron не подобрать: V8 Electron идёт от Chromium и новее.

## Способ загрузки проверенных байтов

Ядро читает пакет один раз, проверяет подпись и хеши (этап Б), хост получает байты по каналу и исполняет их; файл по пути второй раз не открывается. Хосту под `--permission` разрешено читать только свой вход (`--allow-fs-read=<файл>`). Проверено: Node 24.20.0 и 24.22.3, Node в Electron 45.2.3 (24.22.2), с запретами и без, macOS и Linux.

| Способ | без `--permission` | под `--permission`, читать можно только вход хоста |
|---|---|---|
| `data:` URL (`import('data:text/javascript;base64,…')`) | работает, 0,3-0,6 мс | работает |
| `module.registerHooks` + схема `cyborg-verified:` (граф из двух файлов, `node:crypto` внутри) | работает, 0,4-0,8 мс | работает |
| `module.registerHooks` на адресах `file:` под настоящим каталогом плагина, который хосту читать нельзя: хуки `resolve` и `load` (вариант этапа Б, TR-11) | работает, 0,4-0,6 мс | работает |
| то же, но только хук `load` (так сегодня устроен `core/src/verified-sources.ts` этапа Б) | работает | **`ERR_ACCESS_DENIED`**: обычный `resolve` проверяет файл (`stat`), а читать каталог плагина под `--permission` нельзя |
| `vm.Script` (cjs) | работает | работает |
| `vm.SourceTextModule` (`--experimental-vm-modules`) | работает | работает |
| контроль: `import(путь)` повторно | работает | **`ERR_ACCESS_DENIED`** |

Одинаково на четырёх сочетаниях (контроль «только `load`» падает на всех четырёх одинаково): Node 24.20.0 (macOS), Node 24.22.3 (Linux), Node 24.22.2 внутри Electron 45.2.3 (macOS и Linux).

- **`module.registerHooks`** - рекомендуемый способ: граф из нескольких файлов (относительные импорты), `node:*` внутри работают. Два варианта адреса: виртуальная схема `cyborg-verified:` и `file:` под каталогом плагина; второй сохраняет `import.meta.url` и относительные пути, поэтому его и выбрал этап Б (`docs/05-verification/provenance-loading.md` этапа Б, [#247](https://github.com/dex-it/cyborg-harness/issues/247)). **Находка для TR-21:** под `--permission` одного хука `load` мало - нужен ещё `resolve`, который для адресов под каталогом плагина отвечает из набора проверенных файлов, иначе обычный разбор адреса падает с `ERR_ACCESS_DENIED` (таблица выше). Оговорка: `registerHooks` в документации Node 24 - «активная разработка» (стабильность 1.1); нужен canary на каждый релиз Node (план, 6.6, п. 2).
- **`data:` URL** - запасной способ для бандла из одного файла (`cyborg-plugin build` делает именно такой): 5 МБ загружаются за ~80 мс, 20 МБ - за ~320 мс (Node 24.20, macOS); относительные импорты невозможны; в трассировках нет имён файлов.
- **`vm.Script`** - только cjs-бандлы; **`vm.SourceTextModule`** - требует `--experimental-vm-modules` (предупреждение, нестабильный API): запасной вариант.
- **Повторное открытие файла** (`import(путь)`) под `--permission` - `ERR_ACCESS_DENIED`: подмена файла между проверкой и запуском невозможна, потому что хост файл не видит.

## Что не проверено

- Сеть: `--permission` в Node 24 сеть не закрывает (TR-22); хост под `--permission` открывает TCP. Не повторялось здесь, зафиксировано опытом Г.
- Влияние Landlock, seccomp и Seatbelt на задержку (TR-22).
- Линуксовое ядро - OrbStack (ядро 7.2.12-orbstack), aarch64, не x64; числа Linux - контейнер на 4 процессоре с `node:24-bookworm-slim` и Xvfb, без GPU; сравнивать с [spike-hosts.md](spike-hosts.md) (x64, Ryzen) нельзя.
- Подпись и нотаризация отдельного Node с нашей личностью не выполнялись (нет сертификата): проверено, что Node, подписанный ad hoc с hardened runtime и двумя правами (`allow-jit`, `allow-unsigned-executable-memory`), запускается под `--permission` и игнорирует `DYLD_INSERT_LIBRARIES`.
- Windows вне охвата.
- Кодек типов для канала `json`: не писался, это работа TR-21; цена оценена только измерением канала `json` без кодека.
- Память сторонних хостов под нагрузкой реального плагина: пустые плагины, как в [spike-hosts.md](spike-hosts.md).
