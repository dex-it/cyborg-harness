/**
 * Необработанные ошибки главного процесса: штатное окно Electron «Uncaught Exception» исчезает раньше, чем текст успевают прочитать и скопировать,
 * и следа не оставляет. Здесь чистая логика без Electron: запись в `<userData>/logs/main-errors.log`, дубль в stderr и решение, показывать ли окно
 * (не чаще раза за `NOTICE_INTERVAL_MS`: лавина ошибок не должна завалить экран окнами). Само окно и подписка на события процесса - в `main.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

export type ErrorKind = 'uncaughtException' | 'unhandledRejection';

/** Что показать человеку: полный текст записи и файл журнала, куда он же записан. */
export interface ErrorNotice {
  readonly kind: ErrorKind;
  readonly text: string;
  readonly logFile: string;
}

export const NOTICE_INTERVAL_MS = 5000;

/** Текст ошибки целиком: стек (или имя и сообщение), цепочка `cause`; не-ошибки (строка, объект) не теряются. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const own = error.stack ?? `${error.name}: ${error.message}`;
    return error.cause === undefined ? own : `${own}\nCaused by: ${describeError(error.cause)}`;
  }
  if (typeof error === 'string') return error;
  try {
    // Для undefined и функций JSON.stringify возвращает undefined, хотя тип обещает строку.
    const stringify: (value: unknown, replacer: null, space: number) => string | undefined = JSON.stringify;
    return stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Запись журнала: время ISO, вид события, текст; записи разделены пустой строкой. */
export function formatErrorEntry(kind: ErrorKind, error: unknown, at: Date): string {
  return `[${at.toISOString()}] ${kind}\n${describeError(error)}\n\n`;
}

export interface ErrorReporterOptions {
  readonly logFile: string;
  readonly notify: (notice: ErrorNotice) => void;
  readonly now?: () => number;
  readonly append?: (file: string, text: string) => void;
  readonly stderr?: (text: string) => void;
}

function appendCreatingDir(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

/**
 * Обработчик не должен сам ронять процесс и терять ошибку: сбой записи журнала и сбой окна гасятся (причина уходит в stderr),
 * а ошибка, из-за которой всё началось, остаётся в stderr и в окне.
 */
export function createErrorReporter(options: ErrorReporterOptions): { report: (kind: ErrorKind, error: unknown) => void } {
  const now = options.now ?? Date.now;
  const append = options.append ?? appendCreatingDir;
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));
  let lastNotice: number | undefined;
  return {
    report(kind, error) {
      const at = now();
      const entry = formatErrorEntry(kind, error, new Date(at));
      let text = entry;
      try {
        append(options.logFile, entry);
      } catch (writeError) {
        text += `(журнал не записан: ${describeError(writeError)})\n`;
      }
      try {
        stderr(text);
      } catch {
        // stderr без читателя: ошибка осталась в журнале и в окне
      }
      if (lastNotice !== undefined && at - lastNotice < NOTICE_INTERVAL_MS) return;
      lastNotice = at;
      try {
        options.notify({ kind, text, logFile: options.logFile });
      } catch (noticeError) {
        try {
          stderr(`окно ошибки не открылось: ${describeError(noticeError)}\n`);
        } catch {
          // см. выше
        }
      }
    },
  };
}
