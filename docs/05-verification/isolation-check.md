# Проверка изоляции процесса стороннего плагина: macOS и Linux

Результат задач TR-21, TR-22a, TR-22b и TR-24 ([#249](https://github.com/dex-it/cyborg-harness/issues/249), этап В2 стека [#243](https://github.com/dex-it/cyborg-harness/issues/243)), 2026-11-13. Решение - [ADR-CH-0019](../04-architecture/adr/ADR-CH-0019-third-party-host-isolation.md); нормы - [FR-CH-3032, 3033, 3034](../03-requirements/03-security-trust/srs.md); критерии - [ST-3010](../03-requirements/03-security-trust/stories/ST-3010-third-party-host-isolation.md); спайк, на который это опирается, - [spike-node-host.md](spike-node-host.md).

## Что проверено и где

| Что | macOS | Linux |
|---|---|---|
| Среда | macOS 27.2, arm64, Electron 45.2.3, Node 24.20.0 (процесс хоста и тестов) | Docker в OrbStack: **`uname -r` = 7.2.12-orbstack-00394-gbecdd6130068**, aarch64, **Landlock ABI 10**, seccomp есть; Debian 12 (`node:24-bookworm-slim`), Node 24.22.3, Electron 45.2.3 под `xvfb` и `--no-sandbox` |
| Ограничитель | `sandbox-exec` (Seatbelt) | `cyborg-confine` (`gcc` 12, статически) |
| Хост стороннего плагина: уровень | 3 (запреты Node и Seatbelt, сеть закрыта) | 3 (запреты Node, Landlock ABI 10 и seccomp, сеть закрыта) |
| Нарушитель TR-01 на настоящем Electron (`npm run test:trust`) | 32 из 32 | 33 из 33 |
| Запускатель без хоста плагинов (`electron/test/confine-linux.test.ts`) | - | контейнер: 5 пройдено, 1 пропущен (`--require-landlock` на ядре с Landlock проверить нельзя). **CI, x86_64:** `ubuntu-22.04` - `uname -r` 6.8.0-1070-azure, Landlock ABI 4; `ubuntu-24.04` - 7.0.0-1017-azure, ABI 8; на обоих те же 5 пройдено, 1 пропущен |
| Ядро и адаптер (`core/test`, `electron/test`) | `npm test`: пройдено | `sandbox-canary`, `wire-codec`, `fork-permission`, `node-hosts`: пройдено |

Нарушитель ([`playground/trust-probe/violator.ts`](../../playground/trust-probe/violator.ts)) в хосте стороннего плагина:

| Действие | `utilityProcess` (возврат настройкой) | Процесс Node, запреты | Процесс Node, запреты и ограничитель ОС |
|---|---|---|---|
| `process.permission` | не определён | определён | определён |
| чтение файла вне каталога плагина | прочитал | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| запуск процесса | выполнен | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| поток (`Worker`) | создан | `ERR_ACCESS_DENIED` | `ERR_ACCESS_DENIED` |
| аддон (`process.dlopen`) | отказ (файла нет) | отказ | отказ |
| TCP-соединение на loopback | открыто | **открыто (записано как открытое, уровень 2)** | закрыто (macOS: `EPERM` Seatbelt; Linux: `EPERM` seccomp) |
| токен главного процесса в `env` | нет | нет | нет |

Строка «процесс Node, запреты» без ограничителя проверена тестом `electron/test/node-hosts.test.ts` (настройка `confiner: 'off'`: уровень 2, сеть открыта, причина названа) и в `playground/test/real/trust-real-host.test.ts` на машине без ограничителя (на macOS и на Linux с запускателем проба идёт сразу с ограничителем).

## Запускатель Linux на настоящем ядре

Вывод теста `electron/test/confine-linux.test.ts` (контейнер, ядро выше):

```
# uname -r: 7.2.12-orbstack-00394-gbecdd6130068; Landlock ABI 10; seccomp true; aarch64
  ✔ --probe: ABI Landlock, seccomp, архитектура и ядро
  ✔ no_new_privs и seccomp наложены; сокеты не создаются (TCP, UDP, unix-сокет по пути), fork закрыт, потоки работают
  ✔ Landlock: свой каталог читается; вне названного читать, листать и писать нельзя; свой каталог тоже не пишется
  ✔ Landlock сам (без seccomp): исполнение чужой программы отказано; TCP закрыт с ABI 4 (ядро 6.7), до него открыт - поэтому сеть держит seccomp
  ﹣ --require-landlock на ядре без Landlock отказывает кодом 4 # ядро с Landlock: отказ проверить нельзя
  ✔ неверные аргументы и отсутствующая команда: код 2 и 127, сообщение словами
```

`cyborg-confine --probe` на этом ядре: `{"abi":10,"seccomp":true,"arch":"aarch64","kernel":"7.2.12-orbstack-00394-gbecdd6130068"}`.

Красный прогон до правки: тест «no_new_privs и seccomp наложены…» при отключённом наложении seccomp в запускателе падает на `[ 'EACCES', 'выполнено', 'ENOENT' ]` вместо `[ 'EPERM', 'EPERM', 'EPERM' ]` (TCP и unix-сокет закрыты одним Landlock, UDP открыт); с фильтром зелёный.

Что Node читает при старте под Landlock (найдено прогоном, записано в политику): `/etc/ssl/openssl.cnf`, `/etc/ld.so.cache`, `/proc/self`, `/sys/devices/system/cpu`, `/sys/fs/cgroup`, системные библиотеки (`/lib`, `/usr/lib`, `/lib64`), файлы `package.json` над каталогом кода хоста и плагина (по ним Node ищет тип модуля). Весь `/proc` не открывается: `/proc/<pid>/environ` процессов того же пользователя читается без ptrace.

## Что не проверено

- **Ядра без нужного ABI.** Ядро без Landlock (ABI 0, до 5.13) и ядро до 6.7 (ABI < 4) на настоящем ядре не запускались: OrbStack даёт одно ядро (7.2), а оба образа раннера GitHub (`ubuntu-22.04`: 6.8, ABI 4; `ubuntu-24.04`: 7.0, ABI 8) новее 6.7. Покрыто: разбор ответа `--probe` с ABI 0, 3, 4, 7 и текст уровня на каждом (`electron/test/node-hosts.test.ts`), прогон Landlock без seccomp, который различает поведение до и после ABI 4 по ответу `--probe`. **Проверка до и после ядра 6.7 как пара настоящих ядер не выполнена**; если на каком-то образе или машине ABI окажется меньше 4, тест сам сузит ожидания, а запускатель ответит этим в `--probe`. Человеку: прогнать `npm run build:confiner && node --test electron/test/confine-linux.test.ts` на машине с ядром 5.13-6.6 (например, Ubuntu 22.04 с GA-ядром 5.15) и ядром без Landlock.
- **Linux x86_64** проверен только в CI (запускатель собирается и проходит `confine-linux.test.ts` на обоих образах); фильтр seccomp собирается из `__NR_*` системы сборки (x86_64 и aarch64 поддержаны, прочие не соберутся). Электрон-проба `test:trust` на x86_64 идёт в задании `ubuntu-24.04`.
- **Бюджеты шлюза** сняты на раннере GitHub (см. ниже) и в контейнере на ноутбуке под нагрузкой.
- **macOS других версий**, чем 27.2; поведение `sandbox-exec` при будущем удалении утилиты.
- **Windows** вне охвата.
- **Бинарник Node и запускатель в упакованном приложении**: подпись, нотаризация, положение в ресурсах - работа приложения; `pack:delivery` их не кладёт.
- **Память и старт хоста Node на настоящем стороннем плагине**: пустые плагины ([spike-node-host.md](spike-node-host.md)).
- **Wayland и рабочий стол Linux с настоящими сессиями**, `D-Bus` в хосте: хост без сокетов; поведение плагинов, которым нужен `D-Bus` напрямую, не проверялось (им положен шлюз).

## Бюджеты шлюза на хосте стороннего плагина

**Раннер GitHub `ubuntu-24.04` (x86_64, ядро 7.0.0-1017-azure), блокирующий шаг «замеры и сверка с порогами на хосте стороннего плагина (процесс Node)», запуск PR #253: все охраняемые пути в бюджете** (`check:budgets`, платформа Linux, порог блокировки 1,5 мс): `fs.readText` 64 Б 0,629, 4 КиБ 0,999, 64 КиБ 1,03 (выше бюджета 1 мс, в запасе до 1,5 мс; тот же путь в `utilityProcess` в этом же запуске - 1,095 / 0,963 / 0,946); `pty.write` 0,288 / 0,568 / 0,700; `secrets.get` 0,180 / 0,233 / -0,056. Замер контейнера ниже шумнее и показывает `pty.write` выше порога и в `utilityProcess`.

Замер: `npm run spike:gateway -- --node-host=<Node> [--confiner-bin=…]` (плагин замера не из поставки, хост - процесс Node под запретами и ограничителем), сверка - `npm run check:budgets -- --gateway <файл>`; медиана p99 цены за три прогона, мс. Путь `fs.watch` в этом режиме не мерится: нагрузку (дописывание в файл) создаёт сам плагин замера через `node:fs`, хосту под `--permission` писать нельзя; событие идёт тем же кодом ядра, что в замере `utilityProcess`.

Контейнер Linux (ядро и среда выше), сверху вниз: `utilityProcess` (как сегодня), процесс Node под запретами и `cyborg-confine`.

| Путь, размер | `utilityProcess` | Node + `cyborg-confine` |
|---|---|---|
| `fs.readText`, 64 Б | 0,745 | 0,853 |
| `fs.readText`, 4 КиБ | 0,671 | 0,745 |
| `fs.readText`, 64 КиБ | 0,615 | 0,670 |
| `secrets.get`, 64 Б / 4 КиБ | 0,104 / 0,135 | 0,125 / 0,126 |
| `pty.write`, 64 Б | 1,694 | 2,299 |
| `pty.write`, 4 КиБ | 1,690 | 2,011 |
| `pty.write`, 64 КиБ | 0,316 | 0,518 |

- Охраняемый путь `fs.readText` до 64 КиБ укладывается в 1 мс на обоих способах; разница с `utilityProcess` 0,05-0,11 мс.
- **`pty.write` на 64 Б и 4 КиБ выше порога блокировки (1,5 мс) в этом контейнере и в режиме `utilityProcess`** (1,7 мс): среда шумит (замеры `utilityProcess` в той же сессии давали от 0,8 до 2,6 мс на 4 КиБ). Хост Node добавляет к нему 0,3-0,6 мс. Что скажет раннер GitHub, неизвестно; если задание «бюджеты» покраснеет на этом пути, это находка, а не шум: тогда `pty.write` в режиме Node разбирается отдельно (кодек канала не виноват: он стоит 0,5-3 мкс на сообщение, а с отключённой кодировкой `pty.write` остаётся таким же).
- macOS (рабочая машина под нагрузкой, не блокирующая платформа): `fs.readText` 0,36-0,43 мс, `pty.write` 64 Б 2,9 мс при том, что `utilityProcess` в той же сессии давал 0,3 мс; повтор в тихое время не выполнялся.
