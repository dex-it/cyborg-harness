// Порты терминалов в preload вида (K-01): вывод приходит из pty-хоста прямо в порт, ввод и размер уходят в него же.
// Модуль без electron: порт - то, что есть у `MessagePort`, так что тест гоняет его на портах Node.
import { isRecord } from './guards.ts';
import type { Reply } from './snapshot.ts';
import type { TerminalEvent } from './view-protocol.ts';

/** Часть `MessagePort`, которая нужна: слушатель назначением `onmessage` заодно запускает порт. */
export interface PortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

interface Open {
  readonly port: PortLike;
  readonly pending: Map<number, (reply: Reply) => void>;
  next: number;
}

export interface TerminalPorts {
  /** Порт терминала пришёл от главного процесса (может обогнать ответ на `view:terminal:open`). */
  arrived(tid: number, port: PortLike): void;
  /** Ждёт порт терминала и включает приём; `false` - порт не пришёл за отведённое время, опоздавший будет закрыт. */
  connect(tid: number): Promise<boolean>;
  /** Ввод или размер: запрос в порт с номером, ответ pty-хоста с тем же номером. */
  request(tid: number, message: Record<string, unknown>): Promise<Reply>;
  close(tid: number): void;
  listen(listener: (event: TerminalEvent) => void): void;
  /** Событие управления от главного процесса: pty-хост потерян, порт молчит. */
  lost(event: TerminalEvent): void;
}

export function terminalPorts(waitMs = 5000): TerminalPorts {
  const open = new Map<number, Open>();
  const arrivedPorts = new Map<number, PortLike>();
  /** Вид получил отказ: порт, пришедший позже срока, никому не нужен. */
  const refused = new Set<number>();
  const waiting = new Map<number, (port: PortLike | undefined) => void>();
  const listeners: ((event: TerminalEvent) => void)[] = [];
  const emit = (event: TerminalEvent) => {
    for (const listener of listeners) listener(event);
  };
  const closed = (tid: number): Reply => ({ error: `терминал ${String(tid)} закрыт` });
  const drop = (tid: number) => {
    const entry = open.get(tid);
    if (!entry) return;
    open.delete(tid);
    entry.port.onmessage = null;
    entry.port.close();
    for (const resolve of entry.pending.values()) resolve(closed(tid));
    entry.pending.clear();
  };
  const received = (tid: number, entry: Open, data: unknown) => {
    if (!isRecord(data)) return;
    if (typeof data.data === 'string') emit({ tid, data: data.data });
    else if (isRecord(data.exit) && typeof data.exit.code === 'number') {
      emit({ tid, exit: data.exit as { code: number; signal?: number } });
      drop(tid);
    } else if (typeof data.id === 'number') {
      const resolve = entry.pending.get(data.id);
      entry.pending.delete(data.id);
      resolve?.(typeof data.error === 'string' ? { error: data.error } : {});
    }
  };
  return {
    arrived(tid, port) {
      if (refused.delete(tid)) {
        port.close();
        return;
      }
      const wait = waiting.get(tid);
      if (wait) {
        waiting.delete(tid);
        wait(port);
      } else arrivedPorts.set(tid, port);
    },
    async connect(tid) {
      let port = arrivedPorts.get(tid);
      arrivedPorts.delete(tid);
      port ??= await new Promise<PortLike | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(tid);
          refused.add(tid);
          resolve(undefined);
        }, waitMs);
        waiting.set(tid, (p) => {
          clearTimeout(timer);
          resolve(p);
        });
      });
      if (!port) return false;
      const entry: Open = { port, pending: new Map(), next: 0 };
      open.set(tid, entry);
      port.onmessage = (event) => received(tid, entry, event.data);
      return true;
    },
    request(tid, message) {
      const entry = open.get(tid);
      if (!entry) return Promise.resolve(closed(tid));
      const id = ++entry.next;
      return new Promise<Reply>((resolve) => {
        entry.pending.set(id, resolve);
        entry.port.postMessage({ id, ...message });
      });
    },
    close: drop,
    listen: (listener) => void listeners.push(listener),
    lost(event) {
      emit(event);
      if ('exit' in event) drop(event.tid);
    },
  };
}
