---
level: research
feature: cyborg-harness
status: review
date: 2026-11-06
origin: derived
quality-checks: входных записей нет
---

> Инвентарь приложения Cyborg (репозиторий ai-cyborg, master) и карта переноса, 2026-11-06. Основа пилотов PL-01..PL-09 [эпика микроядра](../06-plans/epic-microkernel.md). Составлен чтением кода без запуска; числа проверены командами, непроверенное помечено. Ссылки на ADR-CH-0006, sad2.md и SRS миграции относятся к редакции пакета, которая не вошла в этот репозиторий.

# Cyborg (ai-cyborg, master) -> cyborg-harness: инвентарь, карта переноса, порядок миграции

Режим: только чтение. Приложение и npm не запускались, тесты не гонялись; все числа получены grep/wc/git по файлам. Что не проверено, помечено «не проверено».

## 0. Исходные данные и оговорки

- ai-cyborg: ветка master, HEAD `e112be0`. `git diff e4beb72 HEAD` по `src`, `test`, `scripts`, `package.json`, `package-lock.json`, `.github`, `CLAUDE.md`, `README.md` пуст: код master совпадает с `e4beb72`, на котором сверялся parity-plan. Значит числа parity-plan по коду проверяются прямо (раздел 5), а устарела в нём не цифра, а картина вокруг (документы, имена плагинов, решения SAD).
- Расхождение с вводной задачи: документы харнесса на master НЕ удалены. `git ls-tree HEAD docs/cyborg-harness` - 37 файлов, это первая редакция пакета (parity-plan там другой: «58 каналов все `handle`», «65 методов», «893 теста», ADR-CH-0006 strangler). Версия, которую вы назвали (`9fa78e5`), живёт только на `origin/worktree-docs-harness-architecture`. Читал её; копии лежат в scratchpad (`parity-plan.md`, `sad2.md`, `migration-srs.md`).
- Объём кода master: `src/main` 38 файлов / 7057 строк (без тестов; плюс 3 теста в `src/main` на 654 строки); `src/renderer` 45 .ts / 6828 строк + `styles.css` 2233 + `index.html` 253; `src/shared` 2 файла / 321; `scripts` 6 файлов / 1463; тесты `test/` 53 файла / 9825 строк. Всего в `src` 90 файлов, 17346 строк.
- Тесты: статический счёт вызовов `it(`/`test(`: 878 в `test/` + 30 в `src/main/*.test.ts` (git-filters 13, git 1, sessions 16) = 908. parity-plan называет 925 (893 + 32) - вероятно, итог запуска с циклами и параметризацией; запуском не подтверждено.
- cyborg-harness сейчас: `core/src` 6159 строк, `core/test` 5570 строк (211 тестов по grep), `playground` 35 тестов по grep (`playground/test`, `playground/src/main/*.test.ts`), в `playground/scripts/smoke.mjs` 56 строк с проверками; контрактов в `contracts/index.ts` 7 имён; базовых плагинов 6 (`sessions`, `agent-claude-code`, `agent-shell`, `session-isolation`, `next-actions`, `pin-lock`).

## 1. Инвентарь возможностей Cyborg

### 1.1. Сводка по пользовательским функциям

| # | Функция | main (строк) | renderer (строк) | Каналы IPC (всего 58) | Тестов (grep) |
|---|---|---|---|---|---|
| F1 | Сессия агента в pty, терминал xterm | sessions 268, claude-args 22, events-store 21, session-args 53, pid 9 (=373) | app.ts (часть), term-links 162, drop-path 62, render-ticket 18, theme 49 (=291 вне app.ts) | `session:create`, `session:input`(on), `session:resize`(on), `session:kill`(on) | session-args 11, sessions.test 16, term-links 15, drop-path 16, render-ticket 5 |
| F2 | Хуки Claude, статус «занята/ждёт» | в sessions.ts (`readEvents`) | `busy` на вкладке в app.ts | события `session:activity`, `session:cwd`, `session:waiting` | в sessions.test, session-args |
| F3 | Уведомления «ждёт» | notify-args 17, часть main.ts (стр. 339-379) | notify 40 | `session:notify`(on), `session:unnotify`(on), `notifications:state`(on) | notify-args 4, notify 5 |
| F4 | Кнопки-команды, подстановки, горячие клавиши кнопок, кнопки от модели, промпты запуска | commands 361, command-store 31, prompts 166, prompt-store 40, suggestions 78 (=676) | command-bar 223, command-editor 49, command-values 20, config-editor 106, prompt-editor 25 (=423) | `commands:load/save`, `prompts:load/save`, `config:reveal`; событие `session:suggest` | commands 40, commands-store 11, command-values 6, prompts 21, suggestions 14 |
| F5 | Изоляция сессий (промпт + EnterWorktree) | claude-args.ts (`ISOLATION_PROMPT`) | - | нет | косвенно в session-args/history (`claudeArgs`) |
| F6 | История сессий (продолжить, удалить) | history 160 | ago 13; список в app.ts (1078-1127) | `history:list`, `history:delete`, `session:resume` | history 7 |
| F7 | Проекты (диалог, выбор, репозитории) | projects 232, jira-keys 20 | sources 207; диалог проекта в app.ts (129-300) | `projects:load/save/problem`, `dialog:pickDir`, `project:selected`(on) | stores 26 (общие с трекерами) |
| F8 | Воркспейс (файл, замок, «Недавние», первый запуск, отдельный процесс на воркспейс) | workspaces 409, jsonfile 9, pid 9 | workspace-text 61, title 5, диалог в app.ts (303-398) | `workspace:info/create/open`, `dialog:pickWorkspaceDir`; событие `menu:create-workspace` | workspaces 55, workspace-text 9, title 5, launcher 4, menu 19 |
| F9 | Файлы и дерево сессии (git-статус, ветка, перетаскивание пути) | files 54, allowed-paths 136, open-path 40 | tree 268, tree-keys 78, roots 43, row-marks 34, neighbor 6, reorder 8, list-keys 58, tabs 58 | `fs:list`, `fs:files`, `path:open`, `url:open` | allowed-paths 18, file-list 2, tree 13, tree-keys 19, roots 7, neighbor 5, reorder 2, list-keys 6, tabs 7, drop-path 16 |
| F10 | Просмотрщик файла, JSON-редактор (Monaco) | - | viewer 164 (+ config-editor) | `fs:read`, `git:headContent` | отдельных нет (static-guards, smoke) |
| F11 | Git (root, branch, status, headContent, branches, switch, remotes, files) | git 232 | меню ветки в app.ts (1010-1060) | `git:root`, `git:branch`, `git:status`, `git:branches`, `git:switch`, `git:headContent` | git-filters 13, git 1, git-branch 1, git-head 1 |
| F12 | Поиск (файлы, текст, изменения) | git-search 281, search-run 19, search-args 15, shared/search-pattern 90 (=405) | search-dialog 350, search-model 101 (=451) | `search:text`, `search:changes`, (`fs:files`); событие `menu:search` | git-search 23, search-model 19 |
| F13 | Трекеры: задачи GitHub/GitLab (CLI gh, glab), MR/PR, Jira (CLI jira), карточка «Статус», старт сессии по задаче/MR/Jira, привязка к сессии | trackers 707, task-details 98, mrs 311, mrs-service 404, jira 302, jira-service 220 (=2042) | tasks 414, task-model 231, task-flow 181, task-header 46, panel 173, panel-return 20, mrs 263, mr-model 113, mr-refresh 38, status 437, status-model 134 (=2050) + sources 207 | `trackers:status`, `tasks:list/details/sessionDetails/open`, `jira:status/list/projects/suggest/details/open`, `mrs:list/open/details` (14) | trackers 69, mrs 73, jira 50, model 43, flow 27, task-details 14, tasks-view 19, status-model 23, cli-limits 4, panel-return 5 |
| F14 | «Расширения» Claude Code и хабы магазинов | extensions 401, -read 323, -act 105, -handlers 46, -usage 204, hubs 363, shared/extensions 231 (=1673) | extensions-dialog 611, extensions-model 469 (=1080) | `extensions:load/probe/act/usage`, `hubs:list/change/fetch` (7); событие `menu:extensions` | ext-act 14, ext-model 28, ext-read 17, ext-usage 16, extensions 10, hubs 17 |
| F15 | Оболочка: меню, заголовок, настройки (шрифт, колесо, уведомления), вкладки, делитель, диалоги, доступность | main 632, preload 101, menu 167 (=900) | app 1360, prefs 22, font-size 51, platform 28, ipc-error 5, dom 12, globals.d 12 (=1490) | события `menu:*`, `notifications:toggle`, `session:reveal` | font-size 11, prefs 4, platform 7, ipc-error 2, static-guards 4 |
| F16 | Сайт, корпус, CI | check-corpus.ts, corpus-lib.ts 428 (в `scripts`) | - | - | check-corpus 25 |

Сумма тестов по F1-F16 (panel-return один раз) = 908, то же, что общий grep.

### 1.2. Детали по функциям

#### F1. Сессия агента и терминал
- Запуск: `SessionManager.create` (`src/main/sessions.ts`) -> `node-pty` (`require` при первом запуске, `spawn` подставляется в тестах): `$SHELL -lc 'exec claude --settings "$CYBORG_SETTINGS" "$@"' cyborg <args>`; `name xterm-256color`, 120x40; env: `TERM`, `COLORTERM=truecolor`, `CYBORG_EVENTS`, `CYBORG_SETTINGS`; из окружения вычищены 10 переменных `CLAUDE*` (`PARENT_SESSION_VARS`) и `CYBORG_CWD`.
- Аргументы claude (`claude-args.ts`): `--resume <id>`, `--append-system-prompt ISOLATION+SUGGEST`, промпт, `--add-dir …` (промпт до `--add-dir`, так как тот вариадический).
- Вывод: `proc.onData -> emit('session:data')` -> `webContents.send` на каждый чанк, без пакетирования; в окне `Terminal.write`. Буфера в главном процессе нет.
- Ввод/размер/kill: каналы `on`; аргументы проверяет `session-args.ts` (id целое, ввод до 1 МиБ, размер 1..1000); вызовы pty в `try` (процесс мог завершиться между проверкой и вызовом).
- Данные: `userData/claude-hooks.json` (атомарно, общий для инстансов), `userData/sessions/<pid>-<id>.jsonl` (права 0700/0600; сироты убираются по живости pid).
- Окно: `Session` в `app.ts` - у сессии свои терминал, дерево, вкладки файлов, полоса кнопок; `task/mr/jira` только в памяти. Закрытие окна/выход/смена воркспейса спрашивают подтверждение (`confirmEndSessions`), `window-all-closed` -> `killAll`.
- Клавиши терминала (`createTerminal`, app.ts 621-659): Shift+Enter -> `\x1b\r`; на не-mac Ctrl+C/V через `navigator.clipboard`; Esc/Ctrl+C снимают «busy» (эвристика); ссылки в выводе (`term-links.ts`: путь -> `path:open`, URL -> `url:open`, OSC 8).
- Внешнее: `node-pty` (нативный, `postinstall: electron-rebuild -f -w node-pty`), `@xterm/xterm` 6, `@xterm/addon-fit`, CLI `claude`.
- Дефекты и риски: (1) `pendingData.set(id, [...(pendingData.get(id) ?? []), data])` (`app.ts:888-890`) - квадратичное копирование для сессии без вкладки; (2) id сессии - счётчик процесса (`nextId`), не устойчив между запусками; (3) нет буфера вывода: перезагрузка окна теряет терминал (поэтому «перезагрузка страницы» убрана из меню); (4) список `PARENT_SESSION_VARS` ведётся руками; (5) ввод идёт `ipcRenderer.send` на каждое нажатие.

#### F2. Хуки и статус
- Хуки `SessionStart, UserPromptSubmit, PostToolUse (matcher *), Stop, Notification` пишут JSON в файл событий командой `{ cat; echo; } >> "$CYBORG_EVENTS"`. `fs.watch` + `setImmediate`-перечитывание (комментарий: kqueue на macOS), чтение до последнего `\n` (хук может дописывать строку).
- События окну: `session:cwd` (смена cwd -> дерево идёт за worktree), `session:activity` (UserPromptSubmit/PostToolUse -> «busy» на вкладке, обновление дерева через 250 мс), `session:waiting` (причины по белому списку `permission_prompt`, `elicitation_*`, `agent_needs_input`, `quota_auto_resume_*`; `Stop` без фоновых задач -> «Ход завершён, ждёт ответа» с задержкой 30 с `stopDelayMs`, любое событие её сбрасывает), `session:suggest`.
- Текст уведомления зависит только от типа события, не от ответа claude (D-07).

#### F3. Уведомления
- Решение «показывать ли» принимает окно (`WaitNotifier`, `renderer/notify.ts`): включено, сессия не активна или окно не в фокусе; выключатель `cyborg.notifications` в localStorage, меню отражает (`notifications:state`).
- Главный процесс (`main.ts` 339-379): `Notification`, клик -> показать окно + `session:reveal`; `shownNotifications` держит ссылки против GC.

#### F4. Кнопки-команды и промпты
- Три слоя: встроенные (`DEFAULT_COMMANDS`) -> общий `userData/commands.json` -> поле `commands` файла воркспейса; подстановки `{branch}`, `{pr}`, `{task}`; сочетания Alt+, Cmd/Ctrl+Shift+, F1-F12. `parseHotkey` отвергает Ctrl+буква без Shift (занято терминалом) и сочетания из списка занятых `RESERVED_MAC/OTHER` (`commands.ts:79-80`).
- Обработка клавиш: `CommandBars.handleKey` вызывается из `window.addEventListener('keydown', …, true)` (`app.ts:1255`); условия: не `repeat`, не в `INPUT/TEXTAREA/SELECT/contentEditable` (кроме `xterm-helper-textarea`), нет открытого `<dialog>`, сессия видима.
- «Кнопки от модели»: `suggestions.ts` (`SUGGEST_PROMPT` + `parseSuggestions` разбирает хвост `last_assistant_message` на событии `Stop`), событие `session:suggest`; снимаются на `UserPromptSubmit`, на `PostToolUse` и на «ждёт».
- Промпты `userData/prompts.json` (шаблоны `mr.review/rework/ci`, `task.start`, `jira.start`): читают `session:create`, `trackers`, `jira`, `mrs` - поэтому `trackers -> prompts -> commands`.
- Редакторы: Monaco-диалог (`config-editor.ts`), проверка сохранения в главном процессе, `confirm('Закрыть без сохранения?')`. Правка файлов снаружи подхватывается по `window focus` (`reloadCommands`).
- Дефект D-27: `RESERVED_MAC/OTHER` не содержат акселераторов меню (`Cmd+P`/`Ctrl+Shift+P`, `CmdOrCtrl+Shift+F/D/X`) - кнопка с таким сочетанием молча не сработает; список ведётся руками. Подтверждено на master (`menu.ts` 136-159 против `commands.ts:79-80`). `Cmd/Ctrl+Shift+N` и `Cmd+0` в списке есть.

#### F5. Изоляция
- Одна константа `ISOLATION_PROMPT` в `claude-args.ts`, дописывается в `--append-system-prompt`; поведение на стороне claude (EnterWorktree). В harness уже есть как плагин `session-isolation` (`playground/plugins/session-isolation/index.ts`, текст взят из `claude-args.ts`, контракт `cyborg.session-prompt`).

#### F6. История
- `history.ts`: чтение `~/.claude/projects/<cwd с не-буквенно-цифровыми -> '-'>/*.jsonl` (голова и хвост журнала для заголовка), `deleteHistory` = `fs.rmSync` каталога и `<id>.jsonl` (запись в чужой каталог), `historyExists` перед `--resume`. В harness: `playground/plugins/agent-claude-code/history.ts` (83 строки) - чтение есть, удаления нет.

#### F7-F8. Проекты и воркспейс
- Файл воркспейса `{projects:[{id,name,description,repos,trackers:{github,gitlab},jira?}], lastProjectId, commands?}`; `ProjectStore.load/save` (`projects.ts:114-232`): повреждённый файл -> копия `<файл>.corrupt-<UTC>` (`keepCopy`), `unreadable` блокирует `save`; **`save` пишет `{...state, ...own}`, где `own` - только `OWN_FIELDS = ['commands']`**, то есть любое неизвестное поле верхнего уровня при сохранении проектов теряется (шаг 0 из SRS миграции не сделан).
- `workspaces.ts` (409): `--workspace=`, `CYBORG_CWD` (относительные пути от каталога запуска лаунчера `./cyborg`), замок `<файл>.lock` с pid (`tryLock`, забор замка умершего процесса переименованием), `recent-workspaces.json` (до 10), старый `userData/projects.json` как воркспейс (`legacy`), окно первого запуска (`createWorkspaceFile` с `flag: 'wx'`), `replaceWorkspace` (в том же окне, с завершением сессий) и `launchInstance` (отдельный detached-процесс `--user-data-dir=<тот же userData> --workspace=<файл>`).
- Сессия Chromium на воркспейс: `userData/workspaces/<хеш>/` (`sessionDirOf`), legacy - `defaultSession`; в ней живёт localStorage.
- Связи: `workspaces.ts -> trackers.validateProjectsState`; `projects.ts -> jira-keys`; `saveProjectsState` вызывает `trackers.resetAuth()` при смене источников.
- Защита: `workspace:open` принимает путь только если главный процесс сам предложил его ответом `exists` (`offeredWorkspace`).

#### F9. Файлы и дерево
- `fs:list`, `fs:files`, `fs:read` проходят `AllowedPaths` (`allowed-paths.ts`): корни = репозитории проектов + `liveDirs` сессий (`dirs` запуска и текущий cwd) + `grant` (диалог выбора). Проверка строковая (`isInside` по сегментам), `realpath` только запасной путь для `/tmp` и `/private/tmp`; `root(dir)` после `git rev-parse` дополнительно выдаёт корень репозитория cwd живой сессии.
- Дерево (`tree.ts`): WAI-ARIA tree, ленивая подгрузка каталога, статус git раз в 3 с (`setInterval` в `app.ts`, пропуск при `document.hidden`; опрос, не ответивший 30 с (`POLL_STALE_MS`), считается зависшим), перерисовка на `session:activity` через 250 мс.
- Перетаскивание пути в терминал (`drop-path.ts`): MIME `application/x-cyborg-path`, файлы ОС через `webUtils.getPathForFile` (preload `pathForFile`), `shellQuote`, `paste` в xterm.
- Открытие ссылок/путей из вывода: `open-path.ts` (`openablePath` - абсолютный или `~`, существует, не исполняемый по списку расширений; `webUrl` - только http/https).

#### F10. Просмотрщик
- `viewer.ts`: Monaco 0.57 из `node_modules/monaco-editor/min/vs` (копируется в `dist/renderer/vs`, свой AMD-загрузчик, воркеры без бандла), тема и размер шрифта синхронизируются с xterm; режим diff с `git:headContent` (`createDiffEditor`); чтение `readTextFile` до 5 МиБ.

#### F11. Git
- `git.ts`: `execFile('git', [...SAFE_CONFIG, '-C', cwd, …])`, `SAFE_CONFIG = core.fsmonitor=false, core.hooksPath=/dev/null`; `filterOverrides` рекурсивно по подмодулям отключает `filter.*.{clean,smudge,process,required}` через `GIT_CONFIG_COUNT/KEY/VALUE` (13 тестов в `git-filters.test.ts`); `gitStatus --porcelain=v1 -z --untracked-files=all`; `gitHeadContent` через `cat-file blob` (без textconv); `gitSwitch` - единственная изменяющая команда; `gitRemotes`, `gitFiles` (`ls-files -z --cached --others --exclude-standard`).
- `git:branches` и `git:switch` ограничены репозиториями сохранённых проектов (`projectRepo`, `main.ts:407`); `git:switch` отказывает, если `sessions.uses(root)`.

#### F12. Поиск
- `gitGrep`, `gitDiffSearch` (тайм-аут 15 с, вывод до 16 МиБ, `MAX_HITS`), `SearchRunner` (новый запрос того же вида отменяет прежний через `AbortController`, ответ `cancelled`), `search-args.ts` проверяет форму; `shared/search-pattern.ts` общий для main и renderer. Окно поиска - `search-dialog.ts` (3 режима; ключи `cyborg.search.mode` и `cyborg.search.<флаг>` в localStorage).

#### F13. Трекеры
- Все обращения - CLI через `createCliRunner(userData)` (`execFile`, тайм-аут 120 с, буфер 64 МиБ; `cwd` вне репозиториев): `gh api …`, `glab api …`, `jira …`; токенов Cyborg не хранит (NFR-1001). Источник определяется по `git remote -v` (`parseRemote/classifyRemote`, хосты GitLab). Кэш входа общий на все выборки (`warmAuth` при старте, `resetAuth` при смене источников). MR: пул `MR_CONCURRENCY = 6`, `MAX_DETAILED = 200`, `createLimiter/runLimited`.
- Привязка задачи/MR/Jira к сессии: поля `s.task/s.mr/s.jira` объекта `Session` в `app.ts`, только в памяти (FR-1015, закреплено `static-guards`).
- Старт сессии: `session:create(cwd, addDirs, start)`, `start` = `{task}` | `{mr, intent}` | `{jira}`; главный процесс строит промпт из `prompts.json` (`validateSessionStart`).
- Данные: `trackers.json` (прежний общий, только чтение, подставляется проектам без поля), настройки - в проекте (`trackers`, `jira`).
- Окно: панель задач/MR (`panel.ts` + `tasks.ts` + `mrs.ts`), карточка «Статус» (`status.ts`), раздел «Источники задач» в диалоге проекта (`sources.ts`); localStorage: `cyborg.tasks.assigned/sort`, `cyborg.mrs.filter/sort`, семейство `cyborg.tasks.labels:<id>`.
- Замер: `scripts/measure.mjs` (115 строк).
- Дефект: `measure.mjs` по умолчанию берёт проект «Upcore» (`argv[2] || 'Upcore'`), читает `userData/projects.json` и `trackers.json` (прежний путь), а не файл воркспейса; замеряет только загрузку панели задач и MR, старт окна и память не замеряет.

#### F14. Расширения
- Чтение `~/.claude/*`, `.mcp.json` репозиториев, плагинов и магазинов; `claude plugin list/marketplace list --json`, установка/удаление `claude plugin …` (флаги `--accept-command`/`-y` не передаются); `probeMcp` (`claude mcp list`) только по кнопке; хабы - JSON по https, встроенные `anthropic`, `dex-it`, `github-top`, `github-topic` (запрос к GitHub по теме), `hubs.json`; `extensions-usage.json` - кэш статистики вызовов по журналам сессий. Значения `env`, `headers`, аргументы MCP не покидают `extensions-read.ts`.
- Права по сути: `process` (`$SHELL -lc claude …`), `fs.read` (`~/.claude`, репозитории), `net` (https к хабам, api.github.com), запись только в userData.

#### F15. Оболочка
- `main.ts` (632): композиционный корень и обработчик всех 58 каналов; импортирует 26 модулей. `menu.ts`: шаблон меню (Файл/Воркспейс, Правка, Поиск, Расширения, Окно, Вид), 5 акселераторов: `CmdOrCtrl+Q`, `Cmd+P`/`Ctrl+Shift+P`, `CmdOrCtrl+Shift+F`, `CmdOrCtrl+Shift+D`, `CmdOrCtrl+Shift+X`.
- Слушатель окна (`app.ts:1254-1272`): `Cmd/Ctrl+Shift+N` (новая сессия), `Cmd/Ctrl+0` (размер шрифта), колесо с Cmd/Ctrl (`WheelStepper`, `wheel` в capture); этих сочетаний нет в меню.
- Синхронные `alert/confirm`: 11 вызовов (`app.ts` строки 166, 240, 280, 379, 675, 819, 1093, 1097, 1104, 1358 - это 10; `config-editor.ts:41`).
- Доступность: `tabs.ts`, `list-keys.ts`, `tree-keys.ts`, ARIA-роли; 6 `<dialog>` с `aria-labelledby` (static-guards).
- Безопасность окна: `contextIsolation`, `sandbox`, `nodeIntegration:false`, `setWindowOpenHandler deny`, `will-navigate` отменён; в renderer 0 импортов `electron`.

#### F16. Корпус, CI, сайт
- `docs/`: 147 файлов вне `docs/cyborg-harness`; BRD + 14 фич (153 требования FR/NFR - подсчёт заголовков `### FR-`/`### NFR-` в `docs/01-product/*/srs.md`), ADR-0001..0018, `verification-matrix.md` (генерируется `npm run corpus:matrix`: 137 с автотестом, 34 из них со smoke, 8 только smoke, 2 ручные, 6 осмотр).
- `.github/workflows/ci.yml`: матрица macOS+Ubuntu: `npm ci` (с `electron-rebuild` для node-pty) -> build -> typecheck -> test -> smoke (macOS: `node scripts/smoke.mjs`; Linux: `xvfb-run … --no-sandbox`); отдельная задача `corpus` (`npm run check:corpus`), агрегатор `CI`. `docs-site.yml` (Astro+Starlight, `site/` 103 файла, GitHub Pages), `dependabot.yml` (actions и site).
- Зависимости рантайма: 4 (`@xterm/xterm`, `@xterm/addon-fit`, `monaco-editor`, `node-pty`); dev: electron 45, esbuild, typescript 7, @electron/rebuild, @types/node.

### 1.3. Каналы IPC и события (проверено по `main.ts`/`preload.ts`)

58 каналов: 51 `ipcMain.handle` + 7 `ipcMain.on` (`session:input`, `session:resize`, `session:kill`, `session:notify`, `session:unnotify`, `notifications:state`, `project:selected`). Все в `src/main/main.ts` (в других файлах `ipcMain` нет). Список каналов `main.ts` и таблицы parity-plan 4.2 совпадают построчно (diff по отсортированным именам пуст). `window.cyborg` = 61 член: 58 методов-каналов + `pathForFile` + `on` + `platform`.

События окну (14 имён): `session:data`, `session:exit`, `session:cwd`, `session:activity`, `session:waiting`, `session:suggest` (шесть эмитит `SessionManager.emit`), `session:reveal`, `notifications:toggle`, и шесть `menu:*` (`menu:create-workspace`, `menu:project` с аргументом `new`/`edit`, `menu:commands`, `menu:prompts`, `menu:search`, `menu:extensions`).

### 1.4. Данные на диске и в окне

| Файл / ключ | Кто пишет | Кто читает | Заметка |
|---|---|---|---|
| файл воркспейса `*.cyborg.json` (`projects`, `lastProjectId`, `commands`) | `ProjectStore.save/saveCommands` | projects, command-bar, main | `save` теряет неизвестные верхние поля (F7) |
| `<файл>.lock` | `tryLock` (`wx`), `releaseLock` | `isWorkspaceBusy` | pid владельца |
| `<файл>.corrupt-<UTC>[-n]` | `keepCopy` (`wx`) | пользователь | копия байт повреждённого файла |
| `userData/recent-workspaces.json` | все инстансы, без блокировки | меню | до 10 |
| `userData/projects.json` | прежний путь | как воркспейс (legacy) | `LEGACY_FILE` |
| `userData/trackers.json` | не пишется | `TrackerSettingsStore` | подстановка проектам без поля |
| `userData/commands.json`, `prompts.json` | `CommandStore`, `PromptStore` | редакторы | общие для всех воркспейсов |
| `userData/hubs.json`, `extensions-usage.json` | `HubStore`, `UsageStore` | окно «Расширения» | |
| `userData/claude-hooks.json` | каждый запуск (`writeJsonAtomic`) | claude (`--settings`) | общий файл, поэтому атомарно |
| `userData/sessions/<pid>-<id>.jsonl` | claude-хуки | `SessionManager` | сироты по pid |
| `userData/workspaces/<хеш>/` | Chromium | окно | сессия + localStorage |
| `~/.claude/projects/…` | claude | history, extensions-usage | пишет Cyborg только `deleteHistory` |
| localStorage: `cyborg.fontSize`, `cyborg.notifications`, `cyborg.tasks.assigned`, `cyborg.tasks.sort`, `cyborg.mrs.filter`, `cyborg.mrs.sort`, `cyborg.search.mode`, `cyborg.extensions.tab/view/size` (10) + семейства `cyborg.extensions.<флаг>`, `cyborg.search.<флаг>`, `cyborg.tasks.labels:<id>` | окно через `prefs.ts` | окно | закрытый список проверяет `static-guards` |

---

## 2. Куда ложится в целевую архитектуру; что есть, чего не хватает

### 2.0. Что уже есть в cyborg-harness (по коду и роадмапу)

Ядро (`core/src`): воркспейс с замком и «Недавними» (один экземпляр - один воркспейс - одно окно, `requestSingleInstanceLock`), загрузчик/граф/ленивая активация/безопасный режим, хосты `utilityProcess` со сторожем, `config/state` по разделам со схемой и `migrate`, реестр контрактов (`provides/requires/optional/consumes`, `guard` via-contract), шлюз `ctx.os` (`fs.read/write/watch/readSlice`, `process`, `pty`, `net`, `shell`, `clipboard`, `notify`, `env`, `secrets`, `dialog`, `serve`, `ui.lock`, `security.setRoots`), pty в главном процессе (`persist`, `list`, `attach`, билет `share`, хвост 256 К символов; вывод зрителям идёт через главный процесс, `MessagePort` пока не используется), виды в `<iframe>` с origin `cyborg-plugin://<id>/`, токены темы, элементы `cy-*`, слой окна (`ask`, `menu`), документы (`restorable`), статические сочетания с переназначением и конфликтами, события окна/системы, замок экрана.

Плагины стенда: `sessions` (index 190 + mcp 116 + ui 170: кнопки по агентам, терминал последней сессии, восстановление документов, MCP-сервер для `suggest_actions`), `agent-claude-code` (222 + history 83: хуки, `watch` по файлу событий, `waitAfterStop` 30 с, `ended` с 127 -> `notFound`, `history`), `agent-shell`, `session-isolation`, `next-actions`, `pin-lock`. Контракты: `cyborg.agent`, `cyborg.agent-tool`, `cyborg.session-prompt`, `cyborg.lock`, демо `cyborg.files/projects/tab`.

**Чего в harness нет:** контрактов `cyborg.sessions`, `cyborg.git`, `cyborg.tree-decoration`, `cyborg.project-settings`, `cyborg.editor`; `cyborg.projects` есть только демо (`list/current`); плагинов `projects`, `files`, `viewer`, `git`, `search`, `trackers`, `command-buttons`, `claude-extensions`, `session-notifications`; Monaco в зависимостях; полосы сессий, групп вкладок, боковой панели; `ctx.keys.register`; `contributes.menus`; `ctx.window.setTitle/focus`; клика по `notify`; отмены запросов; рода области и `order` вида.

### 2.1. Требования к ядру со стороны Cyborg (без них функцию нельзя вынести в плагин)

| № | Требование | Кому нужно | Состояние в harness |
|---|---|---|---|
| r1 | Горячий путь терминала: пакетирование/backpressure вывода, без квадратичных буферов, предел ввода 1 МиБ, размер 1..1000, защита вызова pty от «мёртвого» процесса | F1 | вывод и хвост есть; размер 1..1000 есть (`playground/src/main/view-terminals.ts:15`); **предела ввода нет** (`write` проверяет только `typeof string`); пакетирование не обнаружено (не проверено глубоко); бюджеты не измерены (SAD вопрос 9) |
| r2 | pty-хост отдельным процессом; льготное время сироты | F1 | не начато (роадмап, остаток этапа 1) |
| r3 | Устойчивый id сессии, переживающий перезапуск | F1, F6, F13 | есть (`sessionId` строка, документы `restorable`) |
| r4 | Окружение pty: `COLORTERM=truecolor`, чистка `CLAUDE*` | F1 | чистка есть неявно (белый список `BASE_ENV`, `core/src/os-gateway.ts:106`); `COLORTERM` в `BASE_ENV` нет, `agent-claude-code` его не задаёт - **расхождение с Cyborg, влияние на claude не проверено** |
| r5 | События окна/фокуса для решения «показывать ли уведомление» | F3 | `ctx.window.onFocusChange` есть |
| r6 | Клик по системному уведомлению -> фокус окна + команда плагину; закрытие уведомления из плагина (`unnotify`) | F3 | `ctx.os.notify.show(title, body)` без клика и без закрытия - **нет** |
| r7 | Заголовок окна «Воркспейс - Проект - Cyborg vX» от плагинов | F8, F15 | `ctx.window` содержит только `onFocusChange` - **нет** |
| r8 | Динамические сочетания с условиями (`ctx.keys.register({key, command, when})`): не при `repeat`, не в поле ввода (кроме терминала), не при открытом диалоге, только для видимой сессии; общий реестр с акселераторами меню (закрывает D-27) | F4 | статические из манифеста + переназначение есть; **динамических нет** (SAD 3.9 «Ещё нет») |
| r9 | Вклады плагинов в меню (`contributes.menus`) с `enabled/checked` из состояния плагина: «Свойства проекта», «Поиск», «Расширения», переключатель уведомлений, «Воркспейс» | F7, F12, F14, F15 | **нет** (вопрос 15 SAD) |
| r10 | Сочетания окна без команды: `Cmd/Ctrl+0`, колесо с Cmd/Ctrl, `Cmd/Ctrl+Shift+N` при фокусе во фрейме | F4, F15 | `before-input-event` на Linux подтверждён, на macOS - нет; колесо с модификатором во фрейме - не рассмотрено |
| r11 | Модальные диалоги плагина с формой (проект, воркспейс, поиск, «Расширения», редакторы) | F7, F8, F12, F14 | слой окна умеет `ask` и `menu`; **модального окна плагина нет** (документы - вкладки); обход документом-вкладкой меняет UX |
| r12 | Асинхронные подтверждения вместо `alert/confirm` (11 вызовов) | F1, F7, F9, F15 | `ask` есть; миграция вызовов - работа плагинов |
| r13 | Раскладка: полоса сессий, боковая панель «Файлы/Сессии», панель инструментов основной области («Статус», «Задачи», «MR/PR», «Новая сессия»), полоса кнопок под терминалом, выезжающая панель задач; `kind` и `order` вида | F4, F13, F15 | **не начато** (роадмап: «род области и `order` вида») |
| r14 | Отмена запроса (идентификатор и сообщение отмены) для поиска и пулов MR | F12, F13 | **нет** (вопрос 15); `structuredClone` не передаёт `AbortSignal` |
| r15 | Буфер обмена в UI терминала (`navigator.clipboard`, Ctrl+C/V на не-mac) | F1 | в `UiContext` нет `os`; `clipboard` только у главной части - нужна команда/мост ядра |
| r16 | Бросок файла ОС в кадр: `webUtils.getPathForFile` синхронный и нужен в кадре-цели | F9 | `ctx.drag` ведёт ядро для внутренних путей; файл ОС - открытый вопрос 11 |
| r17 | Права на пути вне репозиториев для `path:open` (ссылки из вывода) | F1, F9 | в SAD `shell: ["granted","https:"]`; Cyborg пускает любой существующий неисполняемый путь (`openablePath`) - **нужна область или правило** |
| r18 | Показать в системе файл воркспейса и пользовательские JSON (`config:reveal`) | F4 | файл воркспейса - защищённый путь ядра; **нужна команда ядра** |
| r19 | Несколько воркспейсов одновременно отдельными процессами (FR-1029) | F8 | **противоречие** (см. 2.3 п.2) |
| r20 | Предупреждение о живых сессиях при закрытии окна/смене воркспейса | F1, F8 | есть (`disablePreview`, вопрос о живых pty); текст и поведение другие |
| r21 | `ctx.os.process` для `git`, `gh`, `glab`, `jira`, `$SHELL -lc claude …`: правила аргументов, тайм-аут, убийство группы | F11-F14 | есть (`core/src/os-gateway.ts`, `core/test/os-lifetime.test.ts`) |
| r22 | Проверка путей по `realpath` (в Cyborg строковая, мягче) | F9 | в harness строже; Cyborg намеренно не раскрывает ссылки внутри репозитория («дерево и git ходят по ним так же», комментарий `allowed-paths.ts`) - **согласовать**, иначе возможна регрессия для symlink-путей |
| r23 | Память вида (`ctx.state`) вместо `localStorage` (у `<iframe>` другой origin) | F3, F4, F12-F15 | `UiContext.state` есть (до 64 КБ), миграции ключей нет |
| r24 | События потоком без шины: подписка `Disposable` | F1-F3 | есть |

### 2.2. Целевая карта: функция -> плагин -> контракты

| Функция | Плагин | Контракты (даёт / берёт) | Что остаётся ядру | Есть в harness | Чего не хватает |
|---|---|---|---|---|---|
| F1 терминал/сессии | `sessions` | даёт `cyborg.sessions`; берёт `cyborg.agent` (many), `cyborg.session-prompt` (many), `cyborg.agent-tool` (many), `cyborg.projects` (optional) | pty, билет, прямой путь, документ-вкладка | скелет: одна «последняя» сессия в виде; нет списка/полосы, нет `exit/cwd/activity/waiting` в контракте | `cyborg.sessions` целиком (create/send/paste/reveal/uses; onChange: exit, cwd, activity, waiting, turnEnd), несколько сессий, закрытие с подтверждением, привязка (`task/mr/jira`), r1, r2, r4, r6, r12, r15 |
| F2 хуки/статус | `agent-claude-code` | даёт `cyborg.agent` (`watch`) | - | почти полностью (`translate`, `waitAfterStop`, белый список `WAITING`) | «busy» в harness нет; эвристика Esc/Ctrl+C живёт в UI терминала |
| F3 уведомления | `session-notifications` | берёт `cyborg.sessions`; право `notify` | - | плагина нет; `ctx.os.notify` есть | r6; r23 для выключателя |
| F4 кнопки/промпты | `command-buttons` | берёт `cyborg.sessions`, `cyborg.editor`, `cyborg.agent-tool`/`session-prompt` (кнопки от модели); `trackers` для `{pr}`/`{task}` | динамические сочетания, реестр клавиш | `next-actions` (MCP `suggest_actions`) заменяет `suggestions.ts`; `command-buttons` нет | r8, r9, r11, r13, r18; цикл `command-buttons <-> trackers` (parity 4.6 п.5); контракт редактора с проверкой владельца (`editJson` без валидатора недостаточен) |
| F5 изоляция | `session-isolation` | даёт `cyborg.session-prompt` | - | есть | в Cyborg `SESSION_PROMPT = ISOLATION + SUGGEST` одной строкой; во harness два вклада, порядок по id плагина - порядок и текст аргумента будут другими |
| F6 история | `agent-claude-code` (+ `sessions.restore`) | `cyborg.agent.history` | - | чтение (`history.ts`) | удаление (`fs.write` в `~/.claude/projects`), UI списка с клавиатурой (`list-keys`), связь `projectId -> repos` |
| F7 проекты | `projects` | даёт `cyborg.projects`; берёт `cyborg.project-settings` (many) | `security.roots` | демо `projects` | `cyborg.projects` по SAD 5.2, диалог проекта (r11), `dialog:pickDir` + `security.setRoots`, миграция формата |
| F8 воркспейс | ядро | - | замок, «Недавние», выбор, окно без воркспейса, config/state | есть | r7, r19; копия повреждённого файла `.corrupt-<UTC>` (parity 4.6 п.8): в harness «битый файл не стирает разделы и не перезаписывается», копии нет (не проверено в коде) |
| F9 файлы/дерево | `files` | берёт `cyborg.sessions`, `cyborg.projects` (opt), `cyborg.tree-decoration` (many); команда `file.open` | `fs.watch` (лимит 64), drag через ядро | плагина нет | вид дерева, `fs.watch` вместо опроса 3 с, статус git как `tree-decoration`, r13, r16, r22 |
| F10 просмотрщик | `viewer` | даёт `cyborg.editor`; исполняет `file.open` | - | плагина нет; Monaco не в зависимостях | Monaco в `<iframe>` (воркеры на `cyborg-plugin://` - вопрос 11, не проверено), diff с `headContent`, JSON-редактор с проверкой владельца |
| F11 git | `git` | даёт `cyborg.git` (`root`, `branch`, `status`, `headContent`, `branches`, `switch`, `remotes`, `files`) | - | контракт решён в SAD (вопрос 16), кода нет | право `process` на `git` с правилами аргументов; `git:switch` и `sessions.uses` (зависимость `git -> sessions` или проверка у `files`) |
| F12 поиск | `search` | берёт `cyborg.git`, `cyborg.sessions`/`cyborg.projects` (корни), `cyborg.editor`/`file.open` | - | плагина нет | r14, r9, r11 |
| F13 трекеры | `trackers` (один плагин, три вида) | даёт `cyborg.project-settings`; берёт `cyborg.git` (`remotes`, `branches`), `cyborg.sessions`; команда запуска сессии с промптом | - | плагина нет | `process` на `gh/glab/jira`, `shell` (https), r13, r14, привязка к сессии (parity 4.6 п.1), шаблоны промптов (п.5), «Статус» как составной экран («задача, а не виджет» его не покрывает) |
| F14 расширения | `claude-extensions` | берёт `cyborg.projects` (opt), `cyborg.sessions` (opt, активная сессия) | - | плагина нет | права: `process` `$SHELL -lc claude …`, `fs.read` `~/.claude`, `net` (api.github.com и пользовательские https-хабы; формат `net` в манифесте - список хостов, можно ли описать меняющийся человеком список - не проверено), r9, r11 |
| F15 оболочка | ядро + вклады | - | меню, заголовок, тема, шрифт, диалоги | частично | r7, r9, r10, r12, r13 |

### 2.3. Что переносится как есть, что переписывается

**Почти без изменений (чистая логика без Electron/DOM):**
- `session-args.ts`, `claude-args.ts` (кроме состава фрагментов), `events-store.ts`, `pid.ts` -> `sessions` / `agent-claude-code` (часть уже переписана в плагинах harness).
- `git.ts` целиком (232 строки), включая `filterOverrides` и `SAFE_CONFIG`; `git-filters.test.ts` (293 строки, 13 тестов), `git-branch/git-head` -> `git`. Меняется запуск: `ctx.os.process` вместо `execFile`.
- `git-search.ts`, `search-args.ts`, `shared/search-pattern.ts`, `search-model.ts` -> `search`; `SearchRunner` заменяется протоколом отмены ядра (r14).
- `commands.ts`, `prompts.ts`, `command-values.ts` -> `command-buttons` (`commands.ts`/`prompts.ts` - «чистые файлы без Node», их уже читают и main, и renderer); `suggestions.ts` не переносить (заменён `next-actions`).
- `trackers.ts` (парсеры, `interpret`, `parseRemote`, `classifyRemote`), `mrs.ts`, `jira.ts`, `task-details.ts`, `mr-model/task-model/task-flow/status-model/mr-refresh` -> `trackers`: около 2 тыс. строк чистых функций и самые плотные тесты (327).
- `extensions-read/act/usage.ts`, `hubs.ts`, `extensions-model.ts`, `shared/extensions.ts` -> `claude-extensions` (1673 + 1080 строк, 102 теста); к Electron привязаны только данные из `main.ts` (`home`, `userData`).
- `history.ts`, `open-path.ts`, `allowed-paths.ts` (логика `isInside`), `tree-keys.ts`, `list-keys.ts`, `tabs.ts`, `roots.ts`, `row-marks.ts`, `neighbor.ts`, `reorder.ts`, `drop-path.ts`, `term-links.ts` (кроме открытия), `font-size.ts`, `platform.ts`, `title.ts`, `ago.ts`, `workspace-text.ts`.

**Переписывается:**
- `workspaces.ts` -> ядро (`core/src/workspace.ts` уже есть); из Cyborg переносятся утверждения тестов (55): замок, pid, «Недавние», legacy-файл, `.corrupt`, `wx`, защита `offeredWorkspace`.
- `projects.ts` -> `projects` + миграция формата (ядро переносит `{projects,lastProjectId}` с копией `.v1.bak`).
- `main.ts`, `preload.ts` не переносятся (роль - ядро).
- `app.ts` (1360) не переносится; разрезается по мере переноса вкладок, дерева, диалогов в виды.
- `menu.ts` (19 тестов) -> вклады в меню (r9) + меню ядра.
- `sessions.ts` -> `sessions` + `agent-claude-code` (начато).

**Семантика Cyborg, отличная от модели harness (решения нужны до переноса):**
1. Сессия владеет деревом и вкладками файлов (`Session.tree`, `Session.files`, `claudeTab`); в harness файлы - документы `viewer` в общей группе, дерево одно (SAD 5, вопрос 1). Это смена UX, а не рефакторинг.
2. Несколько воркспейсов одновременно (`launchInstance`, FR-1029): в harness `app.requestSingleInstanceLock({workspace})` (`playground/src/main/main.ts:38`) - второй запуск отдаёт фокус первому и завершается. Cyborg запускает второй процесс с тем же `--user-data-dir`; по знанию Electron замок single-instance общий для каталога данных, значит пункт «Открыть воркспейс в новом окне» перестанет работать (запуском не проверено).
3. Восстановление сессий: BRD Cyborg (non-goals, `docs/01-product/brd.md:84`) исключает «автоматическое восстановление»; harness реализует ручное из списка «Сессии прошлого запуска» (lazy) и планирует `sessions.restore: eager` - eager противоречит non-goal.
4. Кнопки от модели: вместо разбора хвоста ответа по `Stop` (`suggestions.ts`) - MCP-инструмент `suggest_actions` (`next-actions`): другое поведение и допущения (MCP-сервер на сессию, токен в env); `suggestions.test.ts` (14) не переносится «как есть».
5. Права: Cyborg проверяет пути строкой и пускает любой неисполняемый путь в `path:open`; harness - `realpath` и области (r17, r22).

---

## 3. Что переносить в cyborg-harness

Допущение (не проверено, решение владельца): встроенные плагины Cyborg живут в `cyborg-harness/plugins/` (рядом с playground-плагинами; playground остаётся стендом ядра), а ai-cyborg до отключения остаётся поставляемым продуктом. Если плагины будут жить в ai-cyborg и тянуть ядро пакетом, меняется только 3.1.

### 3.1. Код (по плагинам)

| Плагин | Файлы Cyborg | Новое место (предложение) | Примечание |
|---|---|---|---|
| git | `src/main/git.ts` | `plugins/git/` | перенос почти дословный; `execFile` -> `ctx.os.process.run` |
| search | `git-search.ts`, `search-args.ts`, `search-run.ts` (заменить), `shared/search-pattern.ts`, `renderer/search-dialog.ts`, `search-model.ts` | `plugins/search/` (+ `ui/`) | диалог -> вид/документ (r11) |
| sessions | `sessions.ts`, `session-args.ts`, `events-store.ts`, `pid.ts`; из `app.ts`: Session, `createTerminal`, `createSessionView`, `closeSession`, `activateSession`; `term-links.ts`, `drop-path.ts`, `render-ticket.ts`, `theme.ts` (палитра VS Code) | `playground/plugins/sessions` -> `plugins/sessions/` | расширить существующий скелет |
| agent-claude-code | `claude-args.ts`, `history.ts`, `renderer/ago.ts` | `plugins/agent-claude-code/` (есть) | добавить `deleteHistory`, `COLORTERM` |
| session-notifications | `notify-args.ts`, `renderer/notify.ts` | `plugins/session-notifications/` | малый, подходит для пилота |
| command-buttons | `commands.ts`, `command-store.ts`, `prompts.ts`, `prompt-store.ts`, `renderer/command-bar.ts`, `command-editor.ts`, `command-values.ts`, `config-editor.ts`, `prompt-editor.ts` | `plugins/command-buttons/` | `suggestions.ts` не переносить |
| projects | `projects.ts`, `jira-keys.ts`, `jsonfile.ts`, диалог проекта из `app.ts` (129-300), `renderer/sources.ts` (раздел источников уходит в `trackers` через `cyborg.project-settings`) | `plugins/projects/` | |
| files | `files.ts`, `allowed-paths.ts`, `open-path.ts`, `renderer/tree.ts`, `tree-keys.ts`, `roots.ts`, `row-marks.ts`, `neighbor.ts`, `reorder.ts`, `list-keys.ts`, `tabs.ts` | `plugins/files/` | `allowed-paths` как главный процесс исчезает (права ядра), логику `isInside` оставить для тестов |
| viewer | `renderer/viewer.ts` + копирование `monaco-editor/min/vs` (`scripts/build.mjs`) | `plugins/viewer/` | зависимость `monaco-editor` добавить |
| trackers | `trackers.ts`, `mrs.ts`, `mrs-service.ts`, `jira.ts`, `jira-service.ts`, `task-details.ts`; renderer: `tasks.ts`, `task-model.ts`, `task-flow.ts`, `task-header.ts`, `panel.ts`, `panel-return.ts`, `mrs.ts`, `mr-model.ts`, `mr-refresh.ts`, `status.ts`, `status-model.ts`, `sources.ts` | `plugins/trackers/` | `validateProjectsState`, `sessionDirsAllowed`, `saveProjectsState` - границу с `projects` разрезать |
| claude-extensions | `extensions*.ts` (5 файлов), `hubs.ts`, `shared/extensions.ts`, `renderer/extensions-dialog.ts`, `extensions-model.ts` | `plugins/claude-extensions/` | |
| ядро/оболочка | идеи `menu.ts`, `font-size.ts`, `platform.ts`, `prefs.ts`, `title.ts`, `ipc-error.ts` | `core`/`playground` | вклады и настройки |

Механические правки при переносе (измерено): 223 относительных импорта без `.ts` (в harness обязателен `.ts`, `allowImportingTsExtensions` + `verbatimModuleSyntax`), 16 параметров-свойств конструктора в 14 файлах (в harness запрещены, `erasableSyntaxOnly`), `enum` нет; в harness включены `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, ESLint `strictTypeChecked` с нулём предупреждений - у Cyborg линтера нет, объём правок не оценён. Сборка Cyborg: `target: node22` для main; harness: Node 24.

### 3.2. Тесты

- Переезжают с сохранением утверждений (меняется способ доступа): все `test/*.test.ts` по таблице 1.1 (878 + 30 вызовов). Наименее связанные (переносить первыми): `git-filters`, `git-search`, `search-model`, `commands`, `prompts`, `session-args`, `drop-path`, `term-links`, `tree-keys`, `tree`, `list-keys`, `tabs`, `font-size`, `title`, `extensions-*`, `hubs`.
- Тесты, тянущие чужое (фикстуры придётся пересобирать): `mrs.test.ts` (73; импортирует `claude-args`, `projects`, `trackers`), `jira.test.ts` (50; `projects`, `trackers`, `mrs`), `stores.test.ts` (26; `git`, `projects`, `trackers`, `jsonfile`), `workspaces.test.ts` (55; `projects`, `trackers`), `trackers.test.ts` (69; `renderer/task-model`, `claude-args`), `suggestions.test.ts` (`commands`, `claude-args`), `history.test.ts` (`claude-args`), `commands-store.test.ts` (`projects`).
- `static-guards.test.ts` (4 теста) -> harness: запрет `innerHTML` и т.п. в `ui/` плагинов (расширить `core/test/plugin-imports.test.ts`), список ключей хранилища (заменяется «плагин не пишет `localStorage`, только `ctx.state`»), список писателей на диск (заменяется проверкой `fs.write` в манифестах), `aria-labelledby` у диалогов (переносится на `cy-*`/плагины).
- `check-corpus.test.ts` (25) и `scripts/corpus-lib.ts`/`check-corpus.ts` остаются в ai-cyborg (проверка корпуса Cyborg); в harness можно завести проверку идентификаторов `CH-`.

### 3.3. Тестовые данные, записи, подставные программы

- Записанных сессий в Cyborg нет (`test/parity/` не существует; parity-plan предлагал `events.jsonl`, `output.txt`, `cli.json`, `expect.json`, `manifest.json`). Их надо снять на `e4beb72`, а не перенести.
- Подставные программы живут внутри `scripts/smoke.mjs` строками: `claude` (SessionStart при старте, `cd <dir>` -> событие cwd, `suggest` -> ответ с кнопками, `ask` -> запрос), `gh` (вход не выполнен), `jira` (одна задача SMK-1; формы ответов jira-cli 1.7.0), каталог настроек Claude для окна «Расширения» (магазин, скилл, MCP с «секретом» в адресе). Стоит вынести в `fixtures/fake-bin/` и использовать и в тестах плагинов, и в smoke harness. В harness подставной `claude` уже есть в `playground/test/agents.test.ts` (350 строк).
- Репозиторий-проба для git (smoke создаёт на лету) и ветка с ключом Jira `SMK` - перенести как фикстуру.

### 3.4. Скрипты и замеры

- `scripts/measure.mjs` (115 строк): переносить вместе с `trackers`, предварительно починить (проект «Upcore» по умолчанию, чтение `userData/projects.json` и `trackers.json`, а не воркспейса). Он же нужен как базовая линия для вопроса 9 SAD («его замер живёт в репозитории Cyborg, здесь его нет»). Добавить: время до окна, память (`footprint`/PSS), задержку и пропускную способность вывода терминала на реальной сессии, время панелей и поиска (parity-plan раздел 8: ничего из этого не измерено).
- `scripts/test.mjs` (esbuild во временный каталог + `node --test`) в harness не нужен (Node 24 снимает типы сам).
- `scripts/smoke.mjs` (827 строк, 110 `assert.`, 27 `log`, 128 обращений к DOM/CDP): сценарии переносятся как поведение, не как код (4.3, узел «smoke»); запуск Electron/CDP/`xvfb` уже есть в `playground/scripts/smoke.mjs` (487 строк).
- `scripts/build.mjs`: три бандла esbuild + копирование Monaco; в harness своя сборка (`playground/scripts/build.mjs`), добавить Monaco.
- `cyborg` (shell-лаунчер с `CYBORG_CWD`, проверками Node 24/git/npm и песочницы Chromium на Linux): остаётся с приложением; у harness есть `--workspace`/`--no-workspace`, `CYBORG_CWD` в `playground/src/main/main.ts` не нашёл (там `path.resolve(workspaceArg)` от cwd процесса) - перенести идею в лаунчер.

### 3.5. CI-проверки и документация

- Из `.github/workflows/ci.yml` в harness уже есть: build, typecheck, lint, test, smoke на macOS+Ubuntu. В `.github/workflows` harness только `ci.yml`: нет job `corpus`, агрегатора `CI` (required check), `docs-site.yml`; `dependabot.yml` в корне `.github` не листал.
- Дополнить: храповики границ (частично `core/test/plugin-imports.test.ts`); тест совместимости каналов нужен только если принята прокладка (раздел 5.3 п.7).
- Документация авторам: в harness есть `contracts/README.md`, FR-CH-1013 «Набор автора плагина», сценарий `author-writes-plugin`. Из Cyborg переносить как «наследуемые решения» в README каждого плагина с таблицей «FR-номер -> тест»: ADR-0002 (изоляция окна/preload), 0003 (pty + хуки), 0005 (git через CLI), 0007 (трекеры через gh/glab), 0008-0010 (бюджет MR, кэш входа, детали задачи), 0011 (git switch), 0012 (изоляция), 0014 (воркспейс), 0015-0018 (кнопки, промпты, расширения). `docs/guide` (1304 строки, сайт) остаётся пользовательской документацией; `docs/guide/contributing` придётся переписать под плагины.

### 3.6. Что остаётся в ai-cyborg до конца миграции

Вся работающая версия: `src`, `test`, `scripts/smoke.mjs`, `scripts/measure.mjs` (до замены), `cyborg`, `assets`, `site/`, `docs/` (корпус 153 требования, ADR, verification-matrix), `.github`, `package.json` (`postinstall`, `allowScripts`). Источник эталонного поведения - master `e4beb72`; на нём снимаются записанные сессии и базовые метрики. Корпус обязывающий (`approved`): менять владельца требований можно только по процессу `dex-auto` из `CLAUDE.md`.

---

## 4. Последовательность миграции

### 4.1. Граф связей

- `git` - листовой. Потребляют: `files`, `viewer` (diff), `search`, `trackers`, `command-buttons` (`{branch}`).
- `agent-claude-code` - листовой (`cyborg.agent`); потребитель `sessions`.
- `sessions` -> `agent-claude-code`, `session-isolation`, `next-actions`, `projects` (opt). Потребляют: `files`, `session-notifications`, `command-buttons`, `trackers`, `search` (корни), `claude-extensions` (активная сессия, opt).
- `projects` - листовой по данным; в Cyborg `workspaces` и `trackers` сцеплены с ним (`validateProjectsState`, `resetAuth`).
- `viewer` - листовой (Monaco); потребляют `files`, `search`, `command-buttons` (редактор).
- `files` -> `sessions`, `projects`, `git`, `viewer`.
- `search` -> `git`, `sessions`/`projects`, `viewer`.
- `trackers` -> `projects` (settings), `git`, `sessions`, шаблоны промптов.
- `command-buttons` -> `sessions`, `viewer`, `trackers` (через `{pr}`/`{task}`; цикл по шаблонам промптов).
- `claude-extensions` -> `projects` (opt), `sessions` (opt) - по сути независим.
- `session-notifications` -> `sessions`.

### 4.2. Предложенный порядок и параллельность

| Волна | Что | Параллельно | Блокирует |
|---|---|---|---|
| 0 (ядро, один-два человека) | r6, r7, r8, r9, r14, r13 (минимум: область для полосы сессий и панели инструментов); решение по r19; пакетирование и предел ввода (r1); `COLORTERM` (r4) | r8 и r9 независимы друг от друга; r6, r7 малые | всё ниже |
| 1 (независимые) | `git` + контракт `cyborg.git`; `claude-extensions` (с оговоркой r9/r11); `viewer` (спайк Monaco + `cyborg.editor`); `projects` + миграция формата воркспейса; запись сессий и базовые метрики на `e4beb72` | 4-5 человек, общего нет | `files`, `search`, `trackers` |
| 2 | `sessions` полный (`cyborg.sessions`, список, события, привязка), затем `session-notifications` | `sessions` одним человеком; `session-notifications` после контракта | `files`, `trackers`, `command-buttons` |
| 3 | `files` (после `sessions`, `git`, `viewer`, `projects`); `search` (после `git`, `viewer`, r14) | параллельно между собой | - |
| 4 | `trackers` (после `projects`, `git`, `sessions`), `command-buttons` (после `sessions`, `viewer`, r8) | параллельно, но сначала решить цикл по промптам | - |
| 5 | Оболочка Cyborg: полоса сессий, панель инструментов, вклады в меню, `Cmd+0`/колесо, заголовок, настройки; переключение поставки на harness | - | вывод ai-cyborg из эксплуатации |

Пилотный порядок sad2 6.1 (пилот `session-notifications`, а не `path-drop`) разумен: проверяет контракт `cyborg.sessions`, `notify`, фокус и права, не трогая терминал и данные.

### 4.3. Тугие узлы

1. **D-27 и горячие клавиши.** Реестр сочетаний должен быть один (меню + плагины + кнопки пользователя) с условием `when`. Без `ctx.keys.register` `command-buttons` вынести нельзя (потеряются F1-F4 по умолчанию). Сочетания, которые живут только в слушателе окна (`Cmd/Ctrl+Shift+N`, `Cmd/Ctrl+0`, колесо с модификатором), при фокусе во `<iframe>` не сработают: перехват в главном процессе подтверждён только на Linux. Общий реестр закрывает D-27 (проверка конфликтов по реальным акселераторам вместо ручного `RESERVED_*`).
2. **Горячие пути pty.** `session:data` без пакетирования, квадратичный `pendingData`, `session:input` по IPC на каждое нажатие; бюджеты SAD (шлюз 1 мс p99, вывод в кадр 16 мс) - предложения, не измерения; задержка шлюза `ctx.os` не мерилась, `claude` в отдельном pty-хосте не испытан. Нужна базовая линия на Cyborg до переноса.
3. **ProjectStore и OWN_FIELDS.** `save` теряет неизвестные верхние поля, кроме `commands`. Пока `ProjectStore` живёт в ai-cyborg, откат с нового формата стирает данные нового формата. Шаг 0 из `03-migration/srs.md` (FR-CH-3010) не сделан: нужна правка `projects.ts` в ai-cyborg (сохранять неизвестные поля) до включения общего формата.
4. **Один процесс на воркспейс / единственный инстанс.** См. 2.3 п.2: Cyborg - N процессов с общим `userData`, harness - один. Вместе с `userData/sessions/<pid>-<id>.jsonl`, общим `claude-hooks.json` и общим `recent-workspaces.json` (записи без блокировок).
5. **localStorage.** 10 ключей + 3 семейства привязаны к сессии Chromium воркспейса (`userData/workspaces/<хеш>/`); у `<iframe>` другой origin, настройки (шрифт, фильтры, сортировки, режим поиска, вкладки «Расширений») пропадут без миграции в `ctx.state`; state вида ограничен 64 КБ JSON.
6. **smoke, привязанный к DOM.** `scripts/smoke.mjs` обращается к `#tree`, `#session-list`, `#tree-meta`, `#new-session`, `#project-dialog` и т.п. в главном документе (128 обращений к DOM/CDP); после выноса в `<iframe>` нужен выбор кадра. Лучше переписать на события контрактов (parity-plan раздел 5), чем на селекторы.
7. **`app.ts` (1360) и `main.ts` (632):** центр сборки; импортируют 34 и 26 модулей; разрезать можно только по мере переноса.
8. **Цикл `command-buttons <-> trackers`** через промпты и `{pr}/{task}` (parity 4.6 п.5): граф с циклом не загружается; нужно решение (шаблоны у `trackers` либо контракт-источник подстановок).
9. **Модель «сессия владеет деревом и файлами»** (2.3 п.1): без решения `files`/`viewer` двигать нельзя.
10. **Синхронные `alert/confirm`** (11): семантика теряется.
11. **Связность модулей main:** `sessions -> claude-args -> suggestions -> commands`; `jira/mrs/trackers -> prompts -> commands`; `workspaces -> trackers`; `hubs -> commands`; 21 из 38 модулей импортируют `node:*`/`electron`/`node-pty`; 20 файлов renderer импортируют `../main/*` (`trackers` 8, `mrs` 8, `projects` 6, `jira` 4, `commands` 3). Типы надо вынести в пакет контрактов раньше кода.

---

## 5. Актуальность parity-plan (версия `9fa78e5`)

### 5.1. Подтвердилось (проверено по master)

58 каналов = 51 `handle` + 7 `on`, список совпадает с таблицей 4.2 построчно; 14 событий; 61 член `window.cyborg`; 6 `<dialog>`; 153 требования; 38 модулей `src/main` / 7057 строк; 45 файлов `src/renderer` / 6828 строк; `app.ts` 1360, `main.ts` 632, `smoke.mjs` 827; 21 из 38 модулей с `node:*`/`electron`/`node-pty`; 20 файлов renderer с `../main/*`; 10 ключей localStorage и 3 семейства; D-27 и 5 акселераторов меню; `RESERVED_*` без акселераторов поиска/расширений; `Cmd/Ctrl+Shift+N` и `Cmd/Ctrl+0` только в слушателе окна; квадратичный `pendingData`; `ProjectStore` не сохраняет неизвестные поля; счётчик id сессии.

### 5.2. Неверно или неточно относительно master

| Пункт | В плане | Факт |
|---|---|---|
| Нативные `alert/confirm` | «10 вызовов в `app.ts` и `config-editor.ts`» | 11: `app.ts` 10 + `config-editor.ts:41`; три из них - `.catch(alert)`/`alert(ipcErrorText)` |
| Число тестов | 925 (893 + 32), «один пропущен» | статический счёт 908 (878 + 30); условных пропусков два (`skip: canChmod ? false : …` для root/Windows и `skip: NON_UTF8_SKIP`); запуском не подтверждено |
| `measure.mjs` | «замеряет только загрузку панели» | ещё и привязан к проекту «Upcore» и к `projects.json`/`trackers.json` userData, а не к воркспейсу |
| Шаг 0 («ProjectStore сохраняет неизвестные поля», устойчивый id сессии) | планируется | не сделан: `OWN_FIELDS = ['commands']` (`projects.ts:112`), `nextId++` (`sessions.ts`) |

### 5.3. Устарело из-за изменений в harness и решений SAD

1. **Ссылки на документы, которых нет в harness:** `ADR-CH-0006-strangler-migration-and-parity`, `ADR-CH-0010`, `sad2.md`, `docs/01-product/03-migration/srs.md`. В `cyborg-harness/docs` ADR: 0001-0005, 0007, 0008, 0012, 0014; SRS только двух фич; FR-CH всего 30 (`1001..1015` с пропусками, `2001..2014` с пропусками, 3 NFR). Номера FR-CH-1018, 1020-1022, 2003, 2011, 2016, 2017, 2024-2035, 3001-3016 из плана там отсутствуют; 2005 и 2006 названы иначе («Виды и документы плагина», «Слой окна: диалоги и замок»). Матрица владельцев и ссылки FR-CH требуют перепривязки.
2. **Имена плагинов.** План: `session-notifications`, `claude-extensions`, `command-buttons`, `search`, `trackers`, `files`, `sessions`, `agent-claude-code`, `git`, `projects`, `viewer`. SAD (раздел 5, 3.9, вопрос 16) называет `sessions`, `agent-claude-code`, `files`, `viewer`, `projects`, `git`, `trackers`, `search`, `command-buttons`; `claude-extensions` и `session-notifications` в SAD отдельно не описаны (в ядре «уведомлений о сессиях» нет). Это решения плана, не принятые владельцем.
3. **Изоляция сессий.** План 4.1/4.6 п.6: «отдельного плагина `session-isolation` нет». Сейчас он есть (`playground/plugins/session-isolation`, `cyborg.session-prompt`, many); п.6 закрыт. Но порядок фрагментов определяется сортировкой по id плагина, а в Cyborg `SESSION_PROMPT = ISOLATION + SUGGEST` - требование «байт-в-байт тот же промпт и порядок аргументов» (план, строка про `session-args`/`sessions.test`) уже невыполнимо.
4. **Кнопки от модели.** План: `session:suggest` и `parseSuggestions` по концу хода, тесты `suggestions.test.ts`. В harness это `cyborg.agent-tool` + MCP-сервер (`next-actions`, `sessions/mcp.ts`). Паритет S4 надо переопределить: требования FR-12007/12008 (кнопки снимаются на следующий запрос, на фоновую работу, на вопрос) остаются, реализация другая.
5. **`cyborg.git`.** План 4.6 п.3: нет `gitRemotes`/`gitFiles`. SAD вопрос 16 включает `remotes` и `files` - закрыто; п.4 (`git:switch` и сессии) открыт.
6. **Восстановление сессий** (план: «условно, без решения владельца не реализуется»). В harness сделано (lazy, ручное); конфликт с non-goal BRD остаётся только для `eager`.
7. **Механизм 7 «прокладка совместимости каналов» (FR-CH-3003) и чек-лист «перенос в `src/plugins/<id>`»** исходят из strangler внутри ai-cyborg. Сейчас `docs/06-plans/roadmap.md` говорит: «Перевод приложения Cyborg на харнес - план репозитория Cyborg, не этого». Нужно решение: будет ли прокладка `window.cyborg`, или приложение собирается заново на плагинах и IPC-каналы исчезают. Без прокладки тест на 58 каналов заменяется тестом на 58 функций контрактов/команд по таблице 4.2.
8. **Бюджеты.** План: 1 мс p99 на шлюз, 16 мс на вывод. В harness замерена цена RPC (`docs/05-verification/spike-hosts.md`: p99 до 1,5 мс на вызов до 64 КиБ), шлюз `ctx.os` не замерен. Метрики «снять в P0» (старт, память, вывод терминала, время окон, размер бандлов) не сняты нигде.
9. **Пути.** План: `src/plugins/<id>`; в harness плагины живут в `playground/plugins/<id>` (стенд), отдельного каталога встроенных плагинов нет.
10. **Переименование «Расширения» -> «Расширения Claude Code»** (FR-CH-3008) - решение плана; в docs harness не найдено.

---

## 6. Минимум «микроядро готово к системе плагинов» с точки зрения Cyborg

### 6.1. Обязательно доказать на ядре (пилоты) до полного переноса

| № | Что доказать | Почему именно оно | Что уже есть |
|---|---|---|---|
| P1 | Реальная сессия `claude` через `sessions` + `agent-claude-code` под нагрузкой: вывод без квадратичных буферов, предел ввода 1 МиБ, размер 1..1000, перезапуск хоста и окна с `attach`, скрытый вид не теряет вывод; задержка вывода против базы Cyborg (кадр 16 мс) | самый горячий путь продукта | pty/`share`/`attach`/сторож; smoke с настоящим `claude` под флагом `CYBORG_SMOKE_CLAUDE`; нет предела ввода, замера на реальной нагрузке, pty-хоста отдельным процессом |
| P2 | Событийная цепочка хук -> статус -> действие в другом плагине: `cyborg.sessions` (exit/cwd/activity/waiting) + `session-notifications` с кликом (r6) и фокусом окна (r5); два плагина в разных хостах | проверяет события без шины и право `notify`; пилот по sad2 6.1 | `cyborg.agent.watch`, `ctx.window.onFocusChange`, `notify.show`; нет `cyborg.sessions`, клика, закрытия уведомления |
| P3 | Единый реестр сочетаний: `ctx.keys.register` с условием, конфликт с акселератором меню, перехват из `<iframe>` на macOS (включая `Cmd+0`, колесо с модификатором) | закрывает D-27 и потерю `Cmd/Ctrl+Shift+N` | статические сочетания, `before-input-event` на Linux; macOS не проверена |
| P4 | Горячий read-путь через границу плагинов: дерево `files` + `cyborg.git.status` + `fs.watch` вместо опроса 3 с на реальном репозитории; `file.open` через via-contract в `viewer` | покрывает задержку шлюза (вопрос 9), права `fs.read/watch`, контракт `cyborg.git` | `fs.watch` с лимитом 64, `readSlice`, via-contract; плагинов и контрактов нет |
| P5 | Monaco в `<iframe>` на `cyborg-plugin://` (воркеры, CSP `style-src 'unsafe-inline'`) рядом с xterm; JSON-редактор с проверкой владельца | не проверено (SAD вопрос 11) | xterm в виде `sessions` работает; Monaco нет |
| P6 | Миграция данных: файл воркспейса `e4beb72` (с `commands`, `trackers`, `jira`, неизвестными полями) -> `config/state`; повтор идемпотентен; localStorage -> `ctx.state`; откат не стирает поля | потеря данных пользователя недопустима | `core/src/workspace.ts` переносит `{projects,lastProjectId}` с `.v1.bak`; `commands`, `trackers`, `jira`, ключи localStorage не покрыты (по SAD 3.10 переносятся `projects`/`trackers`/`jira`/`lastProjectId`; `commands` и ключи localStorage в SAD не названы) |
| P7 | CLI-плагин с отменой и пулом: срез `trackers` (вызов `gh api`/`glab api`/`jira`) через `ctx.os.process` с тайм-аутом 120 с, лимитом вывода 64 МиБ, группой процессов, отменой (r14), конкурентностью 6 | проверяет протокол отмены и права на программы | `process` с тайм-аутом и группой есть; отмены нет |
| P8 | Раскладка окна Cyborg: полоса сессий, боковая панель «Файлы/Сессии», панель инструментов, полоса под терминалом, выезжающая панель; вклады в меню (r9); заголовок (r7) | без этого пользовательский вид Cyborg не воспроизводится | каркас playground (сессия слева, вкладки справа); `kind/order` не начато |
| P9 | Решение по экземплярам: один процесс - один воркспейс или N процессов с общим `userData` (замок single-instance по воркспейсу) | иначе «Открыть в новом окне» (FR-1029) теряется | один экземпляр жёстко |
| P10 | Базовые метрики Cyborg (старт до окна, память, пропускная способность терминала, время панелей и поиска) и записанные сессии S1-S18 | без базы бюджеты «не хуже на 10%» непроверяемы | в Cyborg нет; в harness замеры только ядра |

### 6.2. Следующий эпик (полный перенос), пилотов на ядре не требует

`trackers` целиком (три вида, Jira, «Статус», пул MR), `command-buttons` целиком (редакторы, подстановки, F1-F4), `claude-extensions`, `search` целиком, `projects` целиком (диалог, источники), `files` со всеми клавишами и ARIA, история с удалением, полная оболочка (настройки, шрифт, колесо, делитель), вывод ai-cyborg из эксплуатации, переписывание smoke, перенос корпуса требований и сайта.

### 6.3. Открытые решения владельца, влияющие на состав минимума

1. Где живут встроенные плагины (cyborg-harness или ai-cyborg).
2. Прокладка `window.cyborg`/каналов IPC или приложение собирается заново.
3. Один процесс или несколько воркспейсов одновременно (P9).
4. Модель «файл = документ / превью / вкладка сессии» (вопрос 1 SAD).
5. Отмена non-goal «автоматическое восстановление» для режима `eager`.
6. Кнопки от модели: замена парсера на MCP-инструмент как смена поведения или как паритет (5.3 п.4).
7. D-27: исправлять `RESERVED_*` в ai-cyborg до миграции или закрыть общим реестром ядра.
8. Права `net` для хабов с пользовательскими адресами (не проверено).
