# Замеры для проверки SAD2

Скрипты, которыми получены числа [ресёрча-2](../../sad2-validation.md). Ничего не меняют в репозитории: пишут результаты в каталог `SPIKE_OUT` (по умолчанию эта папка, файлы `result-*.json` в `.gitignore`), страницы отдают из памяти.

| Файл | Что делает |
|---|---|
| `main-u2.js` | хосты `utilityProcess`: старт, физический след, круг, поток; проверка флагов прав Node через `utilityProcess` и через процесс Electron как Node; Hardened JS и библиотеки |
| `host.js` | хост для `utilityProcess`: эхо, приём и отдача потока по `MessagePort`, проба прав, загрузка `node-pty` |
| `host-node.js` | то же как обычный процесс Node с каналом IPC и пробой прав |
| `host-ses2.js` | `lockdown()`, `Compartment`, попытки выхода, набор библиотек |
| `main-f.js`, `pages.js`, `preload.js` | окно: `<iframe>` с origin на плагин (процессы и память), мост `MessagePort`, задержки, проверка изоляции кадра, проба перехвата клавиш |

## Запуск

Нужны Node 24, `npm ci` в корне репозитория (там Electron 45, `esbuild` и `node-pty`), macOS (память снимается командой `footprint`). `@xterm/xterm` для `main-f.js` в корне харнесса нет: поставить его рядом (`npm install --no-save @xterm/xterm` в корне) или указать `CYBORG_REPO` на checkout Cyborg, где он есть.

```sh
cd docs/research/spikes/sad2
npm install --ignore-scripts      # ses и библиотеки для проверки Compartment
sh build-libs.sh                  # собирает библиотеки в bundles/
export SPIKE_OUT=/tmp/sad2-spikes && mkdir -p $SPIKE_OUT
../../../../node_modules/.bin/electron main-u2.js
../../../../node_modules/.bin/electron main-f.js
```

Скрипты открывают скрытые окна; проба клавиш на секунду показывает окно в углу экрана. Переменная `CYBORG_REPO` задаёт корень репозитория, если папка перенесена.

## Что учесть при чтении чисел

- Память - `footprint` (физический след), не RSS.
- `performance.now()` в странице огрублён до 100 мкс, поэтому круги даны средним по 5000 повторов.
- Повторный запуск из этой папки дал числа в пределах нескольких процентов от первых (след терминалов в десяти кадрах 327 против 335 МБ).
- Проба клавиш использует синтетические события и не доказывает поведение настоящей клавиатуры.
