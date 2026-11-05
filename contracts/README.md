# @cyborg/contracts

Пакет объявлений контрактов без логики. Поставщик и потребитель не знают друг друга: оба импортируют отсюда тип и называют контракт по имени и мажорной версии.

## Карта контрактов

`Contracts` — карта «имя → мажорная версия → тип». Один тип описывает одну мажорную версию со всеми её минорными.

```ts
export interface Contracts {
  'cyborg.files': { 1: FilesV1; 2: FilesV2 };
  'cyborg.tab': { 1: Tab };
}
```

| Правило | Почему |
|---|---|
| Член, добавленный в минорной версии, объявляется необязательным (`icon?` с 1.1) | Поставщик 1.0 удовлетворяет тому же типу, а потребитель обязан проверить, что член есть |
| Новая мажорная версия — новый ключ карты и новый тип | Поставщик может отдавать обе версии сразу, каждый потребитель получает ту, что просил |
| Методы объявляются асинхронными, аргументы и результат — данные | Вызов идёт через границу хоста; функцию, класс и `Map` RPC не передаёт |
| Подписка — единственный обратный вызов, она возвращает `Subscription` с `dispose()` | Колбэк остаётся в хосте потребителя; ядро снимает подписку при выгрузке или падении любой из сторон |

## API плагина

`PluginModule`, `PluginContext` и типы вида (`UiModule`, `UiContext`, `ThemeTokens`, `FeedLine`) объявлены здесь же: плагин импортирует только этот пакет и свои модули, а `core/test/plugin-imports.test.ts` проверяет это по каждому файлу плагинов.

События окна и ОС - `ctx.window.onFocusChange` и `ctx.system`: `onSuspend`, `onResume`, `onScreenLock`, `onIdle(seconds, cb)` (один раз на каждый простой от `seconds`), `onBeforeQuit` (ядро ждёт асинхронного слушателя не дольше бюджета приложения). Подписки снимаются вместе с плагином; упавший слушатель пишет в журнал плагина и соседям не мешает.

Вид плагина - ES-модуль из `"ui": { "views": { "main": "./ui/ui.js" } }` с `export function mount(root, ctx: UiContext): Disposable`. `UiContext` - команды, контракты (`ctx.contracts.get` отдаёт удалённый объект: только методы, ответ - данные), токены темы `--cy-*` уже стоят на `documentElement` до `mount`, `ctx.theme.onChange`, `ctx.onVisibilityChange` (свёрнутый вид не размонтируется), лента журнала и перетаскивание. `ctx.os` у вида нет. Мост вида (`ViewBridge`) - внутреннее дело ядра, плагин его не видит.

`"activation": "lazy"` в манифесте откладывает активацию: плагин ждёт первой команды или сочетания, показа своего вида или потребителя своего контракта. Поставщика из `requires` и `optional` ядро поднимает до потребителя, поставщиков `consumes` будит без ожидания.

## Доступ к ОС: `ctx.os`

Права - поле `permissions` манифеста; нет права - нет члена в `ctx.os`, а вызов в обход формы отклоняет шлюз ядра в главном процессе.

```jsonc
"permissions": {
  "fs.read": ["workspace"],                       // ещё plugin-data, plugin-temp, абсолютный путь, ~/...
  "process": ["git", { "program": "npm", "args": ["test"], "env": ["CI"] }],  // env - что можно передать программе
  "pty": ["claude"],                              // та же форма; процесс держит ядро
  "net": ["api.github.com", "config:baseUrl"],    // config: - хост из своего раздела config
  "env": ["HOME"], "notify": true, "clipboard": ["read"],
  "secrets.ref": ["vault://kv/data/jira*"]
}
```

| Член | Без права |
|---|---|
| `paths.data`, `paths.temp`, `fs.*` в них | доступны всегда |
| `fs.*` вне своих каталогов | `PermissionDenied` |
| `secrets.get/set/delete` | свои ключи; без шифрования ОС - `Unavailable` |
| `process`, `pty`, `net`, `env`, `notify`, `clipboard`, `security` | члена нет |

Путь только абсолютный, проверяется после `realpath`: симлинк наружу области не выводит, файл воркспейса, данные приложения, каталоги других плагинов и запись в `.git` закрыты. Программа из `process` и `pty` получает только базовое окружение (PATH, HOME, локаль) и переменные, названные в `env` её правила.

pty держит ядро: `ctx.os.pty.spawn({ program, args, cwd, env, cols, rows, persist })` отдаёт ручку с `onData`, `onExit`, `write`, `resize`, `kill`. С `persist: true` процесс переживает падение хоста плагина; вернувшийся плагин находит его через `list()` и забирает `attach(id)` вместе с хвостом вывода `backlog`. Каждый отказ - запись `denied` в журнале плагинов. `ctx.secrets.resolve('token')` или `resolve({ $secret: 'token' })` берёт секрет из своего хранилища; ссылка со схемой (`vault://...`) должна подходить под маску `secrets.ref`.

## Сторонние контракты

Пространство `cyborg.*` закреплено за этим пакетом. Автор контракта `acme.*` публикует свой пакет объявлений и дополняет карту, ничего здесь не меняя:

```ts
// @acme/contracts/index.ts
declare module '@cyborg/contracts' {
  interface Contracts {
    'acme.clock': { 1: Clock };
  }
}

export interface Clock {
  now(): Promise<number>;
}
```

После импорта этого пакета `ctx.contracts.get('acme.clock', 1)` возвращает `Remote<Clock>`.

## Что проверяет компилятор, а что ядро

| Проверка | Кто | Когда |
|---|---|---|
| Имя контракта есть в карте | компилятор | сборка плагина |
| Версия в `provide` — `мажорная.минорная`, мажорная есть в карте, реализация подходит под её тип | компилятор | сборка плагина |
| Мажорная версия в `get` и `all` указана и есть в карте | компилятор | сборка плагина |
| Контракт объявлен в манифесте: `provides` у поставщика, `requires`, `optional` или `consumes` у потребителя | ядро | вызов |
| Версия в `provide` объявлена в `provides` | ядро | вызов |
| Мажорная версия в `get` и `all` лежит в диапазоне манифеста (`^1` не даёт мажорную версию 2) | ядро | вызов, иначе `NotDeclared` |
| Реализация — объект, имена его методов | ядро | `provide` |
| Сигнатуры методов | никто | рантайм их не видит; это обещание поставщика, закреплённое типом |

Компилятор защищает от опечаток автора, ядро — от плагина, который собран без типов или нарочно их обходит. Компиляторные проверки закреплены в `core/test/contracts-types.ts`: каждая строка под `@ts-expect-error` обязана не компилироваться.

## Remote

Потребитель получает `Remote<T>`, а не `T`: каждый метод возвращает `Promise`, даже если в типе объявлен синхронным. Поле данных приходит снимком на момент `provide`.

```ts
interface Clock { nowSync(): number }
const clock = ctx.contracts.get('demo.clock', 1);   // Remote<Clock> | undefined
const n = await clock?.nowSync();                    // number | undefined, только через await
```

## Полный пример

Поставщик `files` отдаёт две мажорные версии, `editor` берёт вторую, `projects` — первую. Вкладки собирает `tabs`. Код — `core/examples/plugins/*`, прогон — `npm run demo -- all`.

**Поставщик двух версий.**

```jsonc
// files/manifest.json
{ "id": "files", "version": "2.0.0", "engines": { "cyborg": "^1" },
  "provides": { "cyborg.files": ["1.4", "2.0"] } }
```

```ts
ctx.contracts.provide('cyborg.files', '1.4', {
  read: async (path: string) => disk.get(path),
  list: async () => [...disk.keys()],
});
ctx.contracts.provide('cyborg.files', '2.0', {
  readText: async (path: string) => {
    const text = disk.get(path);
    return text === undefined ? undefined : { path, text, size: text.length };
  },
});
```

**Потребитель второй версии — он же поставщик вкладки.**

```jsonc
// editor/manifest.json
{ "id": "editor", "version": "1.0.0", "engines": { "cyborg": "^1" },
  "provides": { "cyborg.tab": "1.0" }, "requires": { "cyborg.files": "^2" } }
```

```ts
const files = ctx.contracts.get('cyborg.files', 2);           // Remote<FilesV2> | undefined
if (!files) throw new Error('cyborg.files в requires, но его нет');
ctx.contracts.provide('cyborg.tab', '1.0', {
  kind: 'редактор',
  open: async (path: string) => {
    const file = await files.readText(path);                  // FileText | undefined
    return file ? `редактор: ${path}, ${file.size} симв.` : `редактор: ${path} не найден`;
  },
});
```

**Потребитель всех поставщиков и команда с аргументами.**

```jsonc
// tabs/manifest.json
{ "id": "tabs", "version": "1.0.0", "engines": { "cyborg": "^1" },
  "consumes": { "cyborg.tab": "^1" },
  "commands": { "tabs.open": { "args": ["string"] } } }
```

```ts
const kinds = () => ctx.contracts.all('cyborg.tab', 1)
  .map((p) => `${p.impl.icon ?? ''}${p.impl.kind} (${p.pluginId}@${p.version})`);
ctx.contracts.onChange('cyborg.tab', () => ctx.log(kinds().join(', ')));

ctx.commands.register('tabs.open', async (path) => {          // path: unknown
  if (typeof path !== 'string') throw new Error('путь не строка');
  return Promise.all(ctx.contracts.all('cyborg.tab', 1).map((p) => p.impl.open(path)));
});
```

Ядро сверяет аргументы `tabs.open` со схемой манифеста до вызова обработчика, откуда бы ни пришла команда. Проверка `typeof` в обработчике остаётся: тип параметра — `unknown`, и компилятор без неё не даст передать `path` дальше.

## Схема аргументов команд

`commands` в манифесте — список имён (команды без аргументов) или объект со схемой:

```jsonc
"commands": {
  "pin-lock.lock": {},
  "pin-lock.unlock": { "args": ["string"] },
  "acme.log": { "args": ["string", "number?"] },
  "acme.trace": { "args": ["string"], "rest": "any" }
}
```

| Вид | Значение |
|---|---|
| `string`, `boolean` | значение этого типа |
| `number` | конечное число, не `NaN` |
| `array`, `strings` | массив; массив строк |
| `record` | объект, не массив и не `null` |
| `any` | что угодно, кроме `undefined` |

Суффикс `?` — необязательный аргумент, только в хвосте списка. `rest` — вид всех аргументов после перечисленных; вместе с необязательными не разрешён. Ошибка схемы — отказ манифесту при загрузке; несовпадение аргументов при вызове — `Invalid` с номером аргумента.
