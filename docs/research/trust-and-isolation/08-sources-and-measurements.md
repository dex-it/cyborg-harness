[К оглавлению (README)](README.md) · [← Открытые вопросы](07-open-questions.md)

# 8. Источники

Доступ ко всем внешним ссылкам: 2026-11-13. Внутренние ссылки на код и документы даны по тексту.

**Операционные системы**
- unix(7): https://man7.org/linux/man-pages/man7/unix.7.html
- seccomp(2): https://man7.org/linux/man-pages/man2/seccomp.2.html
- landlock(7): https://man7.org/linux/man-pages/man7/landlock.7.html, ядро: https://docs.kernel.org/userspace-api/landlock.html
- user_namespaces(7): https://man7.org/linux/man-pages/man7/user_namespaces.7.html; Ubuntu: https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces
- ptrace(2): https://man7.org/linux/man-pages/man2/ptrace.2.html; Yama: https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html; mlock(2): https://man7.org/linux/man-pages/man2/mlock.2.html
- fs-verity: https://docs.kernel.org/filesystems/fsverity.html
- bubblewrap: https://github.com/containers/bubblewrap; Firejail: https://raw.githubusercontent.com/netblue30/firejail/master/README.md
- SO_PEERPIDFD (LPC 2024): https://lpc.events/event/18/contributions/1691/attachments/1499/3166/-LPC-2024-%20PID%20FDs-%20where%20we%20were,%20where%20we%20are%20and%20were%20we%20would%20like%20to%20go.pdf
- XNU `un.h`: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/un.h
- Apple DTS о `LOCAL_PEERTOKEN`: https://developer.apple.com/forums/thread/850777
- XPC: https://developer.apple.com/tutorials/data/documentation/xpc/xpc_connection_set_peer_code_signing_requirement(_:_:).json
- Hardened Runtime: https://developer.apple.com/tutorials/data/documentation/security/hardened-runtime.json; нотаризация: https://developer.apple.com/tutorials/data/documentation/security/notarizing-macos-software-before-distribution.json
- Keychain: https://developer.apple.com/tutorials/data/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps.json; Secure Enclave: https://developer.apple.com/tutorials/data/documentation/security/protecting-keys-with-the-secure-enclave.json
- sandbox-exec(1): https://keith.github.io/xcode-man-pages/sandbox-exec.1.html; ptrace(2) macOS: https://keith.github.io/xcode-man-pages/ptrace.2.html
- systemd-creds: https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html
- Секреты Linux: https://wiki.gnome.org/Projects/GnomeKeyring/SecurityPhilosophy, https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Secret.html
- Android: https://source.android.com/docs/security/app-sandbox; Capsicum: https://man.freebsd.org/cgi/man.cgi?query=capsicum&sektion=4; Zircon: https://fuchsia.dev/fuchsia-src/concepts/kernel/handles

**Electron**
- utilityProcess: https://www.electronjs.org/docs/latest/api/utility-process; исходник: https://raw.githubusercontent.com/electron/electron/main/shell/browser/api/electron_api_utility_process.cc; mojom: https://raw.githubusercontent.com/electron/electron/main/shell/services/node/public/mojom/node_service.mojom
- process, message-ports: https://www.electronjs.org/docs/latest/api/process, https://www.electronjs.org/docs/latest/tutorial/message-ports
- sandbox, security, fuses, ASAR integrity, safeStorage, protocol: https://www.electronjs.org/docs/latest/tutorial/sandbox, https://www.electronjs.org/docs/latest/tutorial/security, https://www.electronjs.org/docs/latest/tutorial/fuses, https://www.electronjs.org/docs/latest/tutorial/asar-integrity, https://www.electronjs.org/docs/latest/api/safe-storage, https://www.electronjs.org/docs/latest/api/protocol
- webPreferences: https://raw.githubusercontent.com/electron/electron/main/docs/api/structures/web-preferences.md

**Node.js**
- permissions (v24): https://nodejs.org/docs/latest-v24.x/api/permissions.html; (latest): https://nodejs.org/docs/latest/api/permissions.html
- crypto (v24, JSON): https://nodejs.org/docs/latest-v24.x/api/crypto.json; net: https://nodejs.org/docs/latest-v24.x/api/net.html; vm: https://nodejs.org/docs/latest-v24.x/api/vm.html; wasi: https://nodejs.org/docs/latest-v24.x/api/wasi.html; ffi: https://nodejs.org/docs/latest/api/ffi.html
- libuv: https://raw.githubusercontent.com/libuv/libuv/v1.x/src/unix/process.c

**Chromium, VS Code, Deno, Web**
- Mojo: https://chromium.googlesource.com/chromium/src/+/main/mojo/README.md, https://chromium.googlesource.com/chromium/src/+/main/mojo/core/README.md, https://chromium.googlesource.com/chromium/src/+/main/docs/security/mojo.md
- Песочница и site isolation: https://chromium.googlesource.com/chromium/src/+/main/sandbox/linux/README.md, https://chromium.googlesource.com/chromium/src/+/main/sandbox/mac/seatbelt_sandbox_design.md, https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md
- VS Code: https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox, https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security, https://code.visualstudio.com/docs/editing/workspaces/workspace-trust, https://github.com/microsoft/vscode/issues/52116
- Deno: https://docs.deno.com/runtime/fundamentals/security/; MV3: https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3, https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- MDN: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe, https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage; WebAssembly: https://webassembly.org/docs/security/
- Confused deputy: http://www.cap-lore.com/CapTheory/ConfusedDeputy.html

**Подпись и токены**
- Sigstore: https://docs.sigstore.dev/about/overview/; npm provenance: https://docs.npmjs.com/generating-provenance-statements; SLSA: https://slsa.dev/spec/v1.0/levels; TUF: https://theupdateframework.io/docs/overview/; minisign: https://jedisct1.github.io/minisign/
- Macaroons: https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/; Biscuit: https://doc.biscuitsec.org/getting-started/introduction; Noise: https://noiseprotocol.org/noise.html; SPIFFE: https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/

Источники читались моделью-читателем страниц (пересказ); критичные цитаты перепроверялись по сырым исходникам; где перепроверки не было, в тексте стоит «не проверено» или «вывод».

# Приложение А. Перепроверка утверждений предварительного разбора по коду

Утверждения, на которых построен выбор, проверены чтением кода и запуском. Расхождения исправлены в тексте.

| # | Утверждение | Результат |
|---|---|---|
| 1 | `mine()`/`live()` проверяют только «плагин в этом хосте» (`core/src/host-bridge.ts:18-28`) | ✅ подтверждено чтением; `os` зовёт `live(p.pluginId)` (`core/src/os-requests.ts:64-67`) |
| 2 | В общем хосте плагин пишет от имени соседа | ✅ контрольный тест `core/test/trust.test.ts:289-295` (`shared.forge('shared')` даёт `ok`); не воспроизводился запуском отдельно |
| 3 | `init` со всеми манифестами уходит всем хостам | ✅ `endpoint.request('init', ctx.wire)` (`core/src/host-pool.ts:101`), `wire = { manifests, bindings }` по всем плагинам (`core/src/context-build.ts:181`) |
| 4 | `contracts` с данными поставщиков рассылаются всем хостам | ✅ `broadcast` обходит все хосты, `announce` при старте хоста (`core/src/contract-calls.ts:25-27,163-165`); поле `data` попадает в `ContractDescriptor` (`:113-125`) |
| 5 | Хост запущен без песочницы, без `env`, без `execArgv` | ✅ `utilityProcess.fork(entry, [hostId], { serviceName, stdio: 'inherit' })` (`electron/src/plugin-hosts.ts:15`); typings Electron: «`env` Default is `process.env`» (`electron.d.ts`, `ForkOptions`) |
| 6 | `--permission` в `utilityProcess` принят, но не действует | ✅ **воспроизведено на macOS** (Electron 45.2.3): `process.permission` не определён, чтение, запуск процесса и сеть проходят (Опыт Б). Исходное допущение «на macOS не повторялось» снято. Linux - не проверено |
| 7 | Код плагина читает `process.parentPort` | ✅ воспроизведено: плагин увидел `init` с чужим манифестом (Опыт А) |
| 8 | Окружение главного процесса видно хосту | ✅ воспроизведено; явный `env` убирает (Опыт А, В) |
| 9 | Процесс Electron как Node с `--permission` ограничивает файлы и процессы, но не сеть | ✅ воспроизведено (Опыт Г) |
| 10 | Загрузчик не вызывает `checkPlugin` | ✅ `grep` находит только экспорт и определение |
| 11 | В коде нет HMAC, подписей, проверки пира | ✅ `grep`; найдено шесть импортов `node:crypto` (`randomUUID`, `randomBytes`, `createHash`) |
| 12 | `trust.test.ts`: 686 строк, 11 тестов | ⚠️ **исправлено**: 686 строк, 16 тестов, у восьми в имени ключ приёмки |
| 13 | `sandbox-exec` в предварительном разборе не запускался | ✅ **проверено**: профиль Seatbelt закрывает сеть, fork и чтение (Опыт Д) |
| 14 | Канал для процесса Node в ядре не описан | ⚠️ **дополнено**: `forkHosts` (`core/src/transports.ts:46-70`) уже даёт `child_process.fork` с `ipc`; этап В не требует нового транспорта |
| 15 | Тесты вида идут на настоящем Electron | ⚠️ нет: `electron/test/view-frames.test.ts` использует подставные кадры; в окне идентичность проверяет только smoke |
| 16 | Номера строк кода | Сверены с `master` на `0c3c081` выборочно: `host-bridge.ts`, `host-pool.ts`, `context-build.ts`, `contract-calls.ts`, `plugin-hosts.ts`, `transports.ts`, `view-frames.ts`, `channels.ts`, `pty.ts`; остальные взяты из предварительного разбора и не перечитывались построчно |

# Приложение Б. Замеры и опыты

Стенд: macOS 27.2 (Darwin 27.2.0, arm64), Node 24.20.0, Electron 45.2.3 из `node_modules` репозитория (внутри Node 24.22.2). Все скрипты лежат вне репозитория (рабочий каталог исследователя) и приведены ниже в сокращении. Линуксовых запусков нет.

## Б.1. Опыт: что может код плагина в `utilityProcess`

Главный процесс Electron кладёт в свой `process.env` токен `CYBORG_DEMO_TOKEN`, создаёт файл `cyborg-demo-secrets.json` (имитация `secrets.json`) и трижды форкает `utilityProcess` с «вредоносным плагином»:

- **А** - как в репозитории: `{ serviceName, stdio: 'pipe' }`;
- **Б** - то же + `execArgv: ['--permission', '--allow-fs-read=<каталог опыта>']`;
- **В** - то же, что А, + `env: { PATH }`.

Сокращённый код плагина (обычный Node; `r` - объект отчёта):

```js
const fs = require('fs'), net = require('net'), cp = require('child_process');
const seen = [];
process.parentPort.on('message', (e) => seen.push(e.data));            // сырой канал
r.env = process.env.CYBORG_DEMO_TOKEN ?? 'нет';                          // окружение
r.fsSecrets = fs.readFileSync(process.argv[3], 'utf8');                  // файл «ядра»
r.proc = cp.execSync('id -u').toString();                                // процесс
process.parentPort.postMessage({ t: 'req', id: 99, m: 'os',              // от имени «соседа»
  p: { pluginId: 'victim-plugin', method: 'secrets.get', args: ['token'] } });
net.connect(80, 'example.com');                                          // сеть
```

Результат (вывод скрипта, сокращённо):

| Проверка | А | Б | В |
|---|---|---|---|
| `execArgv` в хосте | `[]` | `["--permission","--allow-fs-read=…"]` | `[]` |
| `typeof process.permission` | `undefined` | `undefined` | `undefined` |
| токен главного процесса | `token-of-main-process` | `token-of-main-process` | `нет` |
| чтение файла «секретов» | прочитан | прочитан | прочитан |
| `/etc/hosts` | 213 байт | 213 байт | 213 байт |
| `child_process.execSync('id -u')` | `501` | `501` | `501` |
| `net.connect(80, 'example.com')` | соединение установлено | соединение установлено | соединение установлено |
| сообщение `init` в сыром канале | видно, с манифестом `victim-plugin` | видно | видно |
| ядро получило сообщение от «соседа» | да: ядро знает отправителя по объекту `UtilityProcess` (pid 38399), а не по полю сообщения | да | да |

## Б.2. Прочие опыты

| Опыт | Результат | Источник |
|---|---|---|
| Г. Тот же бинарник как Node (`ELECTRON_RUN_AS_NODE=1`) с `--permission --allow-fs-read=<каталог>` | `process.permission` есть; чтение `/etc/hosts` - `ERR_ACCESS_DENIED`; запуск процесса - `ERR_ACCESS_DENIED`; чтение разрешённого каталога - успешно; **`net.connect` - соединение установлено** | собственный, Node 24.22.2 внутри Electron 45.2.3 |
| Д. `sandbox-exec -p "(version 1)(allow default)(deny network*)(deny process-fork)(deny file-read* (literal <файл>))" node …` | чтение файла - `EPERM`; сеть - `ENOTFOUND` по имени и `EPERM` по IP; fork - `EPERM`; вместе с `--permission` все четыре действия (файл, `/etc/hosts`, процесс, сеть) отказаны | собственный, macOS 27.2 |
| fd 3 при `stdio: 'pipe'` | `fs.fstatSync(3).isSocket() === true`, обмен через `new net.Socket({fd: 3})` работает | первый проход исследования, macOS |
| fd 3 внуку при `stdio: 'inherit'` | открыт, но не сокет; при явной передаче на позицию 3 - сокет | первый проход исследования, macOS |
| `net.Socket.prototype`: поля учётных данных пира | нет (только `_getpeername`) | первый проход исследования, macOS |
| `ps -E -p <pid>` на macOS | окружение и `argv` дочернего процесса того же пользователя видны, `SECRET_ENV` читается | первый проход исследования, macOS |
| Размеры | `node` (24.20.0) 122 МБ; `Electron Framework` 251 МБ | `ls`, `du` на этой машине |

**Микробенчмарки `node:crypto`** (Node 24.20.0, macOS arm64): HMAC-SHA256 1 КиБ 9,25 мкс, 64 КиБ 37 мкс; AES-256-GCM шифрование 1 КиБ 12,6 мкс, расшифровка 10,5 мкс; ChaCha20-Poly1305 1 КиБ 13,7 мкс; Ed25519 `sign` 31,9 мкс, `verify` 87,7 мкс, генерация пары 31 мкс; X25519 DH 31,1 мкс; HKDF 9,5 мкс; SHA-256 64 КиБ 29 мкс; `randomBytes(32)` 0,92 мкс.

**RTT 256 Б.** `socketpair` между двумя процессами Node, 20 000 кругов: p50 16,8-18,3 мкс, p99 около 42 мкс; с AES-GCM на каждом сообщении (наивная обвязка, новый шифр на сообщение, счётчик `BigInt`): p50 90,6 мкс, p99 около 139 мкс. `utilityProcess.parentPort`: p50 50,0 мкс, p99 115,5 мкс.

**Ограничения.** Один хост, нет нагрузки одновременными каналами, нет Linux, нет замеров `MessageChannelMain` вид-хост, нет времени старта `utilityProcess` против `spawn`, нет влияния seccomp и Landlock.

**Воспроизведение.** Электрон из репозитория (`node_modules/electron/dist/Electron.app/Contents/MacOS/Electron main.js`) запускает скрипт, который форкает `plugin.js` тремя способами; вывод сохраняется в файл. Для опытов Г и Д достаточно `node` или Electron с `ELECTRON_RUN_AS_NODE=1` и `sandbox-exec`. Скрипты в репозиторий не добавлялись.
