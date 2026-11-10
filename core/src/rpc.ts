import { CoreError, errorMessage, fromWire, ignore, toWire, type WireError } from './errors.ts';
import { isRecord } from './wire.ts';

/** Канал сообщений между ядром и хостом; post бросает, если сообщение не переживает structuredClone. */
export interface Port {
  /** `transfer` - объекты, которые уходят в другой процесс с передачей владения (порты сообщений); у хоста плагинов их нет. */
  post(message: unknown, transfer?: readonly unknown[]): void;
  onMessage(listener: (message: unknown, transfer?: readonly unknown[]) => void): void;
}

/**
 * `c` - цепочка операций, из которой послано сообщение (FR-CH-4002, `Owner.chain`); без него сообщение начинает цепочку само.
 * Хост плагина собеседнику не доверяется: цепочка нужна диагностике, а не решению о правах.
 */
type Message =
  | { readonly t: 'req'; readonly id: number; readonly m: string; readonly p: unknown; readonly c?: number }
  | { readonly t: 'res'; readonly id: number; readonly ok: true; readonly v: unknown }
  | { readonly t: 'res'; readonly id: number; readonly ok: false; readonly e: WireError }
  | { readonly t: 'note'; readonly m: string; readonly p: unknown; readonly c?: number }
  /** `reason` - причина отказа ядра (например `Timeout`), если это она; иначе поставщик увидит `Cancelled`. */
  | { readonly t: 'cancel'; readonly id: number; readonly reason?: WireError };

function readMessage(raw: unknown): Message | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.t === 'note') return typeof raw.m === 'string' ? (raw as Message) : undefined;
  if (typeof raw.id !== 'number') return undefined;
  if (raw.t === 'cancel') return raw as Message;
  if (raw.t === 'req') return typeof raw.m === 'string' ? (raw as Message) : undefined;
  if (raw.t === 'res') return typeof raw.ok === 'boolean' ? (raw as Message) : undefined;
  return undefined;
}

// Форму параметров проверяет сам обработчик: ядро пропускает сообщения хоста через parseWire.
// Второй аргумент - сигнал запроса: он отменяется, когда отправитель прислал `cancel` или канал закрыт.
type Handler = (params: never, signal: AbortSignal) => unknown;

// Уведомление отменить нельзя: обработчику дан сигнал, который не сработает.
const NEVER = new AbortController().signal;

/** Отказ отменённого запроса: причина сигнала, если это отказ ядра (например `Timeout`), иначе `Cancelled`. */
export function cancelError(signal: AbortSignal): CoreError {
  return signal.reason instanceof CoreError ? signal.reason : new CoreError('Cancelled', 'запрос отменён');
}

/** Коды, которыми запрос отменяют законно: отмена, срок ядра, падение хоста вызывающего. */
const CANCEL_CODES: readonly string[] = ['Cancelled', 'Timeout', 'HostGone'];

/** Причина из чужого `cancel`: любой другой код (например `PermissionDenied`) собеседник выдал бы за отказ ядра, поэтому он приводится к `Cancelled`. */
function readCancelReason(raw: WireError | undefined): CoreError {
  if (raw === undefined) return new CoreError('Cancelled', 'запрос отменён');
  const reason = fromWire(raw);
  return CANCEL_CODES.includes(reason.code) ? reason : new CoreError('Cancelled', 'запрос отменён');
}

/** Чей код ждёт ответа: продолжение после ответа идёт от имени того, кто спросил. Тот же механизм несёт цепочку операций трассы (FR-CH-4002). */
export interface Owner {
  current(): string | undefined;
  enter(owner: string | undefined): void;
  /** Цепочка операций, в которой идёт этот код: запрос и уведомление уходят с её номером; undefined - код вне цепочки. */
  chain(): number | undefined;
  /** Обработчик сообщения собеседника исполняется в цепочке `chain` (undefined - в новой, а не в цепочке того, кто доставил сообщение). */
  within<R>(chain: number | undefined, run: () => R): R;
}

/** Запрос-ответ и уведомления поверх порта; сообщения одного порта приходят в порядке отправки. */
export class Endpoint {
  readonly #port: Port;
  readonly #handlers = new Map<string, Handler>();
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; owner: string | undefined; unlisten(): void }>();
  // Отменённые запросы, чей ответ ещё в пути: ответ, обогнавший отмену, отдаётся `discard`, чтобы снять то, что он открыл.
  readonly #cancelled = new Map<number, ((value: unknown) => void) | undefined>();
  // Запросы собеседника, которые обработчик ещё исполняет: только их он может отменить.
  readonly #serving = new Map<number, AbortController>();
  readonly #owner: Owner | undefined;
  #next = 1;
  #closed: CoreError | undefined;

  constructor(port: Port, owner?: Owner) {
    this.#port = port;
    this.#owner = owner;
    port.onMessage((raw) => {
      const message = readMessage(raw);
      // Исключение здесь ушло бы необработанным отказом в процесс ядра: сообщение не по форме отбрасывается.
      if (message) this.#receive(message).catch(ignore);
    });
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  handle(method: string, handler: Handler): void {
    this.#handlers.set(method, handler);
  }

  /**
   * `signal` отменяет запрос: вызывающий сразу получает отказ (`Cancelled`, а если причина сигнала - `CoreError`, то он), собеседнику уходит `cancel`.
   * `discard` получает результат, если собеседник успел ответить до отмены: так не теряется то, что ответ открыл (подписку).
   */
  request<T = unknown>(method: string, params: unknown, signal?: AbortSignal, discard?: (value: unknown) => void): Promise<T> {
    const closed = this.#closed;
    if (closed) return Promise.reject(closed);
    if (signal?.aborted) return Promise.reject(cancelError(signal));
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const owner = this.#owner?.current();
      const unlisten = signal ? this.#onAbort(id, signal, reject, discard, owner) : () => undefined;
      this.#pending.set(id, { resolve, reject, owner, unlisten });
      try {
        this.#send({ t: 'req', id, m: method, p: params, ...this.#chainOf() }, `${method}: аргументы`);
      } catch (error) {
        this.#pending.delete(id);
        unlisten();
        reject(error instanceof Error ? error : new CoreError('Remote', String(error)));
      }
    });
  }

  /** Отмена ждущего запроса: отказ вызывающему сразу, собеседнику `cancel`; ответ, что придёт позже, достаётся `discard`. */
  #onAbort(id: number, signal: AbortSignal, reject: (error: unknown) => void, discard: ((value: unknown) => void) | undefined, owner: string | undefined): () => void {
    const onAbort = () => {
      if (!this.#pending.delete(id)) return;
      // Как на пути ответа: сигнал мог сработать вне входа плагина (внутренний таймер), а продолжение после отказа - его.
      this.#owner?.enter(owner);
      this.#cancelled.set(id, discard);
      try {
        const reason = signal.reason as unknown;
        this.#send({ t: 'cancel', id, ...(reason instanceof CoreError && { reason: toWire(reason) }) }, 'cancel');
      } catch {
        // Канал не принял отмену: собеседник доработает сам, ответ мы всё равно отбросим.
      }
      reject(cancelError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#send({ t: 'note', m: method, p: params, ...this.#chainOf() }, `${method}: данные`);
  }

  #chainOf(): { readonly c: number } | undefined {
    const c = this.#owner?.chain();
    return c === undefined ? undefined : { c };
  }

  /** Обработчик сообщения идёт в цепочке отправителя; номер чужой и не по форме отбрасывается. */
  #within<R>(message: Message, run: () => R): R {
    if (!this.#owner) return run();
    const c = message.t === 'req' || message.t === 'note' ? message.c : undefined;
    return this.#owner.within(Number.isSafeInteger(c) ? c : undefined, run);
  }

  /** Обрывает канал: ждущие ответа получают ошибку, новые запросы отклоняются сразу. */
  close(error: CoreError): void {
    if (this.#closed) return;
    this.#closed = error;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#cancelled.clear();
    for (const p of pending) {
      p.unlisten();
      p.reject(error);
    }
    const serving = [...this.#serving.values()];
    this.#serving.clear();
    for (const controller of serving) controller.abort(error);
  }

  #send(message: Message, label: string): void {
    try {
      this.#port.post(message);
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('NotCloneable', `${label} не переживут structuredClone: ${errorMessage(error)}`);
    }
  }

  async #receive(message: Message): Promise<void> {
    if (this.#closed) return;
    if (message.t === 'cancel') {
      const controller = this.#serving.get(message.id);
      if (!controller) return;
      this.#serving.delete(message.id);
      const reason = readCancelReason(message.reason);
      controller.abort(reason);
      // Ответ сразу: ждущий отмены снимает запись, а то, что обработчик вернёт позже, уже никому не нужно.
      this.#reply({ t: 'res', id: message.id, ok: false, e: toWire(reason) }, 'cancel');
      return;
    }
    if (message.t === 'res') {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        if (!this.#cancelled.has(message.id)) return;
        const discard = this.#cancelled.get(message.id);
        this.#cancelled.delete(message.id);
        if (message.ok) discard?.(message.v);
        return;
      }
      this.#pending.delete(message.id);
      pending.unlisten();
      this.#owner?.enter(pending.owner);
      if (message.ok) pending.resolve(message.v);
      else pending.reject(fromWire(message.e));
      return;
    }
    const handler = this.#handlers.get(message.m);
    if (message.t === 'note') {
      try {
        await this.#within(message, () => handler?.(message.p as never, NEVER));
      } catch {
        // У уведомления нет отправителя, которому вернуть ошибку.
      }
      return;
    }
    const controller = new AbortController();
    this.#serving.set(message.id, controller);
    try {
      if (!handler) throw new CoreError('Remote', `нет обработчика ${message.m}`);
      const value = await this.#within(message, () => handler(message.p as never, controller.signal));
      if (!controller.signal.aborted) this.#reply({ t: 'res', id: message.id, ok: true, v: value }, `${message.m}: результат`);
    } catch (error) {
      if (!controller.signal.aborted) this.#reply({ t: 'res', id: message.id, ok: false, e: toWire(error) }, `${message.m}: ошибка`);
    } finally {
      if (this.#serving.get(message.id) === controller) this.#serving.delete(message.id);
    }
  }

  #reply(message: Message, label: string): void {
    if (this.#closed) return;
    try {
      this.#send(message, label);
    } catch (error) {
      if (message.t === 'res') this.#send({ t: 'res', id: message.id, ok: false, e: toWire(error) }, label);
    }
  }
}
