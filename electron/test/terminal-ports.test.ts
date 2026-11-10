import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TerminalEvent } from '../src/view-protocol.ts';
import { waitFor } from './wait-for.ts';
import { terminalPorts, type PortLike } from '../src/terminal-ports.ts';

/** Порт preload (`port1`) и «pty-хост» по ту сторону (`host`); у `MessagePort` Node слушатель назначается так же. */
function pair() {
  const { port1, port2 } = new MessageChannel();
  port1.unref();
  port2.unref();
  const seen: unknown[] = [];
  port2.on('message', (m) => void seen.push(m));
  port2.unref();
  const port = {
    set onmessage(handler: ((event: { data: unknown }) => void) | null) {
      port1.removeAllListeners('message');
      if (handler) port1.on('message', (data: unknown) => handler({ data }));
      port1.unref();
    },
    postMessage: (m: unknown) => port1.postMessage(m),
    close: () => port1.close(),
  } as unknown as PortLike;
  return { port, host: port2, seen };
}

test('порт терминала: данные и выход приходят событиями, ввод и размер - запросами с ответом по номеру', async () => {
  const ports = terminalPorts();
  const events: TerminalEvent[] = [];
  ports.listen((e) => void events.push(e));
  const { port, host, seen } = pair();
  ports.arrived(3, port);
  assert.equal(await ports.connect(3), true);

  host.postMessage({ data: 'вывод' });
  const write = ports.request(3, { op: 'write', data: 'ls\r' });
  const resize = ports.request(3, { op: 'resize', cols: 0, rows: 24 });
  await waitFor('оба запроса дошли до хоста', () => seen.length >= 2);
  assert.deepEqual(seen, [{ id: 1, op: 'write', data: 'ls\r' }, { id: 2, op: 'resize', cols: 0, rows: 24 }]);
  host.postMessage({ id: 2, error: 'terminal.resize: размер - целые 1..1000' });
  host.postMessage({ id: 1, ok: true });
  assert.deepEqual(await write, {});
  assert.deepEqual(await resize, { error: 'terminal.resize: размер - целые 1..1000' });

  host.postMessage({ exit: { code: 0 } });
  host.postMessage({ data: 'после выхода не бывает' });
  await waitFor('вывод и выход дошли до вида', () => events.length >= 2);
  // Отсутствие события: сообщение после выхода идёт за ним по тому же порту и уже доставлено или не придёт.
  await sleep(20);
  assert.deepEqual(events, [{ tid: 3, data: 'вывод' }, { tid: 3, exit: { code: 0 } }]);
  assert.deepEqual(await ports.request(3, { op: 'write', data: 'x' }), { error: 'терминал 3 закрыт' }, 'порт после выхода остался открытым');
});

test('порт терминала: порт приходит позже ответа - connect ждёт его; не пришёл за срок - false; чужие и кривые сообщения отбрасываются', async () => {
  const ports = terminalPorts(60);
  const events: TerminalEvent[] = [];
  ports.listen((e) => void events.push(e));
  const { port, host } = pair();
  const connecting = ports.connect(5);
  setTimeout(() => ports.arrived(5, port), 10);
  assert.equal(await connecting, true);
  host.postMessage('строка');
  host.postMessage({ exit: 'нет' });
  host.postMessage({ id: 99, ok: true });
  host.postMessage({ data: 'ok' });
  await waitFor('данные дошли до вида', () => events.length >= 1);
  // Отсутствие события: строка, кривой exit и чужой id идут до данных по тому же порту и уже отброшены.
  assert.deepEqual(events, [{ tid: 5, data: 'ok' }]);
  assert.equal(await ports.connect(6), false);
});

test('порт терминала: закрыт вызовом или потерей pty-хоста - ждущие запросы получают отказ, вид получает exit', async () => {
  const ports = terminalPorts();
  const events: TerminalEvent[] = [];
  ports.listen((e) => void events.push(e));
  const a = pair();
  const b = pair();
  ports.arrived(1, a.port);
  ports.arrived(2, b.port);
  await ports.connect(1);
  await ports.connect(2);
  const waiting = ports.request(1, { op: 'write', data: 'x' });
  ports.close(1);
  assert.deepEqual(await waiting, { error: 'терминал 1 закрыт' });
  assert.deepEqual(await ports.request(1, { op: 'write', data: 'y' }), { error: 'терминал 1 закрыт' });

  const pending = ports.request(2, { op: 'resize', cols: 80, rows: 24 });
  ports.lost({ tid: 2, exit: { code: -1 } });
  assert.deepEqual(events, [{ tid: 2, exit: { code: -1 } }]);
  assert.deepEqual(await pending, { error: 'терминал 2 закрыт' });
});

test('порт терминала: не пришёл за срок - отказ, и опоздавший порт закрывается, а не копит вывод (ревью K-01)', async () => {
  const ports = terminalPorts(20);
  const events: TerminalEvent[] = [];
  ports.listen((e) => void events.push(e));
  assert.equal(await ports.connect(8), false);
  const late = pair();
  let closed = 0;
  const port = { ...late.port, set onmessage(_h: unknown) {}, close: () => {
      closed++;
      late.port.close();
    },
  } as unknown as PortLike;
  ports.arrived(8, port);
  assert.equal(closed, 1, 'опоздавший порт отказанного терминала остался открытым');
  late.host.postMessage({ data: 'вывод в никуда' });
  await sleep(20);
  assert.deepEqual(events, []);
  assert.deepEqual(await ports.request(8, { op: 'write', data: 'x' }), { error: 'терминал 8 закрыт' });
});
