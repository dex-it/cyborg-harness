import type { CoreErrorCode } from '@cyborg-harness/contracts';

/*
 * Записи трассы операций (K-28, FR-CH-4001…4008). Поля и значения - английские имена в нотации кода: поля camelCase, значения закрытых наборов kebab-case.
 * Содержимого результатов в записях нет никогда, содержимого аргументов - пока приложение не запущено с `--trace-args` (K-33): иначе только размеры в байтах (FR-CH-4004, NFR-CH-4002).
 */

/**
 * Граница, которую прошла операция (модель угроз, раздел 4): `host` - Г1, `bridge` - Г2, `contract` - Г3 (член контракта, команда, событие),
 * `os` - Г4 (шлюз `ctx.os`), `net` - Г5 (сеть через шлюз). Последняя в списке - та, где операция кончилась.
 */
export type Boundary = 'host' | 'bridge' | 'contract' | 'os' | 'net';

/**
 * Одна запись на операцию, сколько бы границ она ни прошла. Участники - `род:имя`: `plugin:jira`, `view:jira`, `host:builtin` (хост, чей плагин не определён),
 * `user` (человек: палитра, сочетание, меню, клик по уведомлению), `command:jira.create`, `contract:sessions.current@1#active`, `os:net.fetch`, `bridge:view.state`.
 */
export interface OperationRecord {
  readonly kind: 'operation';
  /** Порядковый номер записи в запуске ядра. */
  readonly id: number;
  /** Номер цепочки: у первой операции цепочки равен её `id`; порождённые ею команды, члены контрактов и вызовы `ctx.os` несут тот же (FR-CH-4002). */
  readonly chain: number;
  /** Начало операции, мс от эпохи. */
  readonly at: number;
  readonly caller: string;
  /** Хост вызывающего плагина; в общем хосте имя называет отметка хоста, и запись это диагностика, а не доказательство (FR-CH-4006). */
  readonly hostId?: string;
  readonly target: string;
  /** Плагин-адресат члена контракта или команды. */
  readonly callee?: string;
  readonly boundaries: readonly Boundary[];
  /** Право манифеста, которым допущена операция (`fs.read`, `process`, `net`, ...). */
  readonly right?: string;
  readonly durationMs: number;
  readonly argsBytes: number;
  /**
   * Аргументы вызова текстом (JSON-подобным): член контракта, команда, вызов `ctx.os`, сообщение хоста, событие. Есть только при `LoadOptions.traceArgs`
   * (флаг запуска `--trace-args`; из файлов настроек его включить нельзя). Значения секретов, прошедшие через шлюз, заменены на `[секрет]`,
   * длиннее `LIMITS.traceArgsBytes` отрезано с пометкой `[обрезано: всего N Б]`.
   */
  readonly args?: string;
  readonly resultBytes: number;
  readonly outcome: 'ok' | 'error';
  /** Код отказа ядра, как его видит вызывающий. */
  readonly code?: CoreErrorCode;
  /** Причина отказа словами на английском: по коду, без текста исключения (в нём бывают пути и значения аргументов). */
  readonly reason?: string;
}

/** Частый поток за интервал одной записью, а не записью на сообщение (FR-CH-4005). */
export interface StreamRecord {
  readonly kind: 'stream';
  /** `pty-output` - вывод pty плагину, `fs-watch` - события `fs.watch`. */
  readonly stream: 'pty-output' | 'fs-watch';
  readonly pluginId: string;
  readonly hostId?: string;
  /** Начало интервала, мс от эпохи. */
  readonly at: number;
  readonly intervalMs: number;
  readonly messages: number;
  readonly bytes: number;
}

/** Завершение программы, запущенной по праву `process` или `pty` (FR-CH-4007); что она делала внутри, ядро не видит. */
export interface ExitRecord {
  readonly kind: 'exit';
  readonly id: number;
  /** Цепочка запуска: есть у `process.run`, чей выход известен к концу операции; у pty выход приходит позже и цепочки не несёт. */
  readonly chain?: number;
  readonly at: number;
  readonly pluginId: string;
  readonly hostId?: string;
  readonly target: 'os:process.run' | 'os:pty.spawn';
  readonly right: 'process' | 'pty';
  readonly code: number | null;
  readonly signal?: string | number;
}

export type TraceRecord = OperationRecord | StreamRecord | ExitRecord;

/** Причина отказа по коду: фиксированный английский текст, чтобы запись не несла ни путей, ни аргументов из сообщения исключения. */
export const REASONS: Readonly<Record<CoreErrorCode, string>> = {
  NotDeclared: 'not declared in the manifest',
  AlreadyProvided: 'already provided',
  Unavailable: 'unavailable',
  NotCloneable: 'value cannot be cloned',
  Invalid: 'invalid arguments',
  CommandNotFound: 'command not found',
  CommandConflict: 'command conflict',
  HostGone: 'host gone',
  Timeout: 'timed out',
  Cancelled: 'cancelled',
  Remote: 'remote error',
  PermissionDenied: 'permission denied',
  NotFound: 'not found',
};
