# @cyborg-harness/electron

Адаптер Electron для ядра плагинов [`@cyborg-harness/core`](../core/README.md): всё, что связывает ядро с Electron, чтобы приложению (ai-cyborg, playground) не копировать это руками. Хосты плагинов в `utilityProcess`, среда `ctx.os` (`safeStorage`, `node-pty`, `shell`, `dialog`, `clipboard`, уведомления), схема `cyborg-plugin://` и мост видов, каналы IPC окна и видов, перехват клавиш, события окна и питания, одиночный экземпляр, слой окна. Решение о форме: пакет в этом репозитории, прокладку `window.cyborg` и свои каналы IPC поверх этого не вводим (D-00, строки 3 и 4; [SAD](../docs/04-architecture/design/sad.md), разд. 1).

Пакет приватный (`private: true`) и в реестр не опубликован: публикация - задача P-10. Пока он ставится как workspace этого репозитория или из архива `npm pack`.

## Что внутри

В пакете лежит собранный JS (ESM, без бандла, по файлу на модуль) и `.d.ts`; исходники `.ts` в него не входят. Оболочка вида собрана отдельно: `dist/shell/shell.js` и `shell.css` - файлы для окна, не модули.

| Импорт | Что даёт | Где работает |
|---|---|---|
| `@cyborg-harness/electron` | служба плагинов (`PluginsService`, `startPlugins`, `discoverPlugins`), хосты (`utilityHosts`), среда ОС (`electronOs`), схема видов (`registerViewScheme`, `serveViews`, `resolveViewRequest`, `guardNavigation`), каналы (`registerWindowChannels`, `registerViewChannels`, `windowChannel`, `viewChannel`), окно и приложение (`windowEvents`, `bindWindow`, `watchPower`, `watchTheme`, `singleInstance`, `quitAfterPlugins`, `showWindow`), перезапуски (`restarts`, `workspaceInfo`) | главный процесс Electron |
| `@cyborg-harness/electron/host-entry` | точка входа файла для `utilityProcess`: `process.parentPort` -> `runHost` ядра; имён не экспортирует | процесс хоста (`utilityProcess`) |
| `@cyborg-harness/electron/preload` | мосты: `windowApi()` (окно просит у главного процесса), `exposeViewBridge()` (`window.cyborgView` во фрейме вида), `inViewFrame`, `inWindowDocument` | preload (песочница) |
| `@cyborg-harness/electron/window` | общее главного процесса и окна: снимок `PluginsSnapshot` и строки `PluginRow`, `WindowLayerView` (слой окна: диалоги видов и замки), протокол видов (`VIEW_SCHEME`, `viewOrigin`, `pluginOfOrigin`, `PATH_MIME`) | окно (браузер), без `node:*` и Electron |
| `@cyborg-harness/electron/shell/shell.js`, `.../shell.css` | оболочка вида плагина одним скриптом (на `@cyborg-harness/core/ui-shell` и `/elements`) | фрейм вида |

Точный перечень имён каждого входа - `electron/test/public-api.test.ts` (`ENTRIES`): тест падает, если имя добавлено или убрано без правки перечня, если вход написан через `export *` и если JS входа окна достаёт до `node:*`. Имя в перечень добавляют осознанно: оно обещает совместимость. Всё остальное в пакете (`dist/src/*`) внутреннее.

Границу держит `electron/test/boundary.test.ts`: в пакете нет импортов из `playground/` и из внутренностей ядра (только публичные входы, их перечень - `core/test/public-api.test.ts`), а playground берёт адаптер только через эти входы.

Peer-зависимости: `@cyborg-harness/core`, `@cyborg-harness/contracts` (типы), `electron` (`>=45`), `node-pty` (`^1.1.0`; его нативную сборку под Electron делает приложение - в этом репозитории `electron-rebuild` в `postinstall`). Рантайм-зависимостей нет. Node - `>=24` (Node из Electron 45).

## Что даёт пакет и что делает приложение

Даёт пакет, поведение одно для всех приложений:

- хосты плагинов процессами `utilityProcess` со сторожем ядра: `utilityHosts(entry)` и файл `host-entry`;
- среду `ctx.os` на Electron: секреты в файле под `safeStorage`, pty через `node-pty` с убийством группы, `shell`, `dialog`, `clipboard`, уведомления ОС;
- службу плагинов для окна: поиск плагинов в каталогах, старт ядра, снимок (`PluginsSnapshot`: плагины, раскладка видов, клавиши, лента, журнал, слой окна, документы), команды, выключение и включение;
- схему `cyborg-plugin://<плагин>/`: свой origin на плагин, оболочка и файлы вида, строгая CSP, защита от выхода за каталог плагина и от симлинков, запрет новых окон и ухода окна со своих адресов (`guardNavigation`);
- каналы IPC: окно -> служба плагинов и вид -> служба плагинов (плагин всегда берётся из origin фрейма, не из аргументов), терминалы видов, перетаскивание файлов между видами, тема видов;
- перехват клавиш ядром раньше страницы, события фокуса окна, сна, пробуждения и блокировки экрана, выход с ожиданием `onBeforeQuit` плагинов, одиночный экземпляр;
- перезапуск приложения при смене воркспейса и безопасного режима с вопросом о живых pty;
- слой окна: диалоги видов и экраны замков из снимка ядра (`WindowLayerView`);
- раскладку видов: `PluginsSnapshot.layout` (`LayoutRow`) - упорядоченный снимок `Kernel.layout` (область, `order`, заголовок), у вида плагина свой адрес для `<iframe>`; плагин с несколькими видами показывает все.

Делает приложение (в playground это `playground/src/main/main.ts` и `playground/src/renderer`):

- имя приложения (`app.setName`, заголовок окна, `appName`) и папку данных; без имени заголовок подписан «Cyborg»;
- разбор командной строки: `--workspace=`, `--no-workspace`, `--safe-mode` (имена флагов `restarts` берёт из `RestartFlags`), выбор воркспейса при старте и конфигурацию первого запуска (`cyborg.json`);
- список встроенных плагинов (`builtinDir`) и воспроизводимую сборку приложения: бандл главного процесса, preload, файл хоста, оболочка вида рядом с окном;
- **раскладку окна**: области, вкладки, в какой области какой вид; меню; стили слоя окна (`.layer-dialog`, `.lock-screen`);
- окно (`BrowserWindow`) и его настройки: `preload`, `contextIsolation`, `sandbox`, `nodeIntegrationInSubFrames` (последнее нужно для моста вида);
- каналы, специфичные для приложения: `workspace:open` и `app:safe-mode` в playground регистрируются через `windowChannel` поверх `restarts()`;
- решение, что показывать на заблокированном экране, сверх того, что отдаёт ядро, и любую предметную область: адаптер её не знает.

Контракт разметки окна для `WindowLayerView` и перетаскивания: фрейм вида лежит в элементе с `data-plugin="<id плагина>"`, у того же элемента `data-view="<имя вида>"` (диалог вида встаёт у фрейма своего вида), фреймы видов внутри элемента `.views`; экран замка - в слое замков, который приложение передаёт в `WindowLayerView`.

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
  serveViews((url) => resolveViewRequest(url, (id) => plugins.uiOf(id, true)), path.join(__dirname, 'shell'));
  win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
  });
  const page = path.join(__dirname, 'index.html');
  guardNavigation(win.webContents, pathToFileURL(page).href, (pluginId, url) => plugins.viewDenied(pluginId, url));
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

## Точки расширения

Места, под которые пакет оставлен открытым для следующих задач; все они не меняют поведения по умолчанию.

| Задача | Точка |
|---|---|
| K-01, pty-хост отдельным процессом ядра | сделано: `electronOs({ ptyHost: utilityPtyHost('dist/pty-host.js').spawn })`, точка входа процесса - `@cyborg-harness/electron/pty-host-entry`; без `ptyHost` pty остаются в главном процессе (`pty` или `node-pty`). `ViewTerminals` раздаёт виду порт `MessageChannelMain`, preload принимает его сам |
| K-04, группы рендера (origin по группе) | origin вида строится в одном месте - `viewOrigin` и `pluginOfOrigin` в `view-protocol.ts`; адрес вида в `LayoutRow.url` |
| K-05, строгая CSP вида | `serveViews(resolve, shellDir, { csp })`: строка или функция от плагина из адреса запроса; по умолчанию `VIEW_CSP` |
| K-09, K-13, каналы «главная часть - вид», отмена запросов | `viewChannel(channel, handler)`: канал, который принимает только вид плагина, плагин берётся из origin фрейма; `windowChannel` - то же для документа окна. Имена каналов приложения не пересекаются с `plugins:`, `view:`, `window:`, `documents:`, `views:` |
| K-11, переключатель безопасного режима | `restarts({ flags })` и канал `app:safe-mode` приложения; флаг и вопрос о живых pty - в пакете |

Проверка каналов: `electron/test/channels.test.ts` сверяет имена в `preload.ts` и в главном процессе.

## Проверки

- `npm run build:electron` - сборка `electron/dist` (`electron/scripts/build.mjs`: tsc 7 по `electron/tsconfig.build.json`, объявления переписываются с `.ts` на `.js`, оболочка вида собирается esbuild). Идёт перед `build`, `typecheck`, `lint` и `test`.
- `npm test` - тесты пакета в `electron/test`: состав входов, граница, каналы, пример из этого файла, файлы видов, навигация, терминалы видов, перетаскивание, служба плагинов.
- Состав архива: `cd electron && npm pack --dry-run`.
- Окно целиком: `npm run smoke` (playground на этом пакете; macOS и Linux в CI).
