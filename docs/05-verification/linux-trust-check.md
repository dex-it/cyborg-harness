# Проверка мер доверия на Linux (этап А, TR-02 и TR-04)

Результат задачи [#246](https://github.com/dex-it/cyborg-harness/issues/246) по [исследованию доверия](../research/trust-and-isolation/README.md) ([#243](https://github.com/dex-it/cyborg-harness/issues/243)): что проверено автоматически на Linux и что остаётся человеку. Дата: 2026-11-13.

## Что проверяет CI (Ubuntu 24.04)

| Мера | Чем | Результат |
|---|---|---|
| TR-01: нарушитель на настоящем `utilityProcess` | шаг «доверие, нарушитель на настоящем utilityProcess (Linux)» (`xvfb-run`, `playground/test/real/trust-real-host.test.ts`) | зелёный в CI PR |
| TR-02: хост с явным `env` не падает на Linux | тот же шаг и `npm run smoke` на Ubuntu | зелёный в CI PR |
| TR-03: фильтры `init` и `contracts` | `core/test/host-minimum.test.ts` (в `npm test`) | зелёный в CI PR |
| TR-04: логика выбора backend | `electron/test/secrets-backend.test.ts`, `core/test/secrets-reason.test.ts` | зелёный в CI PR |
| TR-05: права файлов | `core/test/file-modes.test.ts`, `electron/test/file-modes.test.ts` | зелёный в CI PR |

## Не проверено: что должен сделать человек

Настоящий keyring в CI недоступен, на Linux локально агент этого не запускал. Нужна машина с Linux и рабочим столом (Ubuntu 24.04, GNOME; для второй проверки - KDE).

### TR-04. Хранилище секретов: keyring и `--password-store=basic`

Сборка: `npm ci && npm run build`.

1. **Есть GNOME Keyring (обычный сеанс рабочего стола).** Запустить из терминала сеанса:

   ```
   node_modules/.bin/electron . --user-data-dir=/tmp/cyborg-keyring-check 2>&1 | grep -E "хранилище секретов|plugins\] хост ядро"
   ```

   Ожидание: строки «хранилище секретов недоступно» **нет**; в плагине с секретами (`secrets.set`) значение сохраняется, в `/tmp/cyborg-keyring-check/secrets.json` лежит base64, не открытый текст.
2. **Нет хранилища паролей (`basic_text`).**

   ```
   node_modules/.bin/electron . --password-store=basic --user-data-dir=/tmp/cyborg-basic-check 2>&1 | grep -E "хранилище секретов"
   ```

   Ожидание: одна строка `[plugins] хост ядро [warn]: хранилище секретов недоступно: на этом компьютере нет хранилища паролей …`; вызов `ctx.os.secrets.set` в плагине получает `Unavailable` с той же причиной; файла `secrets.json` в `/tmp/cyborg-basic-check` нет или он пуст.
3. **KWallet** (KDE): то же, что п. 1, с `--password-store=kwallet6`.

Результат (дата, дистрибутив, версия Electron, вывод команд) дописать в эту таблицу:

| Проверка | Дистрибутив | Результат |
|---|---|---|
| п. 1, GNOME Keyring | не проверено | - |
| п. 2, `--password-store=basic` | не проверено | - |
| п. 3, KWallet | не проверено | - |

### TR-02. Окружение хоста на Wayland и X11

Явный `env` хоста содержит только `PATH` (`electron/README.md`). Проверить, что хосты стартуют и в сеансе Wayland:

```
ELECTRON_OZONE_PLATFORM_HINT=wayland node_modules/.bin/electron . --user-data-dir=/tmp/cyborg-wayland-check
```

Ожидание: окно открыто, в «Плагины Cyborg» плагины активны, записей `host-down` в журнале нет. Если хост без переменной не стартует, перечень `HOST_ENV_KEYS` (`electron/src/host-env.ts`) расширить на доказанную переменную и дописать её в `electron/README.md`.

| Проверка | Дистрибутив | Результат |
|---|---|---|
| Wayland | не проверено | - |
