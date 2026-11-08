# @cyborg-harness/core

Ядро плагинов Cyborg Harness: загрузчик манифестов, граф контрактов, хосты со сторожем, шлюз `ctx.os`, журнал, конфиг и состояние плагинов. Предметной области, Electron и npm-зависимостей в ядре нет (ADR-CH-0001). Устройство - `docs/03-architecture/design/sad.md`.

Пакет приватный (`private: true`) и в реестр не опубликован: публикация - задача P-10. Пока он ставится из архива `npm pack` или как workspace этого репозитория.

## Что внутри

В пакете лежит собранный JS (ESM, без бандла, по файлу на модуль ядра) и `.d.ts`; исходники `.ts` в него не входят. Причина: Node не снимает типы у файлов внутри `node_modules`, а в самих исходниках импорты написаны с расширением `.ts`.

Точки входа (`exports`; границу публичного API уточняет T-09, эта раскладка - стартовая):

| Импорт | Что даёт | Где работает |
|---|---|---|
| `@cyborg-harness/core` | ядро целиком: `load`, `Kernel`, `forkHosts`, `inlineHosts`, `parseManifest`, `PLUGIN_API_VERSION`, разделы config и state, шлюз `ctx.os`, воркспейс, окно (`WindowLayer`), документы, оболочка вида | главный процесс, Node |
| `@cyborg-harness/core/host` | `runHost`: код хоста плагинов поверх любого порта сообщений | процесс хоста (Node `fork`, Electron `utilityProcess`) |
| `@cyborg-harness/core/host-entry` | готовый вход хоста для `child_process.fork`; сам импортировать не нужно, на него указывает `forkHosts` | дочерний процесс Node |
| `@cyborg-harness/core/keys` | разбор нажатий: `keyOfInput` | окно (браузер), без `node:*` |
| `@cyborg-harness/core/ui-shell` | оболочка вида плагина: `mountModule`, `connectView`, `keepFocus` | окно (браузер), без `node:*` |
| `@cyborg-harness/core/elements` | кастомные элементы `cy-*`; регистрирует их при импорте; нужен DOM | окно (браузер) |

Рантайм-зависимостей нет. Единственная связь - peer `@cyborg-harness/contracts` (`^1.0.0`), и только типами: в собранном JS на него ссылок нет.

## Версии

- Node: `engines.node` `>=24`. Это Node из Electron 45, который использует playground (`process.versions.node` в Electron 45.2.2 - 24.22.2), и Node в CI. Версию Electron в ai-cyborg предстоит сверить до первого релиза.
- Версия пакета `0.1.0` - до заморозки API (T-03, T-09). Мажор `@cyborg-harness/contracts` совпадает с мажором API плагинов (`PLUGIN_API_VERSION`).
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

### Хост в бандле

В cjs-бандле (главный процесс Electron) `import.meta.url` пуст, и `forkHosts()` не выведет путь входа хоста. Приложение задаёт его явно:

```ts
forkHosts({ entry: require.resolve('@cyborg-harness/core/host-entry') });
```

Хосты в `utilityProcess` не используют `forkHosts`: приложение запускает свой файл, а он вызывает `runHost` из `@cyborg-harness/core/host` (пример - `playground/src/main/plugin-host.ts`).

## Сборка и проверка

```sh
npm run build:core                 # core/dist: JS и .d.ts (tsc по core/tsconfig.build.json и core/elements/tsconfig.build.json)
cd core && npm pack --dry-run      # состав архива
npm test                           # в том числе core/test/package.test.ts (состав) и core/test/consumer.test.ts (пустой проект из архивов)
```

`build:core` идёт сам перед `build`, `typecheck`, `lint` и `test` (хуки `pre*` в корневом `package.json`): playground берёт ядро через пакет, то есть из `core/dist`.
