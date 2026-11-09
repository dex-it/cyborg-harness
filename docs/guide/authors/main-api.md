---
title: "Главная часть"
description: "PluginModule и PluginContext: что делает activate и что даёт ctx."
---

Главная часть - модуль, который хост загружает в свой процесс. Его `default`-экспорт - объект `PluginModule`; типы берутся из `@cyborg-harness/contracts`.

```ts
import type { PluginModule } from '@cyborg-harness/contracts';

const plugin: PluginModule = {
  config: { defaults: { greeting: 'привет' } },
  activate(ctx) {
    ctx.subscriptions.add(ctx.commands.register('acme.hello', () => 'привет'));
    return undefined;
  },
};

export default plugin;
```

## PluginModule

| Член | Что делает |
|---|---|
| `activate(ctx)` | Вызывается один раз, когда граф готов и разделы прошли проверку. Возвращает `Disposable`, `undefined` или промис с ними |
| `config`, `state` | Необязательные описания разделов: `defaults`, `migrate`, `validate`. Версию и схему объявляет манифест |

Время на `activate` ограничено десятью секундами по умолчанию. Если плагин не уложился или бросил исключение, в журнале появляется запись `failed` с причиной, а остальные плагины продолжают работать. Тот же срок действует при выгрузке.

Возвращённый из `activate` `Disposable` снимается при выгрузке вместе с `ctx.subscriptions`: сначала то, что добавлено позже. Ошибка одного снятия не мешает остальным.

## Что есть в ctx

| Член | Назначение |
|---|---|
| `pluginId` | Имя плагина из манифеста |
| `subscriptions` | `DisposableStore`: всё, что в него добавлено, снимается при выгрузке в обратном порядке |
| `commands` | `register(name, handler)` и `run(name, ...args)`; аргументы сверены со схемой манифеста |
| `contracts` | `provide`, `get`, `all`, `onChange` - [Контракты](/authors/contracts/) |
| `config`, `state` | Разделы плагина; есть, если объявлены в манифесте |
| `os` | Доступ к ОС по правам манифеста |
| `secrets` | `resolve(ref)` - значение секрета по ссылке |
| `documents` | Вкладки плагина в окне |
| `window`, `system` | События фокуса окна, питания и блокировки экрана |
| `log(message)` | Строка в журнале плагина; её видит вид плагина и вкладка «Сообщения» |

## Команды

Обработчик получает `unknown[]`: схема манифеста проверяет аргументы в рантайме, но тип для компилятора она не задаёт. Сузьте аргумент сами:

```ts
ctx.commands.register('acme.open', async (path) => {
  if (typeof path !== 'string') throw new Error('путь не строка');
  return path.length;
});
```

Результат команды - данные, которые переживают `structuredClone`. `ctx.commands.run` вызывает зарегистрированную команду по имени: свою или чужую, если её исполнитель открыл плагинам (`callers: "plugins"`, [Контракты и команды](/features/contracts/#кому-открыта-команда)); отказ приходит исключением с полем `code` (`CommandNotFound`, `Invalid`, `PermissionDenied`). `AbortSignal` последним аргументом (`ctx.commands.run('acme.search', query, signal)`) отменяет вызов: вызывающий получает `Cancelled`, обработчик команды получает сигнал последним аргументом на том же месте. Сигнал не входит в `args` манифеста и схемой не проверяется.

## Разделы config и state

`ctx.config` и `ctx.state` - объекты `PluginSection`:

| Член | Что делает |
|---|---|
| `result` | Итог загрузки: `ok`, `newer` (формат новее плагина), `migrate-error`, `invalid` |
| `get()` | Слитое значение: значения по умолчанию, слой пользователя, слой воркспейса |
| `set(layer, data)` | Записывает слой (у `config` это `user` или `workspace`) и возвращает слитое значение |
| `onChange(listener)` | Подписка на правку, в том числе файла извне |

Ядро приводит данные слоя к версии раздела вызовом `migrate(fromVersion, data)`, проверяет итог по схеме и `validate`. Бросок из `migrate` - отказ миграции; раздел не прошёл проверку - плагин не активируется, остальные работают. Рецепты - [Рецепты](/authors/recipes/).

## Доступ к ОС

`ctx.os.paths` (`data`, `temp`, `home`), `ctx.os.fs` (только свои каталоги без права), `ctx.os.secrets` и `ctx.os.dialog` есть всегда. Остальные члены появляются, только если право объявлено:

| Член | Право в манифесте | Что даёт |
|---|---|---|
| `fs` вне своих каталогов | `fs.read`, `fs.write` | Чтение, запись, `list`, `stat`, `readSlice`, `watch`, `mkdir`, `remove` |
| `process` | `process` | `run(program, args, options)` для перечисленных программ |
| `pty` | `pty` | `spawn`, `list`, `attach`; процесс держит ядро |
| `net` | `net` | `fetch` на перечисленные хосты |
| `env` | `env` | `get(name)` для перечисленных переменных |
| `notify` | `notify` | `show(title, body?, { onClick })` - уведомление с командой на клик, `close(id)` |
| `clipboard` | `clipboard` | Чтение и запись буфера по списку |
| `shell` | `shell` | `openPath`, `openExternal`; исполняемый файл не открывается, а где плагин пишет сам - только документ |
| `serve` | `serve` | `http(handler)` - сервер на `127.0.0.1` для программ этого компьютера |
| `security` | `security.roots` | `setRoots(paths)` - корни проектов |
| `ui` | `ui.lock` | `lock()` - закрыть окно своим экраном |

Путь вне области - `PermissionDenied`, а не `NotFound`: наличие файла не раскрывается. Каждый отказ пишется в журнал как `denied`.

## Документы

`ctx.documents` - вкладки плагина, которые окно держит в порядке и, для типов с `restorable`, поднимает после перезапуска. `open(type, { title, data? })` возвращает id; `save(id, change)` вы вызываете сами при каждой смене данных, потому что опрашивать плагин после падения хоста некому; `list()` отдаёт документы прошлого запуска, `onClose` сообщает о закрытии вкладки человеком. Данные - JSON до 64 КБ, заголовок - до 200 символов.

## События окна и системы

`ctx.window.onFocusChange`, `ctx.system.onSuspend`, `onResume`, `onScreenLock`, `onIdle(seconds, listener)` (один раз на каждый простой, после активности срабатывает снова) и `onBeforeQuit` (ядро ждёт асинхронного слушателя не дольше бюджета приложения). Слушатель, бросивший исключение, пишет в журнал и не мешает соседям.

`ctx.window.setTitle(segment)` ставит фрагмент плагина в заголовок окна, права не нужно. Фрагмент до 80 символов, переводы строк и невидимые знаки ядро заменяет пробелом, `undefined` или пустая строка фрагмент снимает. Выгрузка плагина снимает его фрагмент.

## Дальше

- [Вид](/authors/view-api/) - вторая половина плагина.
- [Контракты](/authors/contracts/) - как плагины говорят друг с другом.
- [Права](/features/permissions/) - как работает шлюз.
- [Коды ошибок](/reference/errors/) - все значения `CoreErrorCode`.
