import type { Disposable } from './plugin.ts';

/** Программа или программа с первыми аргументами; `env` - имена переменных, которые плагин может ей передать: точное имя или маска `ПРЕФИКС_*` для номерных: хвост после префикса - только десятичные цифры (`GIT_CONFIG_KEY_*` покрывает `GIT_CONFIG_KEY_0`, `GIT_CONFIG_KEY_12`, но не `GIT_CONFIG_KEY_X`; `GIT_*` не покрывает `GIT_SSH_COMMAND`). */
export type ProgramRule = string | { readonly program: string; readonly args: readonly string[]; readonly env?: readonly string[] };

/** Права главной части плагина: что ядро пропустит через `ctx.os` (SAD §3.7). Нет права - нет члена в `ctx.os`. */
export interface PluginPermissions {
  /** Области путей: `workspace`, `plugin-data`, `plugin-temp`, `granted` (выбор человека в `dialog`), абсолютный путь (каталог с поддеревом, `~` - домашний) или маска: `*` - часть имени, `**` - любые каталоги. */
  readonly 'fs.read'?: readonly string[];
  /** Те же области и `workspace.git` - корни воркспейса вместе с записью в `.git`. */
  readonly 'fs.write'?: readonly string[];
  /** Открыть в системе: области путей, как у `fs.read`, `any` - любой существующий документ или каталог, и схемы URL с двоеточием (`https:`, `mailto:`). */
  readonly shell?: readonly string[];
  /** Программы, которые плагин запускает через `ctx.os.process`: имя или правило `{ program, args, env? }` с закреплёнными первыми аргументами. Даёт программе все права пользователя ОС. */
  readonly process?: readonly ProgramRule[];
  /** Программы в псевдотерминале; правило той же формы, что у `process`. */
  readonly pty?: readonly ProgramRule[];
  /** Запуски, которые поставщик описывает потребителю (`cyborg.agent`); члена в `ctx.os` не даёт, pty потребителя с `describedBy` сверяется и с ними. */
  readonly launch?: readonly ProgramRule[];
  /** Хосты HTTP; `config:<поле>` - хост из своего раздела config. */
  readonly net?: readonly string[];
  /** Имена переменных окружения, которые плагин читает через `ctx.os.env`. */
  readonly env?: readonly string[];
  /** Системные уведомления (`ctx.os.notify`). */
  readonly notify?: boolean;
  /** Буфер обмена: `read`, `write` или оба. */
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

/** Запись каталога. */
export interface DirEntry {
  /** Имя без пути. */
  readonly name: string;
  /** Что это: файл, каталог, ссылка или другое. */
  readonly kind: 'file' | 'dir' | 'link' | 'other';
}

/** Сведения о файле или каталоге. */
export interface FileStat {
  /** Что это: файл, каталог или другое. */
  readonly kind: 'file' | 'dir' | 'other';
  /** Размер в байтах. */
  readonly size: number;
  /** Время последней правки, мс от начала эпохи. */
  readonly mtimeMs: number;
}

/** Кусок файла, прочитанный `readSlice`. */
export interface FileSlice {
  /** Прочитанный текст. */
  readonly text: string;
  /** Сколько байт файла покрывает `text`: незаконченный символ UTF-8 на конце куска не входит - на столько сдвинуть `offset`. */
  readonly bytes: number;
  /** Размер всего файла в байтах. */
  readonly size: number;
}

/** Итог запущенной программы. */
export interface ProcessResult {
  /** Код выхода; `null`, если программу остановил сигнал. */
  readonly code: number | null;
  /** Сигнал, остановивший программу, или `null`. */
  readonly signal: string | null;
  /** Вывод до предела; обрезанный по `truncated` на границе символа. */
  readonly stdout: string;
  /** Вывод ошибок с теми же пределами, что у `stdout`. */
  readonly stderr: string;
  /** Вывод `stdout` или `stderr` дошёл до предела (`maxOutputBytes`, по умолчанию 16 МиБ): программа остановлена (`SIGTERM`, через 2 с глухой к нему - `SIGKILL`), а в ответе только прочитанное. Ошибка это или неполные данные, решает плагин: трекер отказывает («ответ больше N»), поиск берёт совпадения из прочитанного. */
  readonly truncated: boolean;
}

// Пакет собирается без lib DOM и @types/node (потребитель может не ставить ни то, ни другое): объявляем минимум `AbortSignal`.
// Слияние с настоящим `AbortSignal` из DOM или Node безвредно: поле то же.
declare global {
  interface AbortSignal {
    readonly aborted: boolean;
  }
}

/** Параметры запуска программы. */
export interface ProcessOptions {
  /** Рабочий каталог; должен лежать в области, доступной плагину. */
  readonly cwd?: string;
  /** Только имена из `env` правила `process`; база - PATH, HOME, локаль. Значения - данные, а не ссылки `$secret`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Текст, который подаётся программе на стандартный ввод. */
  readonly input?: string;
  /** Срок программы, мс; истёк - `SIGTERM` всей группе, в ответе `signal: 'SIGTERM'`; не остановилась за 2 с (глушит сигнал) - `SIGKILL`, `signal: 'SIGKILL'`. */
  readonly timeoutMs?: number;
  /** Предел вывода, байт на `stdout` и на `stderr` отдельно: целое от 1 до 64 МиБ, по умолчанию 16 МиБ. Превышение не ошибка вызова, а `truncated` в ответе. */
  readonly maxOutputBytes?: number;
  /** Отмена: сигнал сработал - программе и её группе `SIGTERM` (глухой к нему - `SIGKILL` через 2 с, как по `timeoutMs`), вызов отклоняется `Cancelled`. Сработал до вызова - программа не запускается. */
  readonly signal?: AbortSignal;
}

/** Параметры запроса `ctx.os.net.fetch`. */
export interface HttpRequest {
  /** Метод HTTP; по умолчанию `GET`. */
  readonly method?: string;
  /** Заголовки запроса. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Тело запроса, текст. */
  readonly body?: string;
  /** Срок всего запроса вместе с телом, мс; по умолчанию 30 с, дольше - `Timeout`. Тело ответа больше 16 МиБ - `Remote`. */
  readonly timeoutMs?: number;
}

/** Ответ `ctx.os.net.fetch`. */
export interface HttpResponse {
  /** Код ответа HTTP. */
  readonly status: number;
  /** Заголовки ответа, имена в нижнем регистре. */
  readonly headers: Readonly<Record<string, string>>;
  /** Тело ответа, текст. */
  readonly body: string;
}

/** Запрос к серверу плагина: имена заголовков в нижнем регистре, тело - текст до 1 МиБ. */
export interface ServeRequest {
  /** Метод HTTP. */
  readonly method: string;
  /** Путь с запросом, как в первой строке HTTP: `/mcp?x=1`. */
  readonly path: string;
  /** Заголовки запроса, имена в нижнем регистре. */
  readonly headers: Readonly<Record<string, string>>;
  /** Тело запроса, текст до 1 МиБ. */
  readonly body: string;
}

/** Ответ обработчика; не ответил за 30 с - клиент получит 504, чужая форма - 502. */
export interface ServeResponse {
  /** Код ответа HTTP. */
  readonly status: number;
  /** Заголовки ответа. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Тело ответа, текст. */
  readonly body?: string;
}

/** Запущенный сервер плагина. */
export interface HttpServer {
  /** `http://127.0.0.1:<порт>`; порт выбирает ОС. */
  readonly url: string;
  /** Останавливает сервер. */
  dispose(): void;
}

/** Параметры слежения за файлами. */
export interface WatchOptions {
  /**
   * Следить за всем деревом под каталогом, а не за его детьми. Для файла - `Invalid`.
   * Обход дерева и разбор событий ОС ядро выполняет вне главного потока приложения (отдельный поток `worker_threads`), главному потоку приходят готовые пачки имён: checkout на тысячи каталогов не замораживает окно.
   * `watch` возвращается, когда дерево обойдено и слежение поставлено, - в большом дереве это дольше, чем без `recursive`. Закрытие слежения (`dispose`, выгрузка плагина, `onClose`) останавливает и этот поток.
   * Отказ ОС по числу слежений (Linux: `fs.inotify.max_user_watches`) по-прежнему `Unavailable` с названием предела; поток, который не запустился или упал, - `Unavailable`, а если упал позже - `onClose` с причиной.
   */
  readonly recursive?: boolean;
}

/** Файлы: без права - только свои каталоги `paths`; чтение шире - по `fs.read`, запись - по `fs.write`. Путь вне области - `PermissionDenied`, никогда `NotFound`; нет файла или каталога внутри области в `readText`, `readSlice`, `list`, `stat`, `watch`, `realpath` - `NotFound` (проверка существования - `stat` и ловля `NotFound`); `list` существующего файла - `Invalid`. Ни код, ни текст ошибки ОС не выдают путь вне области, названный плагином: ошибка раскрытия пути (`ENOTDIR`, `ELOOP`, `EACCES`) там тоже `PermissionDenied`. Путь через ссылку внутри области - путь внутри области, и ответ зависит от цели ссылки: цель вне области есть - `PermissionDenied`, ссылка висячая - `NotFound` (или ошибка операции), цель под закрытым снаружи каталогом - ошибка самой операции; ссылку создаёт человек или другая программа, плагин с `fs` её создать не может. */
export interface OsFs {
  /** Читает файл целиком как текст UTF-8. */
  readText(path: string): Promise<string>;
  /** Список записей каталога. */
  list(dir: string): Promise<DirEntry[]>;
  /** Сведения о файле или каталоге; нет пути внутри области - `NotFound`. */
  stat(path: string): Promise<FileStat>;
  /** Настоящий путь: ссылки раскрыты, как `realpath` ОС. Нужен, чтобы сверять пути по имени (ключи `~/.claude.json`, корни проектов): `/tmp/x` и `/private/tmp/x` - один каталог. Ссылка наружу области - `PermissionDenied`, нет пути - `NotFound`. */
  realpath(path: string): Promise<string>;
  /** Кусок файла с байта `offset`, от 4 байт до 1 МиБ: длинный журнал читается частями, а не целиком. */
  readSlice(path: string, offset: number, maxBytes: number): Promise<FileSlice>;
  /** Изменения файла или каталога по праву чтения; у каталога - имена изменённых, события склеиваются за 50 мс. С `options.recursive` слежение идёт за всем деревом под каталогом одной записью лимита 64, а имя в `listener` - путь изменённого относительно каталога с `/` в роли разделителя (`src/a/b.ts`); имена мест, закрытых плагину и при обычном чтении (каталоги других плагинов, данные приложения, защищённые пути), не приходят. Ссылки внутри дерева не раскрываются. Файл с `recursive` - `Invalid`. Рекурсивное слежение идёт вне главного потока приложения (#211), события приходят пачками. На Linux Node ставит inotify на каждый каталог внутри, и в большом дереве может не хватить `fs.inotify.max_user_watches`: `watch` отказывает `Unavailable` с названием предела, следите за каталогами по отдельности. Удалён наблюдаемый каталог (в том числе с `recursive`) или заменён каталогом с другим inode - `onClose` с причиной; ФС вправе отдать новому каталогу inode удалённого, тогда замена не замечается и событий больше не будет. Наблюдение файла переживает подмену файла через `rename` (`writeText`, редакторы с атомарной записью), в том числе когда старый файл держит открытым другой процесс (`tail -f`): событие приходит на каждую запись. Ядро закрыло наблюдение само (ошибка ОС, путь ушёл из прав, файл удалён, на его месте каталог или ссылка) - `onClose` с причиной. События о правках в первые миллисекунды после возврата `watch` не обещаны (на macOS FSEvents начинает доставку позже возврата вызова), поэтому плагин, которому нужно состояние сейчас, читает его сам после `watch`, а событие использует как повод перечитать. Имена в `listener` - то, о чём сообщила ОС: это не только дети каталога (на macOS в свежесозданном каталоге приходит и имя самого каталога), по ним состояние не выводят. */
  watch(path: string, listener: (names: readonly string[]) => void, onClose?: (reason: string) => void, options?: WatchOptions): Promise<Disposable>;
  /** Атомарно: текст пишется во временный файл рядом (`<файл>.<hex>.tmp`) и переименовывается, читатель и оборванная запись видят прежний файл или новый целиком; режим существующего файла сохраняется; файл без права записи (0444) не заменяется - `EACCES`, как при записи на месте, так что `chmod a-w` защищает файл. Без `fsync`: падение процесса не страшно, потеря питания - не гарантия. Наблюдатель каталога видит имя временного файла. Временному файлу нужно право записи на его имя: если `fs.write` называет один файл или маску под имя (`*.json`), либо каталог цели закрыт для создания файлов, запись идёт на месте, без защиты от обрыва, зато ничего вне права не создаётся. Не обычный файл (каталог, ссылка, FIFO) - `Invalid`. */
  writeText(path: string, text: string): Promise<void>;
  /** Создаёт каталог, в том числе недостающие родительские. */
  mkdir(path: string): Promise<void>;
  /** Удаляет файл или каталог с содержимым; пути, которого нет, - не ошибка. */
  remove(path: string): Promise<void>;
}

/** Своё хранилище секретов ядра: ключи видны только своему плагину; без шифрования ОС - `Unavailable`. */
export interface OsSecrets {
  /** Значение секрета по ключу своего плагина; нет - `undefined`. */
  get(key: string): Promise<string | undefined>;
  /** Сохраняет секрет в хранилище ядра. */
  set(key: string, value: string): Promise<void>;
  /** Удаляет секрет. */
  delete(key: string): Promise<void>;
}

/** Параметры запуска программы в псевдотерминале. */
export interface PtySpawnOptions {
  /** Программа; должна подходить под правило `pty` манифеста. */
  readonly program: string;
  /** Аргументы программы. */
  readonly args?: readonly string[];
  /** Рабочий каталог. */
  readonly cwd?: string;
  /** Только имена из `env` правила `pty`; база - PATH, HOME, локаль. */
  readonly env?: Readonly<Record<string, string>>;
  /** Число столбцов. */
  readonly cols?: number;
  /** Число строк. */
  readonly rows?: number;
  /** Пережить перезапуск хоста: процесс ждёт, пока владелец вернётся через `attach`. */
  readonly persist?: boolean;
  /** Плагин, описавший запуск: ядро пропустит его, только если описание подходит и под правило `launch` этого плагина. */
  readonly describedBy?: string;
}

/** Завершение процесса в терминале. */
export interface PtyExit {
  /** Код выхода; `-1`, если хост потерял процесс. */
  readonly code: number;
  /** Номер сигнала, если процесс остановлен им. */
  readonly signal?: number;
}

/** Сведения о процессе в терминале. */
export interface PtyInfo {
  /** Идентификатор терминала. */
  readonly id: string;
  /** Номер процесса в ОС. */
  readonly pid: number;
  /** Запущенная программа. */
  readonly program: string;
  /** Аргументы запуска. */
  readonly args: readonly string[];
  /** Процесс переживает перезапуск хоста. */
  readonly persist: boolean;
  /** Есть, если процесс завершился, пока владельца не было. */
  readonly exit?: PtyExit;
}

/** Терминал, которым владеет плагин. */
export interface PtyHandle extends PtyInfo {
  /** Хвост вывода до `attach`; у только что запущенного пуст. Может начинаться посреди escape-последовательности. */
  readonly backlog: string;
  /** Слушатель вывода терминала. */
  onData(listener: (chunk: string) => void): Disposable;
  /** Завершился до подписки - слушатель получит выход сразу. */
  onExit(listener: (exit: PtyExit) => void): Disposable;
  /** Ввод в терминал. */
  write(data: string): Promise<void>;
  /** Размер терминала в столбцах и строках. */
  resize(cols: number, rows: number): Promise<void>;
  /** Посылает сигнал процессу; без аргумента процесс завершается. */
  kill(signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'): Promise<void>;
  /** Одноразовый билет для своего UI (`ctx.terminal.open` в виде): живёт 30 с, чужой плагин его не откроет. */
  share(): Promise<PtyTicket>;
}

/** Строка-билет: главная часть передаёт её своему виду, например ответом своей команды. */
export type PtyTicket = string;

/** Процесс держит ядро: он переживает хост плагина, если просили `persist`. */
export interface OsPty {
  /** Запускает программу в терминале по правилу `pty` манифеста. */
  spawn(options: PtySpawnOptions): Promise<PtyHandle>;
  /** Только свои pty. */
  list(): Promise<PtyInfo[]>;
  /** Свой pty без владельца: после перезапуска хоста или «Оставить работать». Брать при активации: с неё идёт льготный срок ядра, после него процесс завершён и ответ - `NotFound`. */
  attach(id: string): Promise<PtyHandle>;
}

/** Клик по уведомлению: своя команда из манифеста, аргументы сверяются её схемой. Команда, а не колбэк: клик переживёт перезапуск хоста. */
export interface NotifyClick {
  /** Своя команда из манифеста. */
  readonly command: string;
  /** Аргументы команды. */
  readonly args?: readonly unknown[];
}

/** Параметры уведомления. */
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

/** Доступ плагина к ОС через шлюз ядра; члены, на которые нет права в манифесте, отсутствуют. */
export interface PluginOs {
  /**
   * Свои каталоги: данные и временный; читать и писать в них можно без права. Каталоги общие для всех процессов приложения с этим `userData`
   * (несколько воркспейсов - несколько процессов, K-20): `fs.writeText` пишет файл целиком через временный файл и `rename`, поэтому соседний процесс видит прежний файл или новый, но не недописанный; потерю обновления при цикле «прочитал - изменил - записал» двух процессов ядро не снимает (замка для плагинов нет), её плагин исключает сам (отдельные файлы на процесс или своя блокировка).
   */
  readonly paths: {
    /** Каталог данных плагина: переживает перезапуск, общий для процессов приложения с этим `userData`. */
    readonly data: string;
    /** Временный каталог плагина. */
    readonly temp: string;
    /** Домашний каталог человека; читать в нём можно только то, что разрешило право `fs.read`. */
    readonly home: string;
  };
  /** Файлы. */
  readonly fs: OsFs;
  /** Терминалы; есть при праве `pty`. */
  readonly pty?: OsPty;
  /** Программы нет в системе (или нет `cwd`) - `NotFound`; ненулевой код выхода ошибкой не считается и приходит в `ProcessResult.code`. Одновременных программ у плагина не больше 16, сверх - `Invalid`: очереди у ядра нет, пул ведёт плагин. */
  readonly process?: {
    /** Запускает программу без оболочки, ждёт завершения и возвращает вывод и код выхода. Программа и первые аргументы должны подходить под правило `process` манифеста. */
    run(program: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult>;
  };
  /** Сеть; есть при праве `net`. */
  readonly net?: {
    /** HTTP-запрос к хосту из права `net` (`config:<поле>` - хост из своего раздела `config`). Метод по умолчанию `GET`; срок и предел тела - в `HttpRequest`. */
    fetch(url: string, request?: HttpRequest): Promise<HttpResponse>;
  };
  /** Переменные окружения; есть при праве `env`. */
  readonly env?: {
    /** Значение переменной окружения, названной в праве `env`; переменной нет - `undefined`. */
    get(name: string): Promise<string | undefined>;
  };
  /** Системные уведомления; есть при праве `notify`. */
  readonly notify?: OsNotify;
  /** Буфер обмена; члены есть по праву `clipboard`. */
  readonly clipboard?: {
    /** Читает текст из буфера; есть при праве `clipboard: ["read"]`. */
    readText?(): Promise<string>;
    /** Пишет текст в буфер; есть при праве `clipboard: ["write"]`. */
    writeText?(text: string): Promise<void>;
  };
  /** Своё хранилище секретов ядра; права не нужно. */
  readonly secrets: OsSecrets;
  /** Настройки безопасности; есть при праве `security.roots`. */
  readonly security?: {
    /** Задаёт корни проектов: область `workspace` для всех плагинов. Корни, названные только в файле воркспейса, подтверждает человек. */
    setRoots(paths: readonly string[]): Promise<void>;
  };
  /** Замок окна; есть при праве `ui.lock`. */
  readonly ui?: OsUi;
  /** Слушает только 127.0.0.1; запрос с чужим Host или с Origin (страница в браузере) до обработчика не доходит. Выгрузка плагина закрывает его серверы. */
  readonly serve?: {
    /** Запускает сервер HTTP на 127.0.0.1 с портом от ОС; обработчик получает запрос и отвечает (не ответил за 30 с - клиент получит 504). */
    http(handler: (request: ServeRequest) => ServeResponse | Promise<ServeResponse>): Promise<HttpServer>;
  };
  /** Открыть путь или URL программой ОС; исполняемый файл не открывается - это был бы запуск в обход `process`. */
  readonly shell?: {
    /** Открывает документ или каталог программой ОС по умолчанию; путь должен лежать в области права `shell`. */
    openPath?(path: string): Promise<void>;
    /** Открывает URL, схема которого названа в праве `shell` (`https:`, `mailto:`). */
    openExternal?(url: string): Promise<void>;
  };
  /** Права не нужно: выбор человека сам становится областью `granted` и хранится в state воркспейса. */
  readonly dialog: OsDialog;
}

/** Параметры диалога выбора пути. */
export interface OpenDialogOptions {
  /** Заголовок диалога. */
  readonly title?: string;
  /** Выбирать каталоги. */
  readonly directory?: boolean;
  /** Разрешить несколько путей. */
  readonly multiple?: boolean;
}

/** Диалог выбора пути, который показывает ядро. */
export interface OsDialog {
  /** Отмена - пустой список; окно закрыто чужим замком - `Unavailable`. */
  open(options?: OpenDialogOptions): Promise<string[]>;
}

/** Замок окна: чужие виды скрыты и `inert`, виден только `ui.overlay` владельца, работают только его сочетания и диалоги. Главные части работают дальше. */
export interface OsUi {
  /** `hideNotifications` прячет текст уведомлений и имя воркспейса в заголовке окна. Повторный вызов владельца меняет только его. Хост владельца упал - окно остаётся закрытым до его возвращения. */
  lock(options?: { readonly hideNotifications?: boolean }): Promise<UiLock>;
}

/** Замок, взятый плагином. */
export interface UiLock {
  /** Снимает только свой замок; два замка - окно откроется, когда сняты оба. */
  release(): Promise<void>;
}

/** Раскрытое значение секрета. */
export interface SecretValue {
  /** Значение. */
  readonly value: string;
  /** Аренда источника: после этого значение надо спросить заново. */
  readonly expiresAt?: number;
}

/** Ссылка на секрет в `config`: без схемы - своё хранилище ядра, со схемой - источник секретов. */
export interface SecretRef {
  /** Ключ секрета: без схемы - свой ключ в хранилище ядра, со схемой - ссылка на внешний источник. */
  readonly $secret: string;
}

/** Раскрытие ссылок на секреты. */
export interface PluginSecrets {
  /** Раскрывает ссылку: ключ (строка) или `{ "$secret": "..." }`. Значение не попадает в журнал. */
  resolve(ref: string | SecretRef): Promise<SecretValue>;
}
