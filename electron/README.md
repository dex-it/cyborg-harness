# @cyborg-harness/electron

Адаптер Electron для ядра плагинов [`@cyborg-harness/core`](../core/README.md): всё, что связывает ядро с Electron, чтобы приложению (ai-cyborg, playground) не копировать это руками. Хосты плагинов в `utilityProcess`, среда `ctx.os` (`safeStorage`, `node-pty`, `shell`, `dialog`, `clipboard`, уведомления), схема `cyborg-plugin://` и мост видов, каналы IPC окна и видов, перехват клавиш, события окна и питания, одиночный экземпляр, слой окна. Решение о форме: пакет в этом репозитории, прокладку `window.cyborg` и свои каналы IPC поверх этого не вводим (D-00, строки 3 и 4; [SAD](../docs/04-architecture/design/sad.md), разд. 1).

Пакет в реестр ещё не опубликован: выпуск идёт по тегу `v<версия>` ([`release.yml`](../.github/workflows/release.yml), [SAD 3.3](../docs/04-architecture/design/sad.md#пакет-контрактов-поставка-и-версии)), доступ при выпуске `restricted`, лицензия не выбрана (`UNLICENSED`, выбор за владельцем). Пока он ставится как workspace этого репозитория или из архива `npm pack`; изменения - в [CHANGELOG](CHANGELOG.md).

## Что внутри

В пакете лежит собранный JS (ESM, без бандла, по файлу на модуль) и `.d.ts`; исходники `.ts` в него не входят. Оболочка вида собрана отдельно: `dist/shell/shell.js` и `shell.css` - файлы для окна, не модули.

| Импорт | Что даёт | Где работает |
|---|---|---|
| `@cyborg-harness/electron` | служба плагинов (`PluginsService`, `startPlugins`, `discoverPlugins`), хосты (`utilityHosts`), среда ОС (`electronOs`), хранение диагностики в `userData` (`fileDiagnostics`, `StartOptions.diagnostics`; K-30), схема видов (`registerViewScheme`, `serveViews`, `resolveViewRequest`, `guardNavigation`), каналы (`registerWindowChannels`, `registerViewChannels`, `windowChannel`, `viewChannel`), окно и приложение (`windowEvents`, `bindWindow`, `bindAppMenu`, `appMenuTemplate`, `watchPower`, `watchTheme`, `singleInstance`, `workspaceInstance` (экземпляр на воркспейс, K-20), `isolateSession`, `quitAfterPlugins`, `showWindow`), перезапуски и «новое окно» (`restarts`, `workspaceInfo`, `newWindowArgs`, `DEFAULT_RESTART_FLAGS`), ключ и каталог экземпляра (`instanceKey`, `NO_WORKSPACE_KEY`, `sessionDataDir`), проверка соседних окон для `uninstall` (`workspaceNeighbors`, `StartOptions.neighbors`, `PluginsService.working`; #154) | главный процесс Electron |
| `@cyborg-harness/electron/host-entry` | точка входа файла для `utilityProcess`: `process.parentPort` -> `runHost` ядра; имён не экспортирует | процесс хоста (`utilityProcess`) |
| `@cyborg-harness/electron/preload` | мосты: `windowApi()` (окно просит у главного процесса), `exposeViewBridge()` (`window.cyborgView` во фрейме вида), `inViewFrame`, `inWindowDocument` | preload (песочница) |
| `@cyborg-harness/electron/window` | общее главного процесса и окна: снимок `PluginsSnapshot` и строки `PluginRow`, `WindowLayerView` (слой окна: диалоги видов и замки), протокол видов (`VIEW_SCHEME`, `viewOrigin`, `groupOfOrigin`, `PATH_MIME`) | окно (браузер), без `node:*` и Electron |
| `@cyborg-harness/electron/shell/shell.js`, `.../shell.css` | оболочка вида плагина одним скриптом (на `@cyborg-harness/core/ui-shell` и `/elements`) | фрейм вида |

Точный перечень имён каждого входа - `electron/test/public-api.test.ts` (`ENTRIES`): тест падает, если имя добавлено или убрано без правки перечня, если вход написан через `export *` и если JS входа окна достаёт до `node:*`. Имя в перечень добавляют осознанно: оно обещает совместимость. Всё остальное в пакете (`dist/src/*`) внутреннее.

Границу держит `electron/test/boundary.test.ts`: в пакете нет импортов из `playground/` и из внутренностей ядра (только публичные входы, их перечень - `core/test/public-api.test.ts`), а playground берёт адаптер только через эти входы.

Peer-зависимости: `@cyborg-harness/core`, `@cyborg-harness/contracts` (типы), `electron` (`>=45`), `node-pty` (`^1.1.0`; его нативную сборку под Electron делает приложение - в этом репозитории `electron-rebuild` в `postinstall`). Рантайм-зависимостей нет. Node - `>=24` (Node из Electron 45).

## Что даёт пакет и что делает приложение

Даёт пакет, поведение одно для всех приложений:

- хосты плагинов процессами `utilityProcess` со сторожем ядра: `utilityHosts(entry)` и файл `host-entry`; окружение хоста явное, не `process.env` приложения (см. «Окружение хоста плагинов»);
- среду `ctx.os` на Electron: секреты в файле под `safeStorage`, pty через `node-pty` с убийством группы, `shell`, `dialog`, `clipboard`, уведомления ОС;
- службу плагинов для окна: поиск плагинов в каталогах, старт ядра, снимок (`PluginsSnapshot`: плагины, раскладка видов, клавиши, лента, журнал, слой окна, документы), команды, выключение и включение;
- схему `cyborg-plugin://<группа>/<плагин>/`: origin на группу рендера (виды плагинов группы делят процесс рендера, сторонний плагин всегда один в своей группе), плагин в пути адреса, оболочка и файлы вида, строгая CSP, защита от выхода за каталог плагина и от симлинков, запрет новых окон и ухода окна со своих адресов (`guardNavigation`);
- каналы IPC: окно -> служба плагинов и вид -> служба плагинов (плагин всегда берётся из адреса фрейма внутри его группы, не из аргументов), терминалы видов, перетаскивание файлов между видами, тема видов;
- перехват клавиш ядром раньше страницы, события фокуса окна, сна, пробуждения и блокировки экрана, выход с ожиданием `onBeforeQuit` плагинов, одиночный экземпляр;
- перезапуск приложения при смене воркспейса и безопасного режима с вопросом о живых pty;
- слой окна: диалоги видов и экраны замков из снимка ядра (`WindowLayerView`);
- меню приложения по вкладам плагинов: `bindAppMenu(plugins, base)` ставит `Menu.setApplicationMenu` из снимка `Kernel.menus` и пересобирает его при смене снимка, нажатие пункта исполняет его команду через ядро; `appMenuTemplate` - то же шаблоном без Electron; `baseAccelerators(base)` отдаёт сочетания построенного меню (в том числе тех, что Electron дал ролям: `copy`, `quit`, `resetZoom`), приложение передаёт их в `StartOptions.menuKeys`, и ядро ведёт их в одном реестре с командами окна, манифестами и `ctx.keys.register` (PL-03): ручной список занятых сочетаний не нужен;
- раскладку видов: `PluginsSnapshot.layout` (`LayoutRow`) - упорядоченный снимок `Kernel.layout` (область, `order`, заголовок), у вида плагина свой адрес для `<iframe>`; плагин с несколькими видами показывает все.

Делает приложение (в playground это `playground/src/main/main.ts` и `playground/src/renderer`):

- имя приложения (`app.setName`, заголовок окна, `appName`) и папку данных; без имени заголовок подписан «Cyborg»;
- разбор командной строки: `--workspace=`, `--no-workspace`, `--safe-mode` (имена флагов `restarts` берёт из `RestartFlags`), выбор воркспейса при старте и конфигурацию первого запуска (`cyborg.json`);
- список встроенных плагинов (`builtinDir`) и воспроизводимую сборку приложения: бандл главного процесса, preload, файл хоста, оболочка вида рядом с окном;
- **раскладку окна**: области, вкладки, в какой области какой вид; стили слоя окна (`.layer-dialog`, `.lock-screen`);
- **меню приложения**: свои меню и пункты (`base` для `bindAppMenu`: роли `appMenu`, `editMenu`, пункты воркспейса), подписи меню ядра (`workspace`, `view`, `tools`, `window`) и куда они встают; пункты плагинов приходят из снимка;
- окно (`BrowserWindow`) и его настройки: `preload`, `contextIsolation`, `sandbox`, `nodeIntegrationInSubFrames` (последнее нужно для моста вида);
- каналы, специфичные для приложения: `workspace:open` и `app:safe-mode` в playground регистрируются через `windowChannel` поверх `restarts()`;
- решение, что показывать на заблокированном экране, сверх того, что отдаёт ядро, и любую предметную область: адаптер её не знает.

Контракт разметки окна для `WindowLayerView` и перетаскивания: фрейм вида лежит в элементе с `data-plugin="<id плагина>"`, у того же элемента `data-view="<имя вида>"` (диалог вида встаёт у фрейма своего вида), фреймы видов внутри элемента `.views`; экран замка - в слое замков, который приложение передаёт в `WindowLayerView`.

## Окружение хоста плагинов

`utilityHosts` запускает хост с явным `env` (`utilityProcess.fork(..., { env })`), а не с `process.env` главного процесса: токены (`GITHUB_TOKEN`, `AWS_*`), `SSH_AUTH_SOCK`, `NODE_OPTIONS` и прочее из окружения приложения коду плагина не достаются (TR-02, [исследование доверия](../docs/research/trust-and-isolation/README.md), находка 1). Плагин берёт нужные переменные через `ctx.os.env` по праву `env`.

Перечень переменных хоста - `HOST_ENV_KEYS` в `electron/src/host-env.ts`, сегодня одна: `PATH`. Список минимальный и расширяется по доказательству (хост без переменной не стартует или плагин не находит программу), а не «на всякий случай»; проверяется на macOS и Linux дымовым тестом и пробой `npm run test:trust` (`playground/test/real/trust-real-host.test.ts`). Для самих программ плагина окружение по-прежнему собирает шлюз (`BASE_ENV` и имена из правила `process`, FR-CH-3003). Хост pty (`utilityPtyHost`) код плагинов не исполняет и окружение наследует.

Это ограничивает случайную утечку, а не злой умысел: код плагина в хосте по-прежнему читает файлы и открывает сеть мимо шлюза до этапа 2 (изоляция процесса, [ADR-CH-0003](../docs/04-architecture/adr/ADR-CH-0003-trust-and-isolation.md), «Расхождения»).

## Минимальный пример: окно и ядро

Три файла и страница. Их собирает и проверяет `electron/test/example.test.ts` (tsc и esbuild по блокам ниже), поэтому они не расходятся с кодом пакета.

Главный процесс (`main.ts`):

```ts
// file: main.ts
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, powerMonitor } from 'electron';
import {
  bindWindow,
  electronOs,
  guardNavigation,
  PluginsService,
  quitAfterPlugins,
  registerViewChannels,
  registerViewScheme,
  registerWindowChannels,
  resolveViewRequest,
  serveViews,
  utilityHosts,
  watchPower,
  windowEvents,
} from '@cyborg-harness/electron';

registerViewScheme(); // до app.ready: схема cyborg-plugin получает свой origin на плагина

let win: BrowserWindow | undefined;
const plugins = new PluginsService(windowEvents(() => win));
registerWindowChannels({ plugins, window: () => win });
registerViewChannels({ plugins, dragRoot: () => app.getPath('documents') });
quitAfterPlugins(plugins);

void app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  serveViews((url) => resolveViewRequest(url, (id) => plugins.uiOf(id), (id) => plugins.wake(id)), path.join(__dirname, 'shell'));
  win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
  });
  const page = path.join(__dirname, 'index.html');
  guardNavigation(win.webContents, pathToFileURL(page).href, (pluginId, url) => plugins.viewDenied(pluginId, url), plugins);
  bindWindow(win, plugins);
  watchPower(plugins);
  void win.loadFile(page);

  const hosts = utilityHosts(path.join(__dirname, 'plugin-host.mjs'));
  await plugins.start({
    userData,
    appName: 'Мой редактор',
    builtinDir: path.join(__dirname, 'plugins'),
    spawnHost: hosts.spawn,
    pidOf: hosts.pidOf,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    os: electronOs({ userData, roots: () => [app.getPath('documents')], protectedPaths: [], raiseWindow: () => win?.show() }),
    log: (line) => process.stderr.write(`${line}\n`),
  });
});
```

Preload (`preload.ts`): мост окна под именем, которое выбирает приложение, и мост вида.

```ts
// file: preload.ts
import { contextBridge } from 'electron';
import { exposeViewBridge, inWindowDocument, windowApi } from '@cyborg-harness/electron/preload';

exposeViewBridge();
if (inWindowDocument()) contextBridge.exposeInMainWorld('app', windowApi());
```

Окно (`renderer.ts`): снимок от главного процесса, фрейм на каждый вид плагина, слой окна.

```ts
// file: renderer.ts
import { WindowLayerView, type PluginsSnapshot, type WindowApi } from '@cyborg-harness/electron/window';

const api = (window as unknown as { app: WindowApi }).app;
const layer = new WindowLayerView(api, document.body, document.getElementById('locks') ?? document.body);
const views = document.getElementById('views') ?? document.body;

let shown = '';

async function refresh(): Promise<void> {
  const snapshot: PluginsSnapshot = await api.pluginsSnapshot();
  // Фреймы пересоздаются только при смене состава видов: снятый с документа iframe теряет состояние.
  const wanted = snapshot.layout.filter((e) => e.kind === 'view' && e.url !== undefined);
  const layout = JSON.stringify(wanted.map((e) => [e.pluginId, e.name, e.url]));
  if (layout !== shown) {
    shown = layout;
    views.replaceChildren(
      ...wanted.map((e) => {
        const box = document.createElement('div');
        box.dataset.plugin = e.pluginId;
        box.dataset.view = e.name;
        box.append(Object.assign(document.createElement('iframe'), { src: e.url, title: `${e.pluginId}: ${e.name}` }));
        return box;
      }),
    );
  }
  layer.sync(snapshot.window, snapshot.plugins);
}

api.onPluginsChanged(() => void refresh());
void refresh();
```

Страница `index.html` - `<div id="views" class="views"></div><div id="locks"></div><script src="renderer.js"></script>`; в playground это `playground/src/renderer/index.html`.

Сборка (esbuild; так её делает `playground/scripts/build.mjs`):

```sh
# главный процесс: cjs, electron и node-pty снаружи
esbuild main.ts --bundle --platform=node --format=cjs --external:electron --external:node-pty --outfile=dist/main.js
# preload: песочница даёт только electron
esbuild preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=dist/preload.js
# процесс pty-хоста (utilityProcess с node-pty): cjs, node-pty снаружи
echo "import '@cyborg-harness/electron/pty-host-entry';" | esbuild --bundle --platform=node --format=cjs --external:electron --external:node-pty --resolve-dir=. --outfile=dist/pty-host.js
# файл хоста для utilityProcess: ESM (в cjs esbuild заменил бы import() плагина на require)
echo "import '@cyborg-harness/electron/host-entry';" | esbuild --bundle --platform=node --format=esm --outfile=dist/plugin-host.mjs
# окно и оболочка вида (готовые файлы пакета кладутся рядом с окном)
esbuild renderer.ts --bundle --platform=browser --format=iife --outfile=dist/renderer.js
cp node_modules/@cyborg-harness/electron/dist/shell/shell.{js,js.map,css} dist/shell/
```

Хост плагинов - отдельный процесс со своим бандлом: ядро запускает `utilityProcess.fork(<файл>)`, поэтому `host-entry` собирается в файл приложения (путь передаётся в `utilityHosts`), а не импортируется из пакета на лету.

## Сборка приложения: фьюзы и подпись (TR-07)

Пакет `@cyborg-harness/electron` фьюзы не переключает: бинарник Electron собирает приложение-потребитель. Что приложение обязано сделать при сборке (исследование доверия: [план, TR-07](../docs/research/trust-and-isolation/06-work-plan.md#62-задачи), [5.3, п. 5](../docs/research/trust-and-isolation/05-decision.md), [вопрос 2](../docs/research/trust-and-isolation/07-open-questions.md#71-вопросы-владельцу)); проверка на упакованном приложении - `npm run pack:delivery` (`playground/scripts/pack-delivery.mjs`, шаг CI «упакованная поставка», [bundled-delivery.md](../docs/05-verification/bundled-delivery.md)).

| Фьюз (`FuseV1Options`) | Значение | Зачем | Проверка на упакованном приложении |
|---|---|---|---|
| `RunAsNode` | **выключен** | `ELECTRON_RUN_AS_NODE` делает подписанный бинарник приложения Node-интерпретатором с личностью приложения (доступ к ключу `safeStorage` в Keychain, права TCC): любой процесс пользователя получил бы их. Приложению режим Node не нужен: хосты плагинов и pty-хост - `utilityProcess`. Решение принято по поручению владельца 2026-11-13 по рекомендации вопроса 2 и результату спайка TR-20 ([spike-node-host.md](../docs/05-verification/spike-node-host.md)); процесс Node для сторонних плагинов (TR-21) идёт отдельным бинарником Node, а не этим | под `ELECTRON_RUN_AS_NODE=1` приложение поднимается как приложение, исходный Electron становится Node |
| `EnableNodeOptionsEnvironmentVariable` | **выключен** | `NODE_OPTIONS=--require=…` исполнил бы чужой код в главном процессе | `NODE_OPTIONS=--require` исходным Electron исполняется, упакованным приложением - нет |
| `EnableNodeCliInspectArguments` | **выключен** (отладочную сборку можно оставить включённой) | `--inspect` и сигнал `SIGUSR1` открывали бы отладчик главного процесса | `--inspect=0` в приложении по чек-листу не открывает отладчик, в копии с включённым фьюзом открывает |
| `EnableEmbeddedAsarIntegrityValidation` | **включён на macOS и Windows** (Linux этот фьюз Electron не поддерживает) | подмена `app.asar` в `Resources` отвергается; нужен `ElectronAsarIntegrity` в `Info.plist` (macOS) или ресурс `Integrity` (Windows) с sha256 заголовка архива (`getRawHeader` из `@electron/asar`) | macOS: подменённый `app.asar` при прежнем хеше - приложение завершается (SIGTRAP) |
| `OnlyLoadAppFromAsar` | **включён** | без него код приложения ищется в `app.asar`, затем в каталоге `app`, и проверка целостности обходится каталогом рядом | без `app.asar` каталог `resources/app` не исполняется |
| `EnableCookieEncryption` | **включён** | cookie на диске шифруются ключом ОС (на macOS нужна подпись приложения, как для `safeStorage`); переход односторонний | фьюз прочитан из бинарника |
| `GrantFileProtocolExtraPrivileges` | по умолчанию (включён) | окно приложения грузится как `file://`; выключение отнимает у `file://` особые права и может сломать окно потребителя | не проверялось: решение за приложением, в playground не менялось |
| `LoadBrowserProcessSpecificV8Snapshot`, `WasmTrapHandlers` | по умолчанию | ядру не нужны | - |

Порядок сборки на macOS: упаковать `app.asar` -> переключить фьюзы (они лежат в `Electron Framework`, общем для всех помощников приложения: фьюз нельзя включить только для одного исполняемого файла) -> записать `ElectronAsarIntegrity` в `Info.plist` -> подписать пакет (подпись недействительна после любой правки, включая фьюзы) -> нотаризовать. На Linux фьюзы лежат в самом исполняемом файле `electron`. Переключать можно пакетом `@electron/fuses` (`flipFuses`) или плагином Electron Forge; проба в playground читает и пишет провод фьюзов своим кодом (`playground/scripts/fuses.mjs`, ~50 строк), чтобы не добавлять зависимость.

Что это значит для запуска процесса Node вне `utilityProcess`: при выключенном `RunAsNode` `child_process.fork(…, { execPath: <бинарник Electron> })` запускает бинарник как приложение (`process.type === 'browser'`, полный Electron), а не как Node. `forkHosts({ execPath, env, execArgv })` для хоста стороннего плагина берёт отдельный бинарник Node; ограничения и цена - [spike-node-host.md](../docs/05-verification/spike-node-host.md).

## Точки расширения

Места, под которые пакет оставлен открытым для следующих задач; все они не меняют поведения по умолчанию.

| Задача | Точка |
|---|---|
| K-01, pty-хост отдельным процессом ядра | сделано: `electronOs({ ptyHost: utilityPtyHost('dist/pty-host.js').spawn })`, точка входа процесса - `@cyborg-harness/electron/pty-host-entry`; без `ptyHost` pty остаются в главном процессе (`pty` или `node-pty`). `ViewTerminals` раздаёт виду порт `MessageChannelMain`, preload принимает его сам |
| K-04, группы рендера (origin по группе) | сделано: origin вида - группа (`viewOrigin`, `groupOfOrigin` в `view-protocol.ts`), плагин - первый сегмент пути, адрес вида в `LayoutRow.url`; плагин вида мост берёт из привязки к кадру (TR-31: `frameTreeNodeId`, плагин записывается при фиксации документа по адресу, `pushState` его не меняет) и только если он состоит в группе кадра (`ViewGroups`, его реализует `PluginsService`); привязку ведёт `guardNavigation(..., groups)`, она же нужна `viewChannel(groups, ...)`: приложение, не вызвавшее `guardNavigation`, не получит ни одного вида |
| K-05, строгая CSP вида | сделано: заголовок считается на ответ по флагу `ui.inlineStyles` плагина (`PluginUi.inlineStyles` -> `ViewRequest.inlineStyles` -> `viewCsp(inlineStyles)`); `VIEW_CSP` - политика без флага (`default-src 'none'`, явные источники, `base-uri 'none'`, `form-action 'none'`); `serveViews(resolve, shellDir, { csp })` с строкой или функцией `(плагин, группа, inlineStyles)` заменяет её (так пилот PL-05 задаёт наборы) |
| K-09, K-13, каналы «главная часть - вид», отмена запросов | `viewChannel(plugins, channel, handler)`: канал, который принимает только вид плагина, плагин берётся из адреса фрейма в группе его origin; `windowChannel` - то же для документа окна. Имена каналов приложения не пересекаются с `plugins:`, `view:`, `window:`, `documents:`, `views:` |
| K-11, переключатель безопасного режима | `restarts({ flags })` и канал `app:safe-mode` приложения; флаг и вопрос о живых pty - в пакете |

Проверка каналов: `electron/test/channels.test.ts` сверяет имена в `preload.ts` и в главном процессе.

## Проверки

- `npm run build:electron` - сборка `electron/dist` (`electron/scripts/build.mjs`: tsc 7 по `electron/tsconfig.build.json`, объявления переписываются с `.ts` на `.js`, оболочка вида собирается esbuild). Идёт перед `build`, `typecheck`, `lint` и `test`.
- `npm test` - тесты пакета в `electron/test`: состав входов, граница, каналы, пример из этого файла, файлы видов, навигация, терминалы видов, перетаскивание, служба плагинов.
- Состав архива: `cd electron && npm pack --dry-run`.
- Окно целиком: `npm run smoke` (playground на этом пакете; macOS и Linux в CI).
