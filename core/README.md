# @cyborg-harness/core

Ядро плагинов Cyborg Harness: загрузчик манифестов, граф контрактов, хосты со сторожем, шлюз `ctx.os`, журнал, конфиг и состояние плагинов. Предметной области, Electron и npm-зависимостей в ядре нет (ADR-CH-0001). Устройство - `docs/04-architecture/design/sad.md`.

Пакет в реестр ещё не опубликован: выпуск идёт по тегу `v<версия>` ([`release.yml`](../.github/workflows/release.yml), [SAD 3.3](../docs/04-architecture/design/sad.md#пакет-контрактов-поставка-и-версии)), доступ при выпуске `restricted`, лицензия не выбрана (`UNLICENSED`, выбор за владельцем). Пока он ставится из архива `npm pack` или как workspace этого репозитория; изменения - в [CHANGELOG](CHANGELOG.md).

## Что внутри

В пакете лежит собранный JS (ESM, без бандла, по файлу на модуль ядра) и `.d.ts`; исходники `.ts` в него не входят. Причина: Node не снимает типы у файлов внутри `node_modules`, а в самих исходниках импорты написаны с расширением `.ts`.

Точки входа (`exports`). Публичный API - только то, что перечислено ниже; всё остальное в пакете (`dist/src/*`, прочие модули ядра) внутреннее и совместимостью не обещано. Глубокие пути `@cyborg-harness/core/dist/...` пакет закрывает (`exports`), а в репозитории это держит `core/test/public-api.test.ts`.

| Импорт | Что даёт | Где работает |
|---|---|---|
| `@cyborg-harness/core` | главный процесс: `load` и `Kernel`, `forkHosts`, `inlineHosts`, `parseManifest`, `PLUGIN_API_VERSION`, `openWorkspace` и `RecentWorkspaces`, экземпляр на воркспейс и общий `userData` (`claimInstance`, `workspaceKey`, `withFileLock`; K-20), `SectionStore` (config и state), среда шлюза `ctx.os` (`OsEnvironment`), `PtyTable`, разбор журнала (`pluginStatuses`, `describeEntry`, `entryLevel`, `entryPlugins`, `describePermissions`, `describeOpenCommands`), `WINDOW_OWNER` и `MENU_OWNER` (владельцы сочетаний окна и меню) и типы к ним | главный процесс, Node |
| `@cyborg-harness/core/host` | `runHost`: код хоста плагинов поверх любого порта сообщений | процесс хоста (Node `fork`, Electron `utilityProcess`) |
| `@cyborg-harness/core/host-entry` | готовый вход хоста для `child_process.fork`; сам импортировать не нужно, на него указывает `forkHosts`; имён не экспортирует | дочерний процесс Node |
| `@cyborg-harness/core/keys` | `keyOfInput`, `KeyInput`: нажатие -> сочетание ядра | окно (браузер), без `node:*` |
| `@cyborg-harness/core/ui-shell` | оболочка вида плагина: `mountModule`, `connectView`, `keepFocus` и типы моста | окно (браузер), без `node:*` |
| `@cyborg-harness/core/window` | то, что главный процесс отдаёт окну: `WINDOW_OWNER`, типы `WindowSnapshot`, `ShownDialog`, `WindowLock`, `WindowTitle`, `DocumentRow`, `DisablePreview`, `LayoutEntry`, `Area` | окно (браузер), без `node:*` |
| `@cyborg-harness/core/plugin-check` | `checkPlugin(dir, options)`, `formatProblem` (строка отчёта, как у `cyborg-plugin check`), `isTestPath`, `CHECKED_KEYS` и `ENTRY_FILES` (какие файлы манифеста проверка читает; на них опирается `cyborg-plugin build`) и типы `CheckOptions`, `CheckReport`, `FileRef`, `Problem`, `ImportRules`: проверка каталога плагина без запуска его кода (манифест, версия API, файлы из манифеста, правило импортов); те же данные печатает команда `cyborg-plugin check` | Node, инструмент автора и сборки |
| `@cyborg-harness/core/delivery` | `writeDelivery(каталог)` (хеши sha256 всех файлов каждого плагина каталога поставки -> `delivery.json`), `readDelivery`, `verifyDelivery(каталог, список)` (строка на расхождение: изменённый, пропавший и лишний файл, пропавший и лишний каталог плагина), `DELIVERY_FILE`, `DeliveryManifest`: контрольные суммы поставки (P-07, SAD 6.1); на этапе 1 расхождение только сообщается | Node, сборка поставки и адаптер приложения |
| `@cyborg-harness/core/elements` | кастомные элементы `cy-*`; `defineElements`; регистрирует их при импорте; нужен DOM | окно (браузер) |

Точный перечень имён каждой точки входа - в `core/test/public-api.test.ts` (`ENTRIES`): тест падает, если имя добавлено или убрано без правки перечня, если вход написан через `export *`, если из публичной сигнатуры (по собранным `core/dist/**/*.d.ts`, где видны и выведенные типы) торчит безымянный тип и если JS окна достаёт до `node:*`. Источник входов - `core/src/index.ts`, `index-host.ts`, `index-keys.ts`, `index-ui-shell.ts`, `index-window.ts`, `index-plugin-check.ts`, `index-delivery.ts`. Имя в перечень добавляют осознанно: каждое обещает совместимость.

Что вынесено из публичного (было в общем `index.ts`): `readJson`, `writeJsonAtomic`, `lockWorkspace`, `settingsLayer` и остальное устройство воркспейса, `isRecord`, `errorMessage` и прочие помощники, `WindowLayer`, `DocumentTable`, `DeniedCollapse`, разбор манифеста по частям (`checkArgs`, `viewEntry`, `readPermissions`), граф и реестр контрактов (`resolveGraph`, `ContractRegistry` как значение), `Endpoint`, `runHost` из главного входа (теперь только `/host`). Оболочка вида (`ui-shell`) из главного входа убрана: она нужна окну.

Низкоуровневые `OsGateway` и `PtyTable` оставлены в главном входе ради замеров и тестов приложения (шлюз и pty без хоста): их конструкторы позиционные и обещаны слабее остального, а типы их параметров имён не имеют. Встраивающему приложению они не нужны: шлюз и pty строит `load` по `OsEnvironment`.

Рантайм-зависимостей нет. Единственная связь - peer `@cyborg-harness/contracts` (`>=1.0.0-0 <2.0.0`: мажор 1 и предрелизы самой 1.0.0 вроде `1.0.0-dev`; предрелиз следующей версии, например `1.1.0-dev`, в диапазон не входит), и только типами: в собранном JS на него ссылок нет.

## Версии

- Node: `engines.node` `>=24`. Это Node из Electron 45, который использует playground (`process.versions.node` в Electron 45.2.2 - 24.22.2), и Node в CI. Версию Electron в ai-cyborg предстоит сверить до первого релиза.
- Версия пакета `0.1.0` - до заморозки API (T-03); границу публичного API задал T-09. Мажор `@cyborg-harness/contracts` совпадает с мажором API плагинов (`PLUGIN_API_VERSION`).
- Сборка идёт TypeScript 7 (`typescript7`) с `rewriteRelativeImportExtensions`; цель - ES2022.

## Минимальный пример

```ts
import { forkHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';

const kernel = await load({
  apiVersion: PLUGIN_API_VERSION,
  enabled: ['hello'],
  // Манифесты - сырой JSON из plugin.json плагинов; ядро разбирает и проверяет их само.
  manifests: [{ id: 'hello', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'hello.say': {} } }],
  spawnHost: forkHosts(), // хосты - дочерние процессы Node; в Electron - свой SpawnHost поверх utilityProcess
  entry: (m) => new URL(`./plugins/${m.id}.ts`, import.meta.url).href,
});

console.log(await kernel.run('hello.say')); // hello
await kernel.unload();
```

Модуль плагина `plugins/hello.ts`:

```ts
import type { PluginModule } from '@cyborg-harness/core';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.commands.register('hello.say', () => 'hello');
  },
};
export default plugin;
```

Рабочие сценарии - `core/examples` (`npm run demo -- all`); та же сборка, идущая на пакете, проверяется тестом `core/test/consumer.test.ts`.

### Проверка плагина вне репозитория

```sh
npx cyborg-plugin check path/to/plugin [--declarations ../contracts.ts] [--declarations-package @acme/contracts]   # команда - в пакете cyborg-plugin (tools/cyborg-plugin), не в ядре
```

Код возврата 0 - нарушений нет, 1 - есть, 2 - неверный вызов; нарушения печатаются как `файл:строка: причина`, права плагина - словами. Из кода:

```ts
import { checkPlugin, formatProblem } from '@cyborg-harness/core/plugin-check';

const report = await checkPlugin('path/to/plugin', { declarationPackages: ['@acme/contracts'] });
if (!report.ok) throw new Error(report.problems.map(formatProblem).join('\n'));
```

Импорты разбирает лёгкий лексер (`src/plugin-scan.ts`), а не компилятор TypeScript: зависимостей у ядра нет. Что проверяется и чего проверка не видит - `docs/guide/authors/testing.md`.

### Хост в бандле

В cjs-бандле (главный процесс Electron) `import.meta.url` пуст, и `forkHosts()` не выведет путь входа хоста. Приложение задаёт его явно:

```ts
forkHosts({ entry: require.resolve('@cyborg-harness/core/host-entry') });
```

Хосты в `utilityProcess` не используют `forkHosts`: приложение запускает свой файл, а он вызывает `runHost` из `@cyborg-harness/core/host` (пример - `electron/src/host-entry.ts`).

## Сборка и проверка

```sh
npm run build:core                 # core/dist: JS и .d.ts (tsc по core/tsconfig.build.json и core/elements/tsconfig.build.json)
cd core && npm pack --dry-run      # состав архива
npm test                           # в том числе core/test/package.test.ts (состав) и core/test/consumer.test.ts (пустой проект из архивов)
```

`build:core` идёт сам перед `build`, `typecheck`, `lint` и `test` (хуки `pre*` в корневом `package.json`): playground берёт ядро через пакет, то есть из `core/dist`.
