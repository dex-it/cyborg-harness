import type { MessagePortMain } from 'electron';
import type { PtyExit } from '@cyborg-harness/contracts';
import type { TerminalChannel, TerminalView } from '@cyborg-harness/core';
import { errorMessage } from './guards.ts';
import type { Reply } from './snapshot.ts';

/** То, что нужно от `WebFrameMain`: тест подставляет свой фрейм без Electron. */
export interface TerminalFrame {
  readonly processId: number;
  readonly routingId: number;
  readonly detached: boolean;
  send(channel: string, ...args: unknown[]): void;
  /** Передать фрейму порт: `MessagePortMain` из `MessageChannelMain`. */
  postMessage(channel: string, message: unknown, transfer: MessagePortMain[]): void;
}

/** Пара портов `MessageChannelMain`: `port1` уходит pty-хосту, `port2` - фрейму вида. */
export interface PortPair {
  readonly port1: MessagePortMain;
  readonly port2: MessagePortMain;
}

type OpenTerminal = (pluginId: string, ticket: string, channel: TerminalChannel) => Promise<TerminalView>;

const sameFrame = (a: TerminalFrame, b: TerminalFrame) => a.processId === b.processId && a.routingId === b.routingId;

/**
 * Терминалы, открытые видами. Главный процесс только раздаёт концы порта: вывод идёт из pty-хоста во фрейм, ввод и размер - обратно по тому же порту,
 * в потоке главного процесса нет. Номер терминала выдаёт он же; закрыть терминал может только фрейм, который его открыл.
 */
export class ViewTerminals {
  readonly #openTerminal: OpenTerminal;
  readonly #channel: () => PortPair;
  readonly #open = new Map<number, { frame: TerminalFrame; view: TerminalView }>();
  #next = 0;

  constructor(openTerminal: OpenTerminal, channel: () => PortPair) {
    this.#openTerminal = openTerminal;
    this.#channel = channel;
  }

  async open(frame: TerminalFrame, pluginId: string, ticket: unknown): Promise<Reply> {
    if (typeof ticket !== 'string') return { error: 'terminal.open: билет - строка от PtyHandle.share()' };
    const tid = ++this.#next;
    const ports = this.#channel();
    // Канал закрыт, пока шёл `openTerminal`: учёта у терминала ещё нет, а после ответа он уже не нужен.
    let ended: { lost: PtyExit | undefined } | undefined;
    const channel: TerminalChannel = {
      hostEnd: ports.port1,
      closed: (lost?: PtyExit) => {
        ended ??= { lost };
        this.#open.delete(tid);
        // Порт молчит, когда pty-хост потерян: о конце вид узнаёт только отсюда. Это событие управления, а не данные.
        if (lost !== undefined) this.#notify(frame, { tid, exit: lost });
      },
    };
    let view: TerminalView;
    try {
      view = await this.#openTerminal(pluginId, ticket, channel);
    } catch (error) {
      ports.port1.close();
      ports.port2.close();
      return { error: errorMessage(error) };
    }
    if (frame.detached) {
      view.close();
      ports.port2.close();
      return { error: 'фрейм вида закрыт' };
    }
    // Потерянный pty-хост выхода в порт не пошлёт, а событие управления вид не свяжет с терминалом, которого он ещё не открыл.
    if (ended?.lost !== undefined) {
      view.close();
      ports.port1.close();
      ports.port2.close();
      return { error: 'pty-хост потерян, пока терминал открывался' };
    }
    try {
      frame.postMessage('view:terminal:port', { tid }, [ports.port2]);
    } catch (error) {
      view.close();
      return { error: errorMessage(error) };
    }
    // Обычный выход порт доставит сам: фрейм получает его и читает выход оттуда.
    if (ended === undefined) this.#open.set(tid, { frame, view });
    return { value: { id: view.id, pid: view.pid, program: view.program, args: view.args, persist: view.persist, backlog: view.backlog, input: view.input, tid } };
  }

  close(frame: TerminalFrame, tid: unknown): void {
    const entry = typeof tid === 'number' ? this.#open.get(tid) : undefined;
    // Чужой номер неотличим от закрытого: другой фрейм не узнает, какие терминалы открыты.
    if (!entry || !sameFrame(entry.frame, frame)) return;
    this.#open.delete(tid as number);
    entry.view.close();
  }

  get size(): number {
    return this.#open.size;
  }

  #notify(frame: TerminalFrame, event: object): void {
    try {
      if (!frame.detached) frame.send('view:terminal', event);
    } catch {
      // Фрейм уничтожен между проверкой и отправкой: слушать некому.
    }
  }
}
