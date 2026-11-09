import { errorMessage, type TerminalSink, type TerminalView } from '@cyborg-harness/core';
import type { Reply } from '../shared/plugins.ts';

/** То, что нужно от `WebFrameMain`: тест подставляет свой фрейм без Electron. */
export interface TerminalFrame {
  readonly processId: number;
  readonly routingId: number;
  readonly detached: boolean;
  send(channel: string, ...args: unknown[]): void;
}

type OpenTerminal = (pluginId: string, ticket: string, sink: TerminalSink) => TerminalView;

const sameFrame = (a: TerminalFrame, b: TerminalFrame) => a.processId === b.processId && a.routingId === b.routingId;
const size = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000;

/** Терминалы, открытые видами: номер выдаёт главный процесс, ввод принимается только от фрейма, который терминал открыл. */
export class ViewTerminals {
  readonly #openTerminal: OpenTerminal;
  readonly #open = new Map<number, { frame: TerminalFrame; view: TerminalView }>();
  #next = 0;

  constructor(openTerminal: OpenTerminal) {
    this.#openTerminal = openTerminal;
  }

  open(frame: TerminalFrame, pluginId: string, ticket: unknown): Reply {
    if (typeof ticket !== 'string') return { error: 'terminal.open: билет - строка от PtyHandle.share()' };
    const tid = ++this.#next;
    const send = (event: object) => {
      try {
        if (!frame.detached) {
          frame.send('view:terminal', { tid, ...event });
          return;
        }
      } catch {
        // Фрейм уничтожен между проверкой и отправкой - ниже то же, что для отцепленного.
      }
      this.#drop(tid);
    };
    try {
      const view = this.#openTerminal(pluginId, ticket, {
        data: (data) => send({ data }),
        exit: (exit) => {
          send({ exit });
          this.#open.delete(tid);
        },
      });
      this.#open.set(tid, { frame, view });
      return { value: { id: view.id, pid: view.pid, program: view.program, args: view.args, persist: view.persist, backlog: view.backlog, tid } };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  write(frame: TerminalFrame, tid: unknown, data: unknown): Reply {
    if (typeof data !== 'string') return { error: 'terminal.write: ввод - строка' };
    return this.#with(frame, tid, (view) => view.write(data));
  }

  resize(frame: TerminalFrame, tid: unknown, cols: unknown, rows: unknown): Reply {
    if (!size(cols) || !size(rows)) return { error: 'terminal.resize: размер - целые 1..1000' };
    return this.#with(frame, tid, (view) => view.resize(cols as number, rows as number));
  }

  close(frame: TerminalFrame, tid: unknown): void {
    this.#with(frame, tid, () => this.#drop(tid as number));
  }

  get size(): number {
    return this.#open.size;
  }

  #with(frame: TerminalFrame, tid: unknown, act: (view: TerminalView) => void): Reply {
    const entry = typeof tid === 'number' ? this.#open.get(tid) : undefined;
    // Чужой номер неотличим от закрытого: другой фрейм не узнает, какие терминалы открыты.
    if (!entry || !sameFrame(entry.frame, frame)) return { error: `терминал ${String(tid)} закрыт` };
    try {
      act(entry.view);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  #drop(tid: number): void {
    this.#open.get(tid)?.view.close();
    this.#open.delete(tid);
  }
}
