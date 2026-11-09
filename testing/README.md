# @cyborg-harness/testing

Тест-кит автора плагина Cyborg Harness: поднимает ядро вместе с хостами в процессе теста, подставляет поддельные pty и секреты и даёт общий набор тестов контракта `cyborg.agent`. Электрон не нужен. Код ядра пакет не копирует: он строится на `@cyborg-harness/core` как на peer-зависимости.

Пакет приватный (`private: true`) и в реестр не опубликован: публикация - задача P-10. Пока он ставится из архива `npm pack` или как workspace этого репозитория. Версия пакета совпадает с версией ядра (`0.1.0`), peer указывает на ту же серию.

## Что внутри

| Имя | Что делает |
|---|---|
| `startKernel({ plugins, os, enabled, config, state, load })` | Собирает манифесты и точки входа, вызывает `load()` на хостах внутри процесса теста (`inlineHosts`). Возвращает ядро (`Kernel`) с `waitForJournal`, `dataDir`, `sandbox`, `pty`, `secrets` и снятием через `Symbol.asyncDispose` |
| `fakePty()` | Поддельный pty: тест видит запущенные процессы (`procs`), сам пишет вывод (`emit`) и завершает процесс (`exit`) |
| `memoryStore(initial?)` | Слои `config` и `state` в памяти (`LayerStore`), список записанных слоёв |
| `memorySecrets(available?)` | Хранилище секретов в памяти; `false` изображает систему без хранилища |
| `sandbox()` | Временный каталог после `realpath` (на macOS `tmpdir()` - симлинк), снимается через `await using` |
| `agentContractSuite(provider, options?)` | Общий набор тестов поставщика `cyborg.agent`; вызывается на верхнем уровне тестового файла |
| `checkAgentContract(provider, options?)` | Те же проверки одной функцией: бросает на первой неудачной |
| `secretSourceContractSuite`, `projectSettingsContractSuite` | Каркасы наборов для `cyborg.secret-source` и `cyborg.project-settings`; проверки помечены `todo`, пока контракты не объявлены в `@cyborg-harness/contracts` |

`plugins` принимает каталог плагина (в нём `manifest.json` и `index.mjs`, `index.js` или `index.ts`) или плагин из кода теста: `{ manifest, module }`.

Среда по умолчанию: `dataDir`, `tempDir` и `home` внутри песочницы, `env` с `PATH` и `HOME`, `fakePty()` и `memorySecrets()`. Поле `os`, которое тест передал, заменяет умолчание целиком.

## Пример

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startKernel } from '@cyborg-harness/testing';

test('плагин отвечает на команду', async () => {
  await using kernel = await startKernel({
    plugins: [
      {
        manifest: { id: 'hello', version: '1.0.0', engines: { cyborg: '^1' }, commands: { 'hello.say': {} } },
        module: { activate: (ctx) => void ctx.commands.register('hello.say', () => 'hello') },
      },
    ],
  });
  await kernel.waitForJournal({ kind: 'activated', pluginId: 'hello' });
  assert.equal(await kernel.run('hello.say'), 'hello');
});
```

Тест запускается встроенным `node --test`: Node 24 снимает типы с `.ts` сам.

## Набор для поставщика агента

```ts
import { agentContractSuite } from '@cyborg-harness/testing';

agentContractSuite(new URL('../my-agent', import.meta.url).pathname, {
  // Среда, где находится программа агента: PATH с подставным исполняемым файлом, SHELL.
  os: (box) => ({ home: box.root, env: { PATH: '/usr/bin:/bin', HOME: box.root } }),
});
```

Набор поднимает ядро, поставщика и потребителя (с правом `pty`, равным `launch` поставщика) и проверяет: факты и их клонируемость, `launch` как данные, запуск через потребителя по его праву `pty`, код выхода 127 -> `notFound`, `history`, отсутствие записей `denied` и `failed` в журнале.

## Сборка и проверка

```sh
npm run build:testing                  # testing/dist: JS и .d.ts
cd testing && npm pack --dry-run       # состав архива
npm test                               # testing/test: пакет, набор, пустой проект из архивов
```

`build:testing` идёт сам вместе с `build:core` перед `build`, `typecheck`, `lint` и `test` (хуки `pre*` в корневом `package.json`).
