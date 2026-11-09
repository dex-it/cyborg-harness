import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessagePortMain } from 'electron';
import type { PtyExit } from '@cyborg-harness/contracts';
import { inlinePtyHost, PtyTable, type PtyProcess, type TerminalChannel, type TerminalView } from '@cyborg-harness/core';
import { ViewTerminals, type PortPair, type TerminalFrame } from '../src/view-terminals.ts';

function frame(routingId: number) {
  const sent: unknown[] = [];
  const posted: { channel: string; message: unknown; transfer: unknown[] }[] = [];
  const f: TerminalFrame & { detached: boolean; sent: unknown[]; posted: typeof posted } = {
    processId: 1,
    routingId,
    detached: false,
    sent,
    posted,
    send: (_channel, event) => void sent.push(event),
    postMessage: (channel, message, transfer) => void posted.push({ channel, message, transfer }),
  };
  return f;
}

/** Пара портов, которая считает закрытия: `MessageChannelMain` в тесте без Electron подменён ею. */
function fakePair() {
  const closed: string[] = [];
  const pair = { port1: { close: () => void closed.push('host') }, port2: { close: () => void closed.push('view') } } as unknown as PortPair;
  return { pair, closed };
}

test('терминалы вида: порт уходит фрейму и pty-хосту, данные через главный процесс не идут; закрыть может только открывший фрейм', async () => {
  const done: string[] = [];
  let channel: TerminalChannel | undefined;
  const pairs: ReturnType<typeof fakePair>[] = [];
  const terminals = new ViewTerminals(
    (_pluginId, ticket, ch) => {
      if (ticket !== 'билет') return Promise.reject(new Error('билет терминала не найден'));
      channel = ch;
      const view: TerminalView = { id: 'pty-1', pid: 7, program: '/bin/sh', args: [], persist: true, backlog: '$ ', close: () => void done.push('close') };
      return Promise.resolve(view);
    },
    () => {
      const p = fakePair();
      pairs.push(p);
      return p.pair;
    },
  );
  const own = frame(1);
  const other = frame(2);

  assert.deepEqual(await terminals.open(own, 'echo', 42), { error: 'terminal.open: билет - строка от PtyHandle.share()' });
  assert.deepEqual(await terminals.open(own, 'echo', 'чужой'), { error: 'билет терминала не найден' });
  assert.deepEqual(pairs[0]?.closed, ['host', 'view'], 'после отказа порты остались открытыми');

  const opened = await terminals.open(own, 'echo', 'билет');
  assert.deepEqual(opened, { value: { id: 'pty-1', pid: 7, program: '/bin/sh', args: [], persist: true, backlog: '$ ', tid: 2 } });
  assert.equal(channel?.hostEnd, pairs[1]?.pair.port1, 'ядру ушёл не тот конец порта');
  assert.deepEqual(own.posted.map((p) => [p.channel, p.message]), [['view:terminal:port', { tid: 2 }]]);
  assert.deepEqual(own.posted[0]?.transfer, [pairs[1]?.pair.port2], 'фрейм получил не свой конец порта');
  assert.deepEqual(own.sent, [], 'данные терминала пошли через frame.send');
  assert.deepEqual(pairs[1]?.closed, []);

  terminals.close(other, 2);
  assert.equal(terminals.size, 1, 'чужой фрейм закрыл терминал');
  assert.deepEqual(done, []);
  terminals.close(own, 2);
  assert.deepEqual([terminals.size, done], [0, ['close']]);
});

test('терминалы вида: pty-хост потерян - вид узнаёт о конце событием управления; обычное закрытие канала ничего во фрейм не шлёт; отцепленному фрейму не шлётся', async () => {
  const channels: TerminalChannel[] = [];
  const terminals = new ViewTerminals(
    (_p, _t, ch) => {
      channels.push(ch);
      return Promise.resolve({ id: 'pty-1', pid: 7, program: 'sh', args: [], persist: false, backlog: '', close: () => undefined });
    },
    () => fakePair().pair,
  );
  const a = frame(1);
  const b = frame(2);
  const c = frame(3);
  await terminals.open(a, 'echo', 't');
  await terminals.open(b, 'echo', 't');
  await terminals.open(c, 'echo', 't');
  const lost: PtyExit = { code: -1 };
  channels[0]?.closed(lost);
  channels[1]?.closed();
  c.detached = true;
  channels[2]?.closed(lost);
  assert.deepEqual(a.sent, [{ tid: 1, exit: lost }]);
  assert.deepEqual(b.sent, [], 'выход без потери пришёл бы по порту, а не отсюда');
  assert.deepEqual(c.sent, []);
  assert.equal(terminals.size, 0);
});

test('терминалы вида: фрейм ушёл, пока терминал открывался, - терминал закрыт, порты не висят; порт не передался - ошибка', async () => {
  const done: string[] = [];
  const pairs: ReturnType<typeof fakePair>[] = [];
  const terminals = new ViewTerminals(
    () => Promise.resolve({ id: 'pty-1', pid: 7, program: 'sh', args: [], persist: false, backlog: '', close: () => void done.push('close') }),
    () => {
      const p = fakePair();
      pairs.push(p);
      return p.pair;
    },
  );
  const gone = frame(1);
  gone.detached = true;
  assert.match((await terminals.open(gone, 'echo', 't')).error ?? '', /фрейм вида закрыт/);
  assert.deepEqual([done, pairs[0]?.closed], [['close'], ['view']]);

  const broken = frame(2);
  broken.postMessage = () => {
    throw new Error('Render frame was disposed');
  };
  assert.match((await terminals.open(broken, 'echo', 't')).error ?? '', /disposed/);
  assert.equal(terminals.size, 0);
});

test('терминалы вида на таблице ядра: тысяча кусков вывода - единицы сообщений в порт и ни одного через frame.send, exit после данных; ввод больше предела - ошибка, терминал жив', async () => {
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
  const table = new PtyTable(inlinePtyHost({ spawn: () => proc }), () => undefined, { ptyInput: 4, ptyFlushMs: 4 });
  const wire = await table.spawn('term', { program: '/bin/sh', args: [], env: {}, cols: 80, rows: 24, persist: false });
  const channel = new MessageChannel();
  channel.port1.unref();
  channel.port2.unref();
  const terminals = new ViewTerminals((pluginId, ticket, ch) => table.openTerminal(pluginId, ticket, ch), () => channel as unknown as { port1: MessagePortMain; port2: MessagePortMain });
  const own = frame(1);
  const events: { data?: string; exit?: PtyExit; id?: number; ok?: boolean; error?: string }[] = [];
  channel.port2.on('message', (m: (typeof events)[number]) => void events.push(m));
  channel.port2.unref();
  const opened = await terminals.open(own, 'term', table.share('term', wire.id));
  assert.equal((opened.value as { tid: number }).tid, 1);

  channel.port2.postMessage({ id: 1, op: 'write', data: 'много' });
  channel.port2.postMessage({ id: 2, op: 'write', data: 'ls\r' });
  await sleep(30);
  assert.match(events.find((e) => e.id === 1)?.error ?? '', /больше 4 байт/);
  assert.equal(events.find((e) => e.id === 2)?.ok, true);
  assert.deepEqual(writes, ['ls\r']);

  let all = '';
  for (let i = 0; i < 1000; i++) {
    all += String(i % 10);
    for (const l of data) l(String(i % 10));
    if (i === 499) await sleep(10);
  }
  for (const l of exits) l({ exitCode: 0 });
  await sleep(50);
  const output = events.filter((e) => e.data !== undefined);
  assert.equal(output.map((e) => e.data).join(''), all);
  assert.ok(output.length < 10, `в порт ушло ${String(output.length)} сообщений на 1000 кусков`);
  assert.deepEqual(events.at(-1)?.exit, { code: 0 });
  assert.deepEqual(own.sent, [], 'вывод терминала пошёл через frame.send');
  assert.equal(terminals.size, 0, 'выход pty не снял терминал с учёта');
  await table.releaseAll();
});
