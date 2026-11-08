import type { Disposable } from './plugin.ts';

/** Программа или программа с первыми аргументами; `env` - имена переменных, которые плагин может ей передать: точное имя или маска `ПРЕФИКС_*` для номерных (`GIT_CONFIG_KEY_*` покрывает `GIT_CONFIG_KEY_0`, `GIT_CONFIG_KEY_1`, ...). */
export type ProgramRule = string | { readonly program: string; readonly args: readonly string[]; readonly env?: readonly string[] };

/** Права главной части плагина: что ядро пропустит через `ctx.os` (SAD §3.7). Нет права - нет члена в `ctx.os`. */
export interface PluginPermissions {
  /** Области путей: `workspace`, `plugin-data`, `plugin-temp`, `granted` (выбор человека в `dialog`), абсолютный путь (каталог с поддеревом, `~` - домашний) или маска: `*` - часть имени, `**` - любые каталоги. */
  readonly 'fs.read'?: readonly string[];
  /** Те же области и `workspace.git` - корни воркспейса вместе с записью в `.git`. */
  readonly 'fs.write'?: readonly string[];
  /** Открыть в системе: области путей, как у `fs.read`, `any` - любой существующий документ или каталог, и схемы URL с двоеточием (`https:`, `mailto:`). */
  readonly shell?: readonly string[];
  readonly process?: readonly ProgramRule[];
  /** Программы в псевдотерминале; правило той же формы, что у `process`. */
  readonly pty?: readonly ProgramRule[];
  /** Запуски, которые поставщик описывает потребителю (`cyborg.agent`); члена в `ctx.os` не даёт, pty потребителя с `describedBy` сверяется и с ними. */
  readonly launch?: readonly ProgramRule[];
  /** Хосты HTTP; `config:<поле>` - хост из своего раздела config. */
  readonly net?: readonly string[];
  readonly env?: readonly string[];
  readonly notify?: boolean;
  readonly clipboard?: readonly ('read' | 'write')[];
  /** Маски ссылок на секреты внешнего источника: `vault://kv/data/jira*`. */
  readonly 'secrets.ref'?: readonly string[];
  /** Задать корни проектов - область `workspace` для всех плагинов. */
  readonly 'security.roots'?: boolean;
  /** Закрыть окно своим `ui.overlay`; без него манифест не примут. */
  readonly 'ui.lock'?: boolean;
  /** Сервер HTTP на 127.0.0.1 (`ctx.os.serve`): так агент зовёт инструменты плагина по MCP. */
  readonly serve?: boolean;
}

export interface DirEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'link' | 'other';
}

export interface FileStat {
  readonly kind: 'file' | 'dir' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
}

export interface FileSlice {
  readonly text: string;
  /** Сколько байт файла покрывает `text`: незаконченный символ UTF-8 на конце куска не входит - на столько сдвинуть `offset`. */
  readonly bytes: number;
  readonly size: number;
}

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: string | null;
  /** Вывод до предела; обрезанный по `truncated` на границе символа. */
  readonly stdout: string;
  readonly stderr: string;
  /** Вывод `stdout` или `stderr` дошёл до предела (`maxOutputBytes`, по умолчанию 16 МиБ): программа остановлена `SIGTERM`, а в ответе только прочитанное. Для плагина это ошибка («ответ больше N»), а не данные. */
  readonly truncated: boolean;
}

export interface ProcessOptions {
  readonly cwd?: string;
  /** Только имена из `env` правила `process`; база - PATH, HOME, локаль. Значения - данные, а не ссылки `$secret`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  /** Срок программы, мс; истёк - `SIGTERM` всей группе, в ответе `signal: 'SIGTERM'`. */
  readonly timeoutMs?: number;
  /** Предел вывода, байт на `stdout` и на `stderr` отдельно: целое от 1 до 64 МиБ, по умолчанию 16 МиБ. Превышение не ошибка вызова, а `truncated` в ответе. */
  readonly maxOutputBytes?: number;
}

export interface HttpRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Срок всего запроса вместе с телом, мс; по умолчанию 30 с, дольше - `Timeout`. Тело ответа больше 16 МиБ - `Remote`. */
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Запрос к серверу плагина: имена заголовков в нижнем регистре, тело - текст до 1 МиБ. */
export interface ServeRequest {
  readonly method: string;
  /** Путь с запросом, как в первой строке HTTP: `/mcp?x=1`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Ответ обработчика; не ответил за 30 с - клиент получит 504, чужая форма - 502. */
export interface ServeResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpServer {
  /** `http://127.0.0.1:<порт>`; порт выбирает ОС. */
  readonly url: string;
  dispose(): void;
}

/** Файлы: без права - только свои каталоги `paths`; чтение шире - по `fs.read`, запись - по `fs.write`. Путь вне области - `PermissionDenied`, никогда `NotFound`; нет файла или каталога внутри области в `readText`, `readSlice`, `list`, `stat`, `watch`, `realpath` - `NotFound` (проверка существования - `stat` и ловля `NotFound`). */
export interface OsFs {
  readText(path: string): Promise<string>;
  list(dir: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  /** Настоящий путь: ссылки раскрыты, как `realpath` ОС. Нужен, чтобы сверять пути по имени (ключи `~/.claude.json`, корни проектов): `/tmp/x` и `/private/tmp/x` - один каталог. Ссылка наружу области - `PermissionDenied`, нет пути - `NotFound`. */
  realpath(path: string): Promise<string>;
  /** Кусок файла с байта `offset`, от 4 байт до 1 МиБ: длинный журнал читается частями, а не целиком. */
  readSlice(path: string, offset: number, maxBytes: number): Promise<FileSlice>;
  /** Изменения файла или каталога по праву чтения; у каталога - имена изменённых, события склеиваются за 50 мс. Ядро закрыло наблюдение само (ошибка ОС, путь ушёл из прав) - `onClose` с причиной. */
  watch(path: string, listener: (names: readonly string[]) => void, onClose?: (reason: string) => void): Promise<Disposable>;
  writeText(path: string, text: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** Своё хранилище секретов ядра: ключи видны только своему плагину; без шифрования ОС - `Unavailable`. */
export interface OsSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PtySpawnOptions {
  readonly program: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** Только имена из `env` правила `pty`; база - PATH, HOME, локаль. */
  readonly env?: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  /** Пережить перезапуск хоста: процесс ждёт, пока владелец вернётся через `attach`. */
  readonly persist?: boolean;
  /** Плагин, описавший запуск: ядро пропустит его, только если описание подходит и под правило `launch` этого плагина. */
  readonly describedBy?: string;
}

export interface PtyExit {
  readonly code: number;
  readonly signal?: number;
}

export interface PtyInfo {
  readonly id: string;
  readonly pid: number;
  readonly program: string;
  readonly args: readonly string[];
  readonly persist: boolean;
  /** Есть, если процесс завершился, пока владельца не было. */
  readonly exit?: PtyExit;
}

export interface PtyHandle extends PtyInfo {
  /** Хвост вывода до `attach`; у только что запущенного пуст. Может начинаться посреди escape-последовательности. */
  readonly backlog: string;
  onData(listener: (chunk: string) => void): Disposable;
  /** Завершился до подписки - слушатель получит выход сразу. */
  onExit(listener: (exit: PtyExit) => void): Disposable;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'): Promise<void>;
  /** Одноразовый билет для своего UI (`ctx.terminal.open` в виде): живёт 30 с, чужой плагин его не откроет. */
  share(): Promise<PtyTicket>;
}

/** Строка-билет: главная часть передаёт её своему виду, например ответом своей команды. */
export type PtyTicket = string;

/** Процесс держит ядро: он переживает хост плагина, если просили `persist`. */
export interface OsPty {
  spawn(options: PtySpawnOptions): Promise<PtyHandle>;
  /** Только свои pty. */
  list(): Promise<PtyInfo[]>;
  /** Свой pty без владельца: после перезапуска хоста или «Оставить работать». Брать при активации: с неё идёт льготный срок ядра, после него процесс завершён и ответ - `NotFound`. */
  attach(id: string): Promise<PtyHandle>;
}

/** Клик по уведомлению: своя команда из манифеста, аргументы сверяются её схемой. Команда, а не колбэк: клик переживёт перезапуск хоста. */
export interface NotifyClick {
  readonly command: string;
  readonly args?: readonly unknown[];
}

export interface NotifyOptions {
  /** Клик поднимает окно, закрывает уведомление и запускает команду. */
  readonly onClick?: NotifyClick;
}

/** Выгрузка плагина закрывает его живые уведомления; падение хоста - нет, клик дойдёт до вернувшегося плагина. */
export interface OsNotify {
  /** Ответ - id уведомления для `close`. Длина заголовка и текста ограничена средой, превышение - `Invalid`; сверх предела живых закрывается старейшее уведомление плагина. */
  show(title: string, body?: string, options?: NotifyOptions): Promise<string>;
  /** Уже закрытое или чужое уведомление - ничего не делает. */
  close(id: string): Promise<void>;
}

export interface PluginOs {
  /** Свои каталоги: данные и временный; читать и писать в них можно без права. */
  readonly paths: { readonly data: string; readonly temp: string; readonly home: string };
  readonly fs: OsFs;
  readonly pty?: OsPty;
  /** Программы нет в системе (или нет `cwd`) - `NotFound`; ненулевой код выхода ошибкой не считается и приходит в `ProcessResult.code`. */
  readonly process?: { run(program: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult> };
  readonly net?: { fetch(url: string, request?: HttpRequest): Promise<HttpResponse> };
  readonly env?: { get(name: string): Promise<string | undefined> };
  readonly notify?: OsNotify;
  readonly clipboard?: { readText?(): Promise<string>; writeText?(text: string): Promise<void> };
  readonly secrets: OsSecrets;
  readonly security?: { setRoots(paths: readonly string[]): Promise<void> };
  readonly ui?: OsUi;
  /** Слушает только 127.0.0.1; запрос с чужим Host или с Origin (страница в браузере) до обработчика не доходит. Выгрузка плагина закрывает его серверы. */
  readonly serve?: { http(handler: (request: ServeRequest) => ServeResponse | Promise<ServeResponse>): Promise<HttpServer> };
  /** Открыть путь или URL программой ОС; исполняемый файл не открывается - это был бы запуск в обход `process`. */
  readonly shell?: { openPath?(path: string): Promise<void>; openExternal?(url: string): Promise<void> };
  /** Права не нужно: выбор человека сам становится областью `granted` и хранится в state воркспейса. */
  readonly dialog: OsDialog;
}

export interface OpenDialogOptions {
  readonly title?: string;
  readonly directory?: boolean;
  readonly multiple?: boolean;
}

export interface OsDialog {
  /** Отмена - пустой список; окно закрыто чужим замком - `Unavailable`. */
  open(options?: OpenDialogOptions): Promise<string[]>;
}

/** Замок окна: чужие виды скрыты и `inert`, виден только `ui.overlay` владельца, работают только его сочетания и диалоги. Главные части работают дальше. */
export interface OsUi {
  /** `hideNotifications` прячет текст уведомлений и имя воркспейса в заголовке окна. Повторный вызов владельца меняет только его. Хост владельца упал - окно остаётся закрытым до его возвращения. */
  lock(options?: { readonly hideNotifications?: boolean }): Promise<UiLock>;
}

export interface UiLock {
  /** Снимает только свой замок; два замка - окно откроется, когда сняты оба. */
  release(): Promise<void>;
}

export interface SecretValue {
  readonly value: string;
  /** Аренда источника: после этого значение надо спросить заново. */
  readonly expiresAt?: number;
}

/** Ссылка на секрет в `config`: без схемы - своё хранилище ядра, со схемой - источник секретов. */
export interface SecretRef {
  readonly $secret: string;
}

export interface PluginSecrets {
  resolve(ref: string | SecretRef): Promise<SecretValue>;
}
