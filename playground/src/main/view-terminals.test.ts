import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PtyExit } from '@cyborg/contracts';
import type { TerminalSink } from '../../../core/src/index.ts';
import { ViewTerminals, type TerminalFrame } from './view-terminals.ts';

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
