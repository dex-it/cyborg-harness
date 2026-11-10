import { AsyncLocalStorage } from 'node:async_hooks';
import { toWire } from './errors.ts';
import type { Owner } from './rpc.ts';
import { REASONS, type Boundary, type ExitRecord, type OperationRecord, type StreamRecord, type TraceRecord } from './trace-record.ts';
import { bytesOf } from './trace-size.ts';

/*
 * Трасса операций на границах Г1 - Г5 (K-28, FR-CH-4001…4008, SAD 3.5).
 *
 * Операция - это вызов, который прошёл границы плагинов: сообщение хоста, вызов моста вида, член контракта, команда, событие, вызов `ctx.os`.
 * Она получает `OpHandle` в точке входа (`run`), по пути отмечает пройденные границы и адресата, а в конце пишет ровно одну запись.
 * Цепочку операций несёт `Owner` (rpc.ts): номер цепочки уходит в сообщении `c` и держится в `AsyncLocalStorage` по обе стороны канала.
 * Ядро без `LoadOptions.onTrace` ничего не пишет и не заводит хранилищ: `run` зовёт функцию с пустым `OpHandle`.
 */

/** Точка наблюдения одной операции. Вызовы после записи ничего не меняют. */
export interface OpHandle {
  /** Операция дошла до границы; последняя в списке - та, где она кончилась. */
  enter(boundary: Boundary): void;
  /** Кто вызвал, когда это стало известно из сообщения (до проверки канала там `host:<id>`); `hostId` - хост вызывающего. */
  caller(caller: string, hostId?: string): void;
  /** Что вызвано; `callee` - плагин-адресат, `right` - право манифеста, которым допущена операция. */
  target(target: string, callee?: string, right?: string): void;
  /** Размер аргументов в байтах; содержимое в запись не идёт. */
  args(value: unknown): void;
}

const NOOP: OpHandle = { enter: () => undefined, caller: () => undefined, target: () => undefined, args: () => undefined };

export interface OpStart {
  readonly caller: string;
  readonly hostId?: string;
  readonly target: string;
  readonly boundaries: readonly Boundary[];
}

export interface TraceOptions {
  /** Интервал счётчика потока, мс (`ResourceLimits.traceStreamMs`). */
  readonly streamMs: number;
  /** Хост плагина для записей потока и выхода. */
  readonly hostOf: (pluginId: string) => string | undefined;
  /** Приёмник бросил: сообщается один раз, операция от этого не меняется. */
  readonly failed: (error: unknown) => void;
}

interface Scope {
  readonly chain: number;
  /** Операция, внутри которой идёт код; у цепочки, пришедшей из хоста, до её собственной операции - undefined. */
  readonly op: RealOp | undefined;
}

interface Counter {
  readonly stream: StreamRecord['stream'];
  readonly pluginId: string;
  readonly at: number;
  messages: number;
  bytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

const PLUGIN = 'plugin:';
const round = (ms: number): number => Math.round(ms * 1000) / 1000;

class RealOp implements OpHandle {
  done = false;
  readonly chain: number;
  readonly #trace: Trace;
  readonly #id: number;
  readonly #at = Date.now();
  readonly #t0 = performance.now();
  readonly #boundaries: Boundary[];
  #caller: string;
  #hostId: string | undefined;
  #target: string;
  #callee: string | undefined;
  #right: string | undefined;
  #argsBytes = 0;

  constructor(trace: Trace, id: number, chain: number, start: OpStart) {
    this.#trace = trace;
    this.#id = id;
    this.chain = chain;
    this.#caller = start.caller;
    this.#hostId = start.hostId;
    this.#target = start.target;
    this.#boundaries = [...start.boundaries];
  }

  enter(boundary: Boundary): void {
    if (!this.done) this.#boundaries.push(boundary);
  }

  caller(caller: string, hostId?: string): void {
    if (this.done) return;
    this.#caller = caller;
    if (hostId !== undefined) this.#hostId = hostId;
  }

  target(target: string, callee?: string, right?: string): void {
    if (this.done) return;
    this.#target = target;
    if (callee !== undefined) this.#callee = callee;
    if (right !== undefined) this.#right = right;
  }

  args(value: unknown): void {
    if (!this.done) this.#argsBytes = bytesOf(value);
  }

  /** Запись об итоге: успех с размером результата либо отказ с кодом ядра, как его увидел вызывающий. */
  end(value: unknown, failure?: { readonly error: unknown }): void {
    if (this.done) return;
    this.done = true;
    const durationMs = round(performance.now() - this.#t0);
    const code = failure === undefined ? undefined : toWire(failure.error).code;
    const record: OperationRecord = {
      kind: 'operation',
      id: this.#id,
      chain: this.chain,
      at: this.#at,
      caller: this.#caller,
      ...(this.#hostId !== undefined && { hostId: this.#hostId }),
      target: this.#target,
      ...(this.#callee !== undefined && { callee: this.#callee }),
      boundaries: this.#boundaries,
      ...(this.#right !== undefined && { right: this.#right }),
      durationMs,
      argsBytes: this.#argsBytes,
      resultBytes: failure === undefined ? bytesOf(value) : 0,
      outcome: code === undefined ? 'ok' : 'error',
      ...(code !== undefined && { code, reason: REASONS[code] }),
    };
    this.#trace.emit(record);
    // Единственная операция с правом `process` - `process.run`: её результат и есть выход программы.
    if (failure === undefined && this.#right === 'process' && this.#caller.startsWith(PLUGIN)) this.#trace.exited(this.#caller.slice(PLUGIN.length), this.chain, value);
  }
}

export class Trace {
  /** Для `Endpoint` каналов хостов: цепочка идёт в сообщении и в `AsyncLocalStorage` ядра. */
  readonly owner: Owner;
  readonly #sink: ((record: TraceRecord) => void) | undefined;
  readonly #options: TraceOptions;
  readonly #scope = new AsyncLocalStorage<Scope | undefined>();
  readonly #counters = new Map<string, Counter>();
  /** Ошибки, уже записанные операцией: уведомление, бросившее такую же, второй записи не получает. */
  readonly #recorded = new WeakSet<object>();
  #seq = 0;
  #failed = false;

  constructor(sink: ((record: TraceRecord) => void) | undefined, options: TraceOptions) {
    this.#sink = sink;
    this.#options = options;
    this.owner = {
      current: () => undefined,
      enter: () => undefined,
      // Цепочка продолжается, пока идёт её операция: код, заведённый внутри неё и доживший до конца (таймер, поток), цепочки уже не несёт.
      chain: () => {
        const scope = this.#scope.getStore();
        return scope === undefined || scope.op?.done === true ? undefined : scope.chain;
      },
      within: (chain, run) => {
        // Сообщение без цепочки в коде вне цепочки (обычный случай) хранилища не заводит.
        if (this.#sink === undefined || (chain === undefined && this.#scope.getStore() === undefined)) return run();
        return this.#scope.run(chain === undefined ? undefined : { chain, op: undefined }, run);
      },
    };
  }

  get enabled(): boolean {
    return this.#sink !== undefined;
  }

  /** Записывает операцию, которую исполняет `fn`: одна запись в конце, будь то возврат, исключение или промис. */
  run<T>(start: OpStart, fn: (op: OpHandle) => T): T {
    if (this.#sink === undefined) return fn(NOOP);
    const parent = this.#scope.getStore();
    const id = ++this.#seq;
    const op = new RealOp(this, id, parent?.chain ?? id, start);
    let result: T;
    try {
      result = this.#scope.run({ chain: op.chain, op }, () => fn(op));
    } catch (error) {
      this.#fail(op, error);
      throw error;
    }
    if (result instanceof Promise) void result.then((value: unknown) => op.end(value), (error: unknown) => this.#fail(op, error));
    else op.end(result);
    return result;
  }

  /** Уведомление хоста: запись пишется только если оно отказало и операция этого отказа ещё не записала (событие записывает себя само). */
  note<T>(start: OpStart, fn: () => T): T {
    if (this.#sink === undefined) return fn();
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof Object) || !this.#recorded.has(error)) {
        const op = new RealOp(this, ++this.#seq, this.#scope.getStore()?.chain ?? this.#seq, start);
        this.#fail(op, error);
      }
      throw error;
    }
  }

  #fail(op: RealOp, error: unknown): void {
    if (error instanceof Object) this.#recorded.add(error);
    op.end(undefined, { error });
  }

  emit(record: TraceRecord): void {
    try {
      this.#sink?.(record);
    } catch (error) {
      if (this.#failed) return;
      this.#failed = true;
      this.#options.failed(error);
    }
  }

  /** `process.run` кончилась: запись выхода программы с кодом (FR-CH-4007). Вывод программы в запись не идёт. */
  exited(pluginId: string, chain: number, result: unknown): void {
    if (typeof result !== 'object' || result === null) return;
    const { code, signal } = result as { code?: unknown; signal?: unknown };
    this.#exit(pluginId, 'os:process.run', 'process', typeof code === 'number' ? code : null, typeof signal === 'string' ? signal : undefined, chain);
  }

  /** Выход pty, который запустил плагин (приходит позже запуска). */
  ptyExit(pluginId: string, exit: { readonly code: number; readonly signal?: number }): void {
    if (this.#sink !== undefined) this.#exit(pluginId, 'os:pty.spawn', 'pty', exit.code, exit.signal);
  }

  #exit(pluginId: string, target: ExitRecord['target'], right: ExitRecord['right'], code: number | null, signal?: string | number, chain?: number): void {
    const hostId = this.#options.hostOf(pluginId);
    this.emit({
      kind: 'exit',
      id: ++this.#seq,
      ...(chain !== undefined && { chain }),
      at: Date.now(),
      pluginId,
      ...(hostId !== undefined && { hostId }),
      target,
      right,
      code,
      ...(signal !== undefined && { signal }),
    });
  }

  /** Сообщение частого потока (вывод pty, событие `fs.watch`): считается, а не пишется; в конце интервала уходит одна запись (FR-CH-4005). */
  count(stream: StreamRecord['stream'], pluginId: string, bytes: number): void {
    if (this.#sink === undefined) return;
    const key = `${stream}\0${pluginId}`;
    let counter = this.#counters.get(key);
    if (!counter) {
      const timer = setTimeout(() => this.#close(key, this.#options.streamMs), this.#options.streamMs);
      timer.unref();
      counter = { stream, pluginId, at: Date.now(), messages: 0, bytes: 0, timer };
      this.#counters.set(key, counter);
    }
    counter.messages++;
    counter.bytes += bytes;
  }

  #close(key: string, intervalMs: number): void {
    const counter = this.#counters.get(key);
    if (!counter) return;
    this.#counters.delete(key);
    clearTimeout(counter.timer);
    const hostId = this.#options.hostOf(counter.pluginId);
    this.emit({
      kind: 'stream',
      stream: counter.stream,
      pluginId: counter.pluginId,
      ...(hostId !== undefined && { hostId }),
      at: counter.at,
      intervalMs,
      messages: counter.messages,
      bytes: counter.bytes,
    });
  }

  /** Плагин снят: начатый интервал его потоков дописывается записью. */
  drop(pluginId: string): void {
    for (const [key, counter] of [...this.#counters]) if (counter.pluginId === pluginId) this.#close(key, Date.now() - counter.at);
  }

  /** Выгрузка ядра: то же для всех потоков. */
  flush(): void {
    for (const [key, counter] of [...this.#counters]) this.#close(key, Date.now() - counter.at);
  }
}
