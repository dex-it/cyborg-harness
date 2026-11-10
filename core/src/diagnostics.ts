import type { LogLevel } from '@cyborg-harness/contracts';
import { DiagnosticsRing } from './diagnostics-ring.ts';
import { decodeRecord, encodeRecord, isFailure, isKept, isUrgent, MAX_LINE_BYTES, ownerOf, type DiagnosticRecord, type StoredRecord } from './diagnostics-record.ts';
import { formatExport, type ExportContext } from './diagnostics-export.ts';
import type { ContractGraph } from './graph.ts';
import type { JournalEntry } from './kernel-types.ts';
import { describeEntry, entryPlugins } from './status.ts';
import type { TraceRecord } from './trace-record.ts';

/*
 * Хранение диагностики (K-30, FR-CH-4011…4016): журнал ядра, строки плагинов и трасса держатся кольцом в памяти и пишутся в файлы с ротацией по размеру;
 * после перезапуска хранилище отдаёт причину сбоя прошлого запуска, не трогая состояние плагинов, а по просьбе человека - выгрузку одним текстовым файлом.
 * Файловую систему хранилище получает снаружи (`DiagnosticsFs`): ядро не знает `userData`, а отказ диска проверяется подменой.
 * Ротация по размеру не отличает шум от причины сбоя, поэтому уходящий файл перед удалением отдаёт записи жизненного цикла журнала (в них `failed`, `switched-off`, `host-down`)
 * небольшому файлу `diagnostics.keep.log` со своим пределом: поток строк шумного плагина стирает файлы потока, а причину сбоя соседа не стирает (#180, У-49).
 */

/** Каталог файлов хранилища; имена - относительные (`diagnostics.log`, `diagnostics.1.log`…). `remove` отсутствующего файла не бросает. */
export interface DiagnosticsFs {
  list(): string[];
  read(name: string): string;
  /** Дописывает в конец файла, создавая его; бросает при отказе диска. */
  append(name: string, text: string): void;
  /** Размер в байтах; файла нет - 0. */
  size(name: string): number;
  rename(from: string, to: string): void;
  remove(name: string): void;
}

export interface DiagnosticsOptions {
  readonly fs: DiagnosticsFs;
  /** Кто пишет: имя и версия приложения для заголовка выгрузки и записи начала запуска. */
  readonly app?: string;
  /** Записей в кольце всего (FR-CH-4011). */
  readonly capacity?: number;
  /** Записей одного плагина без жизненного цикла в кольце. */
  readonly perPlugin?: number;
  /** Предельный размер одного файла, байт (FR-CH-4012). */
  readonly fileBytes?: number;
  /** Сколько файлов хранится, включая текущий. Файлов потока на диске не больше `files * fileBytes`. */
  readonly files?: number;
  /** Предел файла записей жизненного цикла и сбоев, байт: ротация потока отдаёт ему эти записи, свои старые он вытесняет сам. Всего на диске не больше `files * fileBytes + keepBytes`. */
  readonly keepBytes?: number;
  /** Через сколько мс пакет обычных записей уходит в файл. */
  readonly flushMs?: number;
  /** Не чаще раза в столько мс срочная запись (ошибка, жизненный цикл) пишет файл сразу; частые ошибки трассы иначе превратили бы вызовы в запись на диск. */
  readonly urgentGapMs?: number;
  readonly now?: () => number;
  /** Файл не пишется или не читается: один раз на отказ, до следующей удачной записи. */
  readonly onProblem?: (text: string) => void;
}

/** Числа выбраны замером (`docs/05-verification/spike-gateway.md`, «Хранение диагностики», NFR-CH-4001) и предложением вопроса 4 SRS фичи 04; приложение переопределяет. */
export const DIAGNOSTICS_DEFAULTS = {
  capacity: 5000,
  perPlugin: 1250,
  fileBytes: 2 * 1024 * 1024,
  files: 5,
  keepBytes: 256 * 1024,
  flushMs: 1000,
  urgentGapMs: 20,
} as const;

/** Причина последнего сбоя плагина в прошлом запуске (FR-CH-4013). */
export interface PreviousFailure {
  readonly pluginId: string;
  /** Когда запись сделана, мс от эпохи. */
  readonly at: number;
  /** Причина словами, как её пишет журнал (`describeEntry`). */
  readonly text: string;
}

export interface DiagnosticsInfo {
  /** Файлов на диске и их размер, байт. */
  readonly files: number;
  readonly bytes: number;
  /** Время самой ранней хранимой записи (все файлы); ротация сдвигает его вперёд. */
  readonly since: number | undefined;
  /** Начало прошлого запуска; undefined - прошлого запуска в файлах нет. */
  readonly previousRunAt: number | undefined;
  /** Причина, по которой запись в файл сейчас не удаётся; undefined - удаётся. */
  readonly problem: string | undefined;
}

const CURRENT = 'diagnostics.log';
/** Записи жизненного цикла и сбоев, сохранённые ротацией потока (под `FILE` не подпадает: сдвигу ротации не подлежит). */
const KEEP = 'diagnostics.keep.log';
const FILE = /^diagnostics(?:\.(\d+))?\.log$/;
const fileName = (index: number): string => (index === 0 ? CURRENT : `diagnostics.${String(index)}.log`);
const SELF = 'диагностика';

/** Код отказа без текста: в сообщении ошибки файловой системы лежит путь к `userData`, а запись попадёт в выгрузку. */
const codeOf = (error: unknown): string => (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'ошибка записи');
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Diagnostics {
  /** Приёмники для `LoadOptions`: `onJournal`, `onLog`, `onTrace` и `onGraph`. Ядро без них не пишет и не хранит ничего. */
  readonly sinks: {
    readonly onJournal: (entry: JournalEntry) => void;
    readonly onLog: (pluginId: string, message: string, level: LogLevel) => void;
    readonly onTrace: (record: TraceRecord) => void;
    readonly onGraph: (graph: ContractGraph) => undefined;
  };

  readonly #fs: DiagnosticsFs;
  readonly #app: string | undefined;
  readonly #now: () => number;
  readonly #limits: { readonly fileBytes: number; readonly files: number; readonly keepBytes: number; readonly flushMs: number; readonly urgentGapMs: number; readonly capacity: number };
  readonly #onProblem: ((text: string) => void) | undefined;
  readonly #ring: DiagnosticsRing<DiagnosticRecord>;
  /** Записи, которых в файле ещё нет: пакет до записи либо то, что не удалось записать. */
  readonly #batch: DiagnosticRecord[] = [];
  /** Размер и самая ранняя запись каждого файла хранилища. */
  readonly #sizes = new Map<string, number>();
  readonly #firsts = new Map<string, number>();
  #keepSize = 0;
  /** Сохранение записей сбоев при ротации не удалось, и об этом сказано: до следующей удачи не повторяется. */
  #keepProblem = false;
  readonly #run: number;
  #previousRun: number | undefined;
  readonly #failures = new Map<string, PreviousFailure>();
  #graph: ContractGraph | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #due = Infinity;
  #lastFlush = -Infinity;
  #problem: string | undefined;
  #closed = false;

  constructor(options: DiagnosticsOptions) {
    const d = DIAGNOSTICS_DEFAULTS;
    this.#fs = options.fs;
    this.#app = options.app;
    this.#now = options.now ?? Date.now;
    this.#limits = {
      fileBytes: options.fileBytes ?? d.fileBytes,
      files: Math.max(1, options.files ?? d.files),
      keepBytes: options.keepBytes ?? d.keepBytes,
      flushMs: options.flushMs ?? d.flushMs,
      urgentGapMs: options.urgentGapMs ?? d.urgentGapMs,
      capacity: options.capacity ?? d.capacity,
    };
    this.#onProblem = options.onProblem;
    this.#ring = new DiagnosticsRing({ capacity: this.#limits.capacity, perOwner: options.perPlugin ?? d.perPlugin });
    this.#run = this.#now();
    this.sinks = {
      onJournal: (entry) => this.#add({ src: 'journal', at: this.#now(), entry }),
      onLog: (pluginId, text, level) => this.#add({ src: 'log', at: this.#now(), pluginId, level, text }),
      onTrace: (record) => this.#add({ src: 'trace', at: record.at, record }),
      onGraph: (graph) => {
        this.#graph = graph;
        return undefined;
      },
    };
    this.#scan();
    this.#add({ src: 'run', at: this.#run, ...(this.#app !== undefined && { app: this.#app }) });
    this.flush();
  }

  /** Причина последнего сбоя каждого плагина в прошлом запуске. Только показ: состояние плагинов в этом запуске ядро выводит из своего журнала (FR-CH-4014). */
  previousFailures(): ReadonlyMap<string, PreviousFailure> {
    return this.#failures;
  }

  stored(): DiagnosticsInfo {
    const firsts = [...this.#firsts.values(), ...this.#batch.map((r) => r.at)];
    return {
      files: this.#sizes.size + (this.#keepSize > 0 ? 1 : 0),
      bytes: [...this.#sizes.values()].reduce((n, size) => n + size, this.#keepSize),
      since: firsts.length === 0 ? undefined : Math.min(...firsts),
      previousRunAt: this.#previousRun,
      problem: this.#problem,
    };
  }

  /** Записи этого запуска в кольце, по порядку. */
  recent(): DiagnosticRecord[] {
    return this.#ring.entries();
  }

  /** Пишет накопленный пакет в файл; отказ диска не бросается: записи остаются в памяти, в кольце появляется одна запись об отказе. */
  flush(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#due = Infinity;
    if (this.#batch.length === 0) return;
    this.#lastFlush = performance.now();
    try {
      this.#write();
      this.#problem = undefined;
    } catch (error) {
      this.#failed(error);
    }
  }

  /** Конец работы ядра: пакет уходит в файл, поздние записи после этого пишутся сразу. */
  close(): void {
    this.flush();
    this.#closed = true;
  }

  /** Выгрузка одним текстом (FR-CH-4015): все хранимые файлы, не записанное в файл, состояние плагинов и графа. Ничего никуда не отправляется (FR-CH-4016). */
  export(context: ExportContext): string {
    this.flush();
    const records: StoredRecord[] = [];
    let unreadable = 0;
    const files: { name: string; bytes: number }[] = [];
    for (const name of this.#names(true)) {
      try {
        const text = this.#fs.read(name);
        files.push({ name, bytes: Buffer.byteLength(text) });
        for (const line of text.split('\n')) {
          if (line === '') continue;
          const stored = decodeRecord(line);
          if (stored) records.push(stored);
          else unreadable++;
        }
      } catch {
        unreadable++;
      }
    }
    // Не записанное в файл (отказ диска) входит в выгрузку: человек выгружает как раз тогда, когда что-то пошло не так.
    const unsaved = this.#batch.length;
    for (const record of this.#batch) records.push({ run: this.#run, record });
    return formatExport({
      now: this.#now(),
      run: this.#run,
      records,
      files,
      unsaved,
      unreadable,
      graph: this.#graph,
      limits: { files: this.#limits.files, fileBytes: this.#limits.fileBytes, keepBytes: this.#limits.keepBytes },
      ...(this.#problem !== undefined && { problem: this.#problem }),
      context,
    });
  }

  #add(record: DiagnosticRecord): void {
    this.#ring.add(record, ownerOf(record), isKept(record));
    this.#batch.push(record);
    // Отказ диска не должен растить память без предела: пакет, не ушедший в файл, держится в той же ёмкости, что и кольцо.
    if (this.#batch.length > this.#limits.capacity) this.#batch.splice(0, this.#batch.length - this.#limits.capacity);
    if (this.#closed || isUrgent(record)) this.#schedule(Math.max(0, this.#lastFlush + this.#limits.urgentGapMs - performance.now()));
    else this.#schedule(this.#limits.flushMs);
  }

  /** Пакет уходит через `ms`; более ранний срок побеждает, более поздний существующий не двигает. */
  #schedule(ms: number): void {
    if (ms <= 0) {
      this.flush();
      return;
    }
    const due = performance.now() + ms;
    if (this.#timer !== undefined && this.#due <= due) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(() => this.flush(), ms);
    this.#timer.unref();
  }

  /** Имена файлов хранилища от самого старого к текущему; `withKeep` - с файлом записей сбоев впереди (он старше любого файла потока). */
  #names(withKeep = false): string[] {
    const list = this.#fs.list();
    const stream = list
      .flatMap((name) => {
        const match = FILE.exec(name);
        return match ? [{ name, index: Number(match[1] ?? 0) }] : [];
      })
      .sort((a, b) => b.index - a.index)
      .map((f) => f.name);
    return withKeep && list.includes(KEEP) ? [KEEP, ...stream] : stream;
  }

  /** Читает файлы прошлых запусков: сбои для окна, самую раннюю запись каждого файла. Нечитаемое пропускается, остальное хранилище работает. */
  #scan(): void {
    const candidates: { run: number; at: number; entry: JournalEntry }[] = [];
    const runs = new Set<number>();
    try {
      for (const name of this.#names()) {
        const index = Number(FILE.exec(name)?.[1] ?? 0);
        // Файл сверх нынешнего предела числа (предел уменьшили): остался бы на диске навсегда.
        if (index >= this.#limits.files) {
          this.#fs.remove(name);
          continue;
        }
        let first = Infinity;
        for (const line of this.#fs.read(name).split('\n')) {
          const stored = decodeRecord(line);
          if (!stored) continue;
          runs.add(stored.run);
          first = Math.min(first, stored.record.at);
          if (stored.record.src === 'journal' && isFailure(stored.record.entry)) candidates.push({ run: stored.run, at: stored.record.at, entry: stored.record.entry });
        }
        this.#sizes.set(name, this.#fs.size(name));
        if (first !== Infinity) this.#firsts.set(name, first);
      }
      if (this.#fs.list().includes(KEEP)) {
        for (const line of this.#fs.read(KEEP).split('\n')) {
          const stored = decodeRecord(line);
          if (!stored) continue;
          runs.add(stored.run);
          if (stored.record.src === 'journal' && isFailure(stored.record.entry)) candidates.push({ run: stored.run, at: stored.record.at, entry: stored.record.entry });
        }
        this.#keepSize = this.#fs.size(KEEP);
      }
    } catch (error) {
      this.#report(`файлы диагностики не прочитаны (${codeOf(error)}): причина прошлого сбоя может быть не видна`, messageOf(error));
    }
    runs.delete(this.#run);
    this.#previousRun = runs.size === 0 ? undefined : Math.max(...runs);
    for (const { run, at, entry } of candidates) {
      if (run !== this.#previousRun) continue;
      for (const pluginId of entryPlugins(entry)) {
        if (at >= (this.#failures.get(pluginId)?.at ?? -Infinity)) this.#failures.set(pluginId, { pluginId, at, text: wordsOf(entry) });
      }
    }
  }

  /** Пишет пакет файлами не больше `fileBytes`: ротация идёт перед записью, которая не помещается. Записанное из пакета уходит, при отказе остаток остаётся. */
  #write(): void {
    const { fileBytes } = this.#limits;
    // Строка не длиннее файла, иначе одна запись нарушила бы предел размера.
    const lines = this.#batch.map((record) => `${encodeRecord(this.#run, record, Math.min(MAX_LINE_BYTES, fileBytes - 1))}\n`);
    while (lines.length > 0) {
      let size = this.#fs.size(CURRENT);
      if (size > 0 && size + Buffer.byteLength(lines[0] ?? '') > fileBytes) {
        this.#rotate();
        size = 0;
      }
      let text = '';
      let bytes = 0;
      let count = 0;
      for (const line of lines) {
        const length = Buffer.byteLength(line);
        if (count > 0 && size + bytes + length > fileBytes) break;
        text += line;
        bytes += length;
        count++;
      }
      this.#fs.append(CURRENT, text);
      this.#sizes.set(CURRENT, size + bytes);
      let first = this.#firsts.get(CURRENT) ?? Infinity;
      for (const record of this.#batch.splice(0, count)) first = Math.min(first, record.at);
      this.#firsts.set(CURRENT, first);
      lines.splice(0, count);
    }
  }

  /** Текущий файл становится `.1`, остальные сдвигаются, самый старый удаляется: на диске не больше `files` файлов. */
  #rotate(): void {
    const last = this.#limits.files - 1;
    const names = new Set(this.#fs.list());
    if (names.has(fileName(last))) this.#keep(fileName(last));
    if (last === 0) {
      this.#fs.remove(CURRENT);
    } else {
      this.#fs.remove(fileName(last));
      for (let i = last - 1; i >= 0; i--) if (names.has(fileName(i))) this.#fs.rename(fileName(i), fileName(i + 1));
    }
    const sizes = [...this.#sizes];
    const firsts = [...this.#firsts];
    this.#sizes.clear();
    this.#firsts.clear();
    for (const [name, size] of sizes) this.#moved(name, size, this.#sizes);
    for (const [name, at] of firsts) this.#moved(name, at, this.#firsts);
  }

  /** Уходящий файл потока отдаёт записи жизненного цикла файлу записей сбоев; отказ чтения или записи ротацию не останавливает: шум уйдёт, а причина названа один раз. */
  #keep(leaving: string): void {
    try {
      const lines = this.#fs
        .read(leaving)
        .split('\n')
        .filter((line) => {
          const stored = decodeRecord(line);
          return stored !== undefined && isKept(stored.record);
        });
      if (lines.length > 0) this.#append(lines);
      this.#keepProblem = false;
    } catch (error) {
      if (!this.#keepProblem) this.#report(`записи сбоев не сохранены при ротации (${codeOf(error)}): причина старого сбоя может уйти с файлом`, messageOf(error));
      this.#keepProblem = true;
    }
  }

  /** Дописывает строки в файл записей сбоев; не поместились - его старые строки вытесняются с начала, пока файл не уложится в предел. */
  #append(lines: readonly string[]): void {
    const text = lines.map((line) => `${line}\n`).join('');
    const size = this.#keepSize;
    if (size + Buffer.byteLength(text) <= this.#limits.keepBytes) {
      this.#fs.append(KEEP, text);
      this.#keepSize = size + Buffer.byteLength(text);
      return;
    }
    const all = (size > 0 ? this.#fs.read(KEEP).split('\n').filter((line) => line !== '') : []).concat(lines);
    let total = all.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
    while (all.length > 1 && total > this.#limits.keepBytes) total -= Buffer.byteLength(all.shift() ?? '') + 1;
    const kept = all.map((line) => `${line}\n`).join('');
    this.#fs.remove(KEEP);
    // Новая запись не длиннее строки файла потока, но предел мал: одна запись остаётся всегда, иначе причина сбоя пропала бы именно из-за размера.
    this.#fs.append(KEEP, kept);
    this.#keepSize = Buffer.byteLength(kept);
  }

  /** Запись о файле после сдвига ротации: `diagnostics.N.log` стал `.N+1`, вышедший за предел исчез. */
  #moved<V>(name: string, value: V, into: Map<string, V>): void {
    const index = Number(FILE.exec(name)?.[1] ?? 0);
    if (index + 1 <= this.#limits.files - 1) into.set(fileName(index + 1), value);
  }

  #failed(error: unknown): void {
    if (this.#problem === undefined) {
      this.#problem = codeOf(error);
      // Одна запись на отказ, не на каждую повторную попытку; она сама идёт в пакет и уйдёт в файл, когда диск вернётся.
      const record: DiagnosticRecord = { src: 'log', at: this.#now(), pluginId: SELF, level: 'error', text: `файл диагностики не записан (${this.#problem}): записи остаются в памяти` };
      this.#ring.add(record, SELF, false);
      this.#batch.push(record);
      this.#report(`файл диагностики не записан (${this.#problem}): ${messageOf(error)}`);
    }
    // Повтор позже: пакету не нужно ждать следующей записи, которой может не быть.
    this.#schedule(Math.max(this.#limits.flushMs, 1000));
  }

  #report(text: string, detail?: string): void {
    this.#onProblem?.(detail === undefined ? text : `${text}: ${detail}`);
  }
}

function wordsOf(entry: JournalEntry): string {
  try {
    return describeEntry(entry);
  } catch {
    // Запись из файла могли исправить руками: словами её не описать, остаётся вид записи.
    return entry.kind;
  }
}
