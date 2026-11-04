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
