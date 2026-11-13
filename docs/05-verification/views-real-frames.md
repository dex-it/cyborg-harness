# Виды на настоящем Electron: проверочные попытки и привязка плагина к кадру

Результат задачи TR-31 ([#248](https://github.com/dex-it/cyborg-harness/issues/248), этап В1 стека [#243](https://github.com/dex-it/cyborg-harness/issues/243)), 2026-11-13. Исследование: [план, TR-31](../research/trust-and-isolation/06-work-plan.md#62-задачи), [5.8 (виды)](../research/trust-and-isolation/05-decision.md), [вопросы 7.2, п. 7 и 8](../research/trust-and-isolation/07-open-questions.md#72-что-не-проверено), [приложение А, п. 15](../research/trust-and-isolation/08-sources-and-measurements.md). Нормы: [FR-CH-3013](../03-requirements/03-security-trust/srs.md#fr-ch-3013-группа-рендера), [FR-CH-3014](../03-requirements/03-security-trust/srs.md#fr-ch-3014-вид-не-получает-больше-своего), [ST-3005/8 и /9](../03-requirements/03-security-trust/stories/ST-3005-view-isolation.md). Угроза [У-19](../04-architecture/design/threat-model.md).

## Что проверялось и как

До задачи личность вида проверялась на подставных кадрах (`electron/test/view-frames.test.ts`), в окне её касался только дымовой тест. Теперь `playground/test/real/views-real-frames.test.ts` (`npm run test:views`; шаг CI на macOS и Linux) поднимает собранный playground и «атакует» из документа вида через DevTools Protocol: код выполняется внутри кадра alice (группа `duo` вместе с bob) или echo (своя группа), результат читает тест. Виды, ядро, мост и CSP - настоящие.

## Результаты

| Попытка вида | До задачи | После (зафиксировано тестом) |
|---|---|---|
| `history.pushState` на путь соседа по группе (`/bob/`), затем `bob.hello` | кадр alice **становился bob**: команда bob проходила, собственная команда `alice.hello` отклонялась «не команда плагина bob» (У-19) | кадр остаётся alice: `bob.hello` - «не команда плагина alice», `alice.hello` выполняется (ST-3005/8) |
| `pushState` на плагин другой группы (`/echo/`) и на корень (`/`) | `/echo/` - «не вид плагина», корень - тоже | кадр остаётся alice: команда echo - «не команда плагина alice» |
| Вложенный `<iframe>` с адресом другой группы (`cyborg-plugin://echo/…`), соседа по группе, `https://example.org/`, `data:` | заблокирован CSP (`frame-src` из `default-src 'none'`) | то же; нарушение `frame-src` отчитано; Chromium оставляет заблокированному кадру запрошенный адрес в `frame.url`, но документ в нём - страница ошибки `chrome-error://chromewebdata/`, origin `null`, моста и Node нет (ST-3005/9) |
| `<iframe srcdoc>` во виде | создаётся, наследует origin и CSP | то же; моста (`window.cyborgView`), `require` и `process` в нём нет; адреса вида у кадра нет, плагина у него нет |
| Уход самого фрейма: `location.href` на `cyborg-plugin://echo/…`, `https://…`, `data:` | отклонён `will-frame-navigate`, запись `denied`, `navigate` в журнале плагина | то же, зафиксировано: фрейм остался на `/alice/`, мост на месте |
| Обход моста: `require`, `process`, `module`, `Buffer`, `ipcRenderer`, `electron`, мост окна (`playground`), `window.parent.document`, `window.top.location`, DOM кадра соседней группы, `window.open` | недоступно (contextIsolation, sandbox, разные origin) | то же, зафиксировано: `SecurityError` на чужие документы, окон не появилось |
| `fetch` на `file:///etc/hosts`, `https://example.org/`, файл вида другой группы | блокирует CSP (`connect-src 'self'`) | то же |
| `fetch('/bob/ui/ui.js')` (файл соседа по группе) | 200 | 200: граница доверия - группа, сосед по группе читает код соседа; зафиксировано как **ожидаемо открытое** (SAD 3.8), закрывается только своей группой плагина (`plugins.uiGroups`) |

## Есть ли в Electron 45 стабильный идентификатор кадра

**Да: `WebFrameMain.frameTreeNodeId`.** Документация Electron 45.2.3: идентификатор «фиксирован при создании кадра, остаётся постоянным всю его жизнь, после удаления кадра не используется повторно», браузерный (один на все окна). Проверено на настоящем Electron: номер кадра alice не меняется ни от `pushState`, ни от перезагрузки документа (`f.src = f.src`), у видов разных групп номера разные (тест ST-3005/8). Есть ещё `frameToken` (строка, уникальна «в процессе рендера») и пара `processId` + `routingId` (в событиях `did-frame-navigate`); привязка идёт по `frameTreeNodeId`, потому что он не зависит от процесса рендера: при переходе кадра между процессами (смена группы окном) `routingId` меняется, а номер узла - нет.

**Привязка сделана** (`trackViewFrames`, `electron/src/view-frames.ts`, подключается в `guardNavigation`): по событию `did-frame-navigate` (фиксация документа; `pushState` его не вызывает - для него есть другое событие, `did-navigate-in-page`) главный процесс записывает плагина из адреса зафиксированного документа за номером кадра. `pluginOfFrame` берёт плагина из таблицы, а не из `frame.url`. Условия привязки: кадр вложен прямо в главный фрейм окна (виды создаёт документ окна; вложенный в вид кадр - не вид), origin кадра называет ту же группу, что адрес, и плагин состоит в этой группе. Кадр без привязки (about:blank, srcdoc, страница ошибки, документ окна, чужая страница) плагина не имеет. Таблица чистится по исчезнувшим кадрам и при закрытии окна.

## Что осталось и что не проверено

- Гонка при навигации: пока документ в кадре меняется, поздний IPC старого документа засчитывается новому плагину; оба в одной группе, а между группами `pluginOfFrame` ещё сверяет origin кадра с группой плагина. Воспроизвести не удалось (перезагрузка вида в тесте проходит без отказов моста).
- `?view=<имя>` в адресе по-прежнему читается из текущего `frame.url` (рассылка событий каналу вида, `views:visibility`): `pushState` на другое имя вида подменит адресата рассылки того же плагина. Привязка вида к кадру не делалась (в задаче - плагин).
- Внутри группы плагины читают DOM, мост и файлы друг друга (строка выше): задача TR-31 фиксирует границу, не сдвигает её.
- Не проверено: Electron 46+; `cyborg-plugin://` и site isolation для нестандартного сценария (вопрос 8 раздела 7.2: схема зарегистрирована как `standard`, процессы рендера у групп разные - числа в [spike-render-groups.md](spike-render-groups.md)); Windows.
- Linux: те же семь тестов проходят в контейнере (Debian 12 aarch64, Xvfb, Electron 45.2.3 для Linux arm64, ядро 7.2.12-orbstack, `--no-sandbox` под root): результаты совпадают со столбцом «После». Не проверялось: x64, Wayland, песочница Chromium (в контейнере она выключена).

## Повторить

```sh
npm run test:views            # macOS
xvfb-run --auto-servernum node --test playground/test/real/views-real-frames.test.ts   # Linux, после npm run build; в контейнере - с --no-sandbox через CI=1
```
