import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PtyExit } from '@cyborg-harness/contracts';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TerminalSink } from '@cyborg-harness/core';
import { PtyTable, type PtyProcess } from '@cyborg-harness/core';
import { ViewTerminals, type TerminalFrame } from '../src/view-terminals.ts';

function frame(routingId: number) {
  const sent: unknown[] = [];
  const f: TerminalFrame & { detached: boolean; sent: unknown[] } = { processId: 1, routingId, detached: false, sent, send: (_channel, event) => void sent.push(event) };
  return f;
}

test('терминалы вида: вывод - в открывший фрейм, ввод и размер - только от него, отцепленный фрейм закрывает терминал', () => {
  const sinks: TerminalSink[] = [];
  const done: string[] = [];
  const terminals = new ViewTerminals((pluginId, ticket, sink) => {
    if (ticket !== 'билет') throw new Error('билет терминала не найден');
    sinks.push(sink);
    return { id: 'pty-1', pid: 7, program: '/bin/sh', args: [], persist: true, backlog: '$ ', write: (d) => void done.push(`${pluginId} write ${d}`), resize: (c, r) => void done.push(`resize ${String(c)}x${String(r)}`), close: () => void done.push('close') };
  });
  const own = frame(1);
  const other = frame(2);
  assert.deepEqual(terminals.open(own, 'echo', 'чужой'), { error: 'билет терминала не найден' });
  assert.deepEqual(terminals.open(own, 'echo', 42), { error: 'terminal.open: билет - строка от PtyHandle.share()' });
  const opened = terminals.open(own, 'echo', 'билет');
  assert.deepEqual(opened, { value: { id: 'pty-1', pid: 7, program: '/bin/sh', args: [], persist: true, backlog: '$ ', tid: 2 } });

  sinks[0]!.data('вывод');
  assert.deepEqual(own.sent, [{ tid: 2, data: 'вывод' }]);
  assert.deepEqual(terminals.write(own, 2, 'ls\r'), {});
  assert.deepEqual(terminals.write(other, 2, 'rm\r'), { error: 'терминал 2 закрыт' }, 'чужой фрейм пишет в терминал');
  assert.deepEqual(terminals.resize(own, 2, 0, 24), { error: 'terminal.resize: размер - целые 1..1000' });
  assert.deepEqual(terminals.resize(own, 2, 100, 30), {});
  terminals.close(other, 2);
  assert.equal(terminals.size, 1, 'чужой фрейм закрыл терминал');
  assert.deepEqual(done, ['echo write ls\r', 'resize 100x30']);

  own.detached = true;
  sinks[0]!.data('в пустоту');
  assert.equal(terminals.size, 0, 'терминал отцепленного фрейма остался открытым');
  assert.deepEqual(done.at(-1), 'close');

  const again = frame(3);
  terminals.open(again, 'echo', 'билет');
  const exit: PtyExit = { code: 0 };
  sinks[1]!.exit(exit);
  assert.deepEqual(again.sent, [{ tid: 3, exit }]);
  assert.equal(terminals.size, 0);
});

test('терминалы вида на таблице ядра: ввод больше предела - ошибка, терминал жив; тысяча кусков вывода - единицы сообщений во фрейм, exit после данных', async () => {
  const data = new Set<(d: string) => void>();
  const exits = new Set<(e: { exitCode: number }) => void>();
  const writes: string[] = [];
  const proc: PtyProcess = {
    pid: 9,
    onData: (l) => (data.add(l), { dispose: () => data.delete(l) }),
    onExit: (l) => (exits.add(l), { dispose: () => exits.delete(l) }),
    write: (d) => void writes.push(d),
    resize: () => undefined,
    kill: () => undefined,
  };
  const table = new PtyTable({ spawn: () => proc }, () => undefined, undefined, undefined, { ptyInput: 4, ptyFlushMs: 4 });
  const wire = table.spawn('term', { program: '/bin/sh', args: [], env: {}, cols: 80, rows: 24, persist: false });
  const terminals = new ViewTerminals((pluginId, ticket, sink) => table.openTerminal(pluginId, ticket, sink));
  const own = frame(1);
  const opened = terminals.open(own, 'term', table.share('term', wire.id));
  const tid = (opened.value as { tid: number }).tid;
  assert.match(terminals.write(own, tid, 'много').error ?? '', /больше 4 байт/);
  assert.deepEqual(terminals.write(own, tid, 'ls\r'), {});
  assert.deepEqual(writes, ['ls\r']);

  let all = '';
  for (let i = 0; i < 1000; i++) {
    all += String(i % 10);
    for (const l of data) l(String(i % 10));
    if (i === 499) await sleep(10);
  }
  for (const l of exits) l({ exitCode: 0 });
  const events = own.sent as { data?: string; exit?: PtyExit }[];
  assert.equal(events.map((e) => e.data ?? '').join(''), all);
  assert.ok(events.length < 10, `во фрейм ушло ${String(events.length)} сообщений на 1000 кусков`);
  assert.deepEqual(events.at(-1)?.exit, { code: 0 });
});
