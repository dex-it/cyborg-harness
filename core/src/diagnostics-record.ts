import type { LogLevel } from '@cyborg-harness/contracts';
import type { JournalEntry } from './kernel-types.ts';
import { entryLevel, isLifecycleEntry } from './status.ts';
import type { TraceRecord } from './trace-record.ts';
import { isRecord } from './wire.ts';

/*
 * Запись диагностики (K-30, FR-CH-4011, 4012): одна форма для журнала ядра, строк плагинов (K-29) и трассы (K-28). В файле это строка JSON:
 * номер запуска `r` (время его начала, мс) и запись. Значений секретов в записях нет, содержимого аргументов - пока приложение не запущено с `--trace-args` (FR-CH-4004, FR-CH-4018, K-33):
 * их несут источники, хранение ничего к ним не добавляет.
 */

export type DiagnosticRecord =
  /** Начало запуска приложения: по нему отличают прошлый запуск от текущего, даже если прошлый ничего не записал, кроме жизненного цикла. */
  | { readonly src: 'run'; readonly at: number; readonly app?: string }
  | { readonly src: 'journal'; readonly at: number; readonly entry: JournalEntry }
  /** Строка плагина или хоста, как она ушла в `onLog`: уже без секретов и не длиннее предела. */
  | { readonly src: 'log'; readonly at: number; readonly pluginId: string; readonly level: LogLevel; readonly text: string }
  | { readonly src: 'trace'; readonly at: number; readonly record: TraceRecord }
  /** Запись не поместилась в предел строки файла и заменена меткой: размер сериализованной записи и её источник. */
  | { readonly src: 'oversize'; readonly at: number; readonly from: 'journal' | 'log' | 'trace'; readonly bytes: number };

/** Запись, прочитанная из файла: `run` - запуск, в котором она сделана. */
export interface StoredRecord {
  readonly run: number;
  readonly record: DiagnosticRecord;
}

/** Предел одной строки файла, байт: больше - запись заменяется меткой `oversize`, чтобы файл не вышел за предел размера из-за одной записи. */
export const MAX_LINE_BYTES = 64 * 1024;

const SOURCES = new Set<string>(['run', 'journal', 'log', 'trace', 'oversize']);

/** Строка файла для записи; длиннее `maxBytes` (по умолчанию `MAX_LINE_BYTES`) - метка вместо неё. */
export function encodeRecord(run: number, record: DiagnosticRecord, maxBytes = MAX_LINE_BYTES): string {
  const line = JSON.stringify({ r: run, ...record });
  const bytes = Buffer.byteLength(line);
  if (bytes <= maxBytes || record.src === 'oversize') return line;
  return JSON.stringify({ r: run, src: 'oversize', at: record.at, from: record.src === 'run' ? 'log' : record.src, bytes });
}

/** Запись из строки файла; строка, которую не разобрать или у которой не та форма, - `undefined` (файл могли править руками или оборвать запись на полуслове). */
export function decodeRecord(line: string): StoredRecord | undefined {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || typeof data.r !== 'number' || typeof data.at !== 'number' || typeof data.src !== 'string' || !SOURCES.has(data.src)) return undefined;
  const { r, ...record } = data;
  const ok =
    (data.src === 'journal' && isRecord(data.entry) && typeof data.entry.kind === 'string') ||
    (data.src === 'trace' && isRecord(data.record) && typeof data.record.kind === 'string') ||
    (data.src === 'log' && typeof data.pluginId === 'string' && typeof data.text === 'string' && typeof data.level === 'string') ||
    (data.src === 'oversize' && typeof data.bytes === 'number') ||
    data.src === 'run';
  // Форма проверена выше по полям источника: тип записи сужается здесь, а не на каждом чтении.
  return ok ? { run: r, record: record as unknown as DiagnosticRecord } : undefined;
}

/** Плагин, чей поток запись: по нему кольцо считает шум. Запись без плагина (человек, хост, ядро) - владелец `''`. */
export function ownerOf(record: DiagnosticRecord): string {
  switch (record.src) {
    case 'journal':
      return record.entry.pluginId ?? '';
    case 'log':
      return record.pluginId;
    case 'trace': {
      const t = record.record;
      if (t.kind !== 'operation') return t.pluginId;
      const caller = /^(?:plugin|view):(.+)$/.exec(t.caller)?.[1];
      return caller ?? t.callee ?? '';
    }
    default:
      return '';
  }
}

/** Запись, из которой выводится состояние плагина (жизненный цикл журнала): кольцо её не вытесняет, пока есть что вытеснить (FR-CH-4011). */
export const isKept = (record: DiagnosticRecord): boolean => record.src === 'journal' && isLifecycleEntry(record.entry);

/** Запись с ошибкой или жизненного цикла: в файл сразу, остальное - пакетами (вопрос 2 SRS фичи 04). */
export function isUrgent(record: DiagnosticRecord): boolean {
  switch (record.src) {
    case 'journal':
      return isLifecycleEntry(record.entry) || entryLevel(record.entry) === 'error';
    case 'log':
      return record.level === 'error';
    case 'trace':
      return record.record.kind === 'operation' && record.record.outcome === 'error';
    default:
      return false;
  }
}

const FAILURES = new Set<JournalEntry['kind']>(['failed', 'switched-off', 'host-down', 'host-abandoned']);

/** Сбой плагина или его хоста: запись, чью причину окно показывает после перезапуска (FR-CH-4013). */
export const isFailure = (entry: JournalEntry): boolean => FAILURES.has(entry.kind);
