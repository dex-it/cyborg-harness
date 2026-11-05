import type { Disposable } from './plugin.ts';

/** Программа или программа с первыми аргументами; `env` - имена переменных, которые плагин может ей передать. */
export type ProgramRule = string | { readonly program: string; readonly args: readonly string[]; readonly env?: readonly string[] };

/** Права главной части плагина: что ядро пропустит через `ctx.os` (SAD2 §3.7). Нет права - нет члена в `ctx.os`. */
export interface PluginPermissions {
  /** Области путей: `workspace`, `plugin-data`, `plugin-temp` или абсолютный путь (каталог с поддеревом, `~` - домашний). */
  readonly 'fs.read'?: readonly string[];
  readonly 'fs.write'?: readonly string[];
  readonly process?: readonly ProgramRule[];
  /** Программы в псевдотерминале; правило той же формы, что у `process`. */
  readonly pty?: readonly ProgramRule[];
  /** Хосты HTTP; `config:<поле>` - хост из своего раздела config. */
  readonly net?: readonly string[];
  readonly env?: readonly string[];
  readonly notify?: boolean;
  readonly clipboard?: readonly ('read' | 'write')[];
  /** Маски ссылок на секреты внешнего источника: `vault://kv/data/jira*`. */
  readonly 'secrets.ref'?: readonly string[];
  /** Задать корни проектов - область `workspace` для всех плагинов. */
  readonly 'security.roots'?: boolean;
  readonly 'ui.lock'?: boolean;
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

export interface ProcessResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd?: string;
  /** Только имена из `env` правила `process`; база - PATH, HOME, локаль. Значения - данные, а не ссылки `$secret`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export interface HttpRequest {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Файлы: без права - только свои каталоги `paths`; чтение шире - по `fs.read`, запись - по `fs.write`. Путь вне области - `PermissionDenied`, никогда `NotFound`. */
export interface OsFs {
  readText(path: string): Promise<string>;
  list(dir: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
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
  attach(id: string): Promise<PtyHandle>;
}

export interface PluginOs {
  /** Свои каталоги: данные и временный; читать и писать в них можно без права. */
  readonly paths: { readonly data: string; readonly temp: string };
  readonly fs: OsFs;
  readonly pty?: OsPty;
  readonly process?: { run(program: string, args: readonly string[], options?: ProcessOptions): Promise<ProcessResult> };
  readonly net?: { fetch(url: string, request?: HttpRequest): Promise<HttpResponse> };
  readonly env?: { get(name: string): Promise<string | undefined> };
  readonly notify?: { show(title: string, body?: string): Promise<void> };
  readonly clipboard?: { readText?(): Promise<string>; writeText?(text: string): Promise<void> };
  readonly secrets: OsSecrets;
  readonly security?: { setRoots(paths: readonly string[]): Promise<void> };
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
