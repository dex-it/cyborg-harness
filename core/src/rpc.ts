import { CoreError, fromWire, toWire, type WireError } from './errors.ts';

/** Канал сообщений между ядром и хостом; post бросает, если сообщение не переживает structuredClone. */
export interface Port {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

type Message =
  | { readonly t: 'req'; readonly id: number; readonly m: string; readonly p: unknown }
  | { readonly t: 'res'; readonly id: number; readonly ok: true; readonly v: unknown }
  | { readonly t: 'res'; readonly id: number; readonly ok: false; readonly e: WireError }
  | { readonly t: 'note'; readonly m: string; readonly p: unknown };

type Handler = (params: any) => unknown;

/** Запрос-ответ и уведомления поверх порта; сообщения одного порта приходят в порядке отправки. */
export class Endpoint {
  readonly #port: Port;
  readonly #handlers = new Map<string, Handler>();
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>();
  #next = 1;
  #closed: CoreError | undefined;

  constructor(port: Port) {
    this.#port = port;
    port.onMessage((message) => this.#receive(message as Message));
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  handle(method: string, handler: Handler): void {
    this.#handlers.set(method, handler);
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.#send({ t: 'req', id, m: method, p: params }, `${method}: аргументы`);
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#send({ t: 'note', m: method, p: params }, `${method}: данные`);
  }

  /** Обрывает канал: ждущие ответа получают ошибку, новые запросы отклоняются сразу. */
  close(error: CoreError): void {
    if (this.#closed) return;
    this.#closed = error;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) p.reject(error);
  }

  #send(message: Message, label: string): void {
    try {
      this.#port.post(message);
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError('NotCloneable', `${label} не переживут structuredClone: ${(error as Error).message}`);
    }
  }

  async #receive(message: Message): Promise<void> {
    if (this.#closed) return;
    if (message.t === 'res') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.v);
      else pending.reject(fromWire(message.e));
      return;
    }
    const handler = this.#handlers.get(message.m);
    if (message.t === 'note') {
      try {
        await handler?.(message.p);
      } catch {
        // У уведомления нет отправителя, которому вернуть ошибку.
      }
      return;
    }
    try {
      if (!handler) throw new CoreError('Remote', `нет обработчика ${message.m}`);
      const value = await handler(message.p);
      this.#reply({ t: 'res', id: message.id, ok: true, v: value }, `${message.m}: результат`);
    } catch (error) {
      this.#reply({ t: 'res', id: message.id, ok: false, e: toWire(error) }, `${message.m}: ошибка`);
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
