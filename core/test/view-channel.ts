import { MessageChannel } from 'node:worker_threads';
import type { PtyExit } from '@cyborg-harness/contracts';
import type { TerminalChannel } from '../src/pty.ts';

/** Вид глазами теста: второй конец порта, который главный процесс отдал бы фрейму. */
export interface FakeView {
  /** Что отдать ядру в `openTerminal`. */
  readonly channel: TerminalChannel;
  readonly data: string[];
  readonly exit: PtyExit[];
  /** Сколько раз главный процесс получил `closed`, и с каким выходом при потере pty-хоста. */
  readonly closed: (PtyExit | undefined)[];
  /** Порядок событий порта: `data` и `exit`. */
  readonly order: string[];
  /** Ввод и размер так, как их шлёт мост вида: запрос с номером, ответ с тем же номером. */
  write(data: unknown): Promise<{ ok?: true; error?: string }>;
  resize(cols: unknown, rows: unknown): Promise<{ ok?: true; error?: string }>;
  /** Закрыть порт со стороны фрейма. */
  close(): void;
}

export function fakeView(): FakeView {
  const { port1, port2 } = new MessageChannel();
  const data: string[] = [];
  const exit: PtyExit[] = [];
  const closed: (PtyExit | undefined)[] = [];
  const order: string[] = [];
  const pending = new Map<number, (reply: { ok?: true; error?: string }) => void>();
  let next = 0;
  port2.on('message', (m: Record<string, unknown>) => {
    if (typeof m.data === 'string') {
      data.push(m.data);
      order.push('data');
    } else if (m.exit !== undefined) {
      exit.push(m.exit as PtyExit);
      order.push('exit');
    }
    else if (typeof m.id === 'number') {
      const { id, ...reply } = m;
      pending.get(id)?.(reply);
    }
  });
  // Порты не держат цикл событий теста: закрывать их в каждом тесте было бы шумом (`on('message')` берёт порт в цикл, поэтому после него).
  port1.unref();
  port2.unref();
  const ask = (message: Record<string, unknown>) =>
    new Promise<{ ok?: true; error?: string }>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      port2.postMessage({ id, ...message });
    });
  return {
    channel: { hostEnd: port1, closed: (lost) => void closed.push(lost) },
    data,
    exit,
    closed,
    order,
    write: (d) => ask({ op: 'write', data: d }),
    resize: (cols, rows) => ask({ op: 'resize', cols, rows }),
    close: () => port2.close(),
  };
}
