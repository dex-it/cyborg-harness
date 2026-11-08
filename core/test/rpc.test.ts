import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoreError } from '../src/errors.ts';
import { Endpoint, type Port } from '../src/rpc.ts';

function pair(): [Endpoint, Endpoint] {
  const listeners: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
  const port = (to: 0 | 1, from: 0 | 1): Port => ({
    post(message) {
      const copy = structuredClone(message);
      setImmediate(() => listeners[to].forEach((l) => l(copy)));
    },
    onMessage: (l) => void listeners[from].push(l),
  });
  return [new Endpoint(port(1, 0)), new Endpoint(port(0, 1))];
}

test('запрос, ответ, ошибка с кодом и уведомление', async () => {
  const [a, b] = pair();
  const notes: unknown[] = [];
  b.handle('sum', ({ x, y }: { x: number; y: number }) => x + y);
  b.handle('deny', () => {
    throw new CoreError('Unavailable', 'нет');
  });
  b.handle('plain', () => {
    throw new Error('обычная');
  });
  b.handle('note', (p) => void notes.push(p));
  assert.equal(await a.request('sum', { x: 2, y: 3 }), 5);
  await assert.rejects(a.request('deny', null), { code: 'Unavailable', message: 'нет' });
  await assert.rejects(a.request('plain', null), { code: 'Remote', message: 'обычная' });
  await assert.rejects(a.request('nobody', null), { code: 'Remote' });
  a.notify('note', { n: 1 });
  await a.request('sum', { x: 0, y: 0 });
  assert.deepEqual(notes, [{ n: 1 }]);
});

test('функция не проходит границу ни в аргументах, ни в результате', async () => {
  const [a, b] = pair();
  b.handle('leak', () => ({ cb: () => 0 }));
  await assert.rejects(a.request('echo', { cb: () => 0 }), { code: 'NotCloneable' });
  await assert.rejects(a.request('leak', null), { code: 'NotCloneable', message: /leak: результат/ });
});

test('close отклоняет ждущих и новые запросы', async () => {
  const [a, b] = pair();
  b.handle('never', () => new Promise(() => {}));
  const pending = a.request('never', null);
  await new Promise((r) => setImmediate(r));
  a.close(new CoreError('HostGone', 'упал'));
  await assert.rejects(pending, { code: 'HostGone' });
  await assert.rejects(a.request('never', null), { code: 'HostGone' });
  assert.equal(a.closed, true);
});

const later = () => new Promise((r) => setImmediate(r));

/** Обработчик, который висит, пока его не отпустят; сигналы запоминает. */
function slow() {
  const seen: AbortSignal[] = [];
  const waiting: (() => void)[] = [];
  return {
    seen,
    finish: () => waiting.splice(0).forEach((w) => w()),
    handler: (_p: unknown, signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<string>((resolve) => waiting.push(() => resolve('готово')));
    },
  };
}

const first = (s: ReturnType<typeof slow>): AbortSignal => {
  const signal = s.seen[0];
  assert.ok(signal, 'обработчик не вызван');
  return signal;
};

test('отмена: обработчик получает сигнал, вызывающий - отказ Cancelled, поздний ответ отбрасывается', async () => {
  const [a, b] = pair();
  const s = slow();
  b.handle('work', s.handler);
  const abort = new AbortController();
  const pending = a.request('work', null, abort.signal);
  await later();
  assert.equal(first(s).aborted, false);
  abort.abort();
  await assert.rejects(pending, { code: 'Cancelled' });
  await later();
  await later();
  assert.equal(first(s).aborted, true);
  assert.equal((first(s).reason as CoreError).code, 'Cancelled');
  s.finish();
  await later();
  b.handle('ping', () => 'pong');
  assert.equal(await a.request('ping', null), 'pong');
});

test('отмена: уже отменённый сигнал запроса не шлёт, причина-CoreError доходит как есть', async () => {
  const [a, b] = pair();
  let calls = 0;
  b.handle('work', () => { calls++; });
  await assert.rejects(a.request('work', null, AbortSignal.abort()), { code: 'Cancelled' });
  await assert.rejects(a.request('work', null, AbortSignal.abort(new CoreError('Timeout', 'срок'))), { code: 'Timeout', message: 'срок' });
  await later();
  await later();
  assert.equal(calls, 0);
});

test('отмена после ответа и двойная отмена безвредны', async () => {
  const [a, b] = pair();
  b.handle('sum', ({ x, y }: { x: number; y: number }) => x + y);
  const abort = new AbortController();
  assert.equal(await a.request('sum', { x: 1, y: 2 }, abort.signal), 3);
  abort.abort();
  abort.abort();
  const s = slow();
  b.handle('work', s.handler);
  const second = new AbortController();
  const pending = a.request('work', null, second.signal);
  await later();
  second.abort();
  second.abort();
  await assert.rejects(pending, { code: 'Cancelled' });
  await later();
  assert.equal(await a.request('sum', { x: 2, y: 2 }), 4);
});

test('отмена: ответ, обогнавший отмену, отдаётся в discard', async () => {
  const [a, b] = pair();
  b.handle('make', () => 'подписка');
  const abort = new AbortController();
  const late: unknown[] = [];
  const pending = a.request('make', null, abort.signal, (v) => void late.push(v));
  abort.abort();
  await assert.rejects(pending, { code: 'Cancelled' });
  await later();
  await later();
  assert.deepEqual(late, ['подписка']);
});

test('cancel с неизвестным номером или не числом ничего не отменяет', async () => {
  const sent: unknown[] = [];
  const listeners: ((m: unknown) => void)[] = [];
  const server = new Endpoint({ post: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) });
  const s = slow();
  server.handle('work', s.handler);
  listeners[0]?.({ t: 'req', id: 7, m: 'work', p: null });
  await later();
  for (const id of [999, -1, 1.5, '7', null, undefined]) listeners[0]?.({ t: 'cancel', id });
  await later();
  assert.equal(first(s).aborted, false);
  listeners[0]?.({ t: 'cancel', id: 7 });
  await later();
  assert.equal(first(s).aborted, true);
  assert.deepEqual(sent, [{ t: 'res', id: 7, ok: false, e: { code: 'Cancelled', message: 'запрос отменён' } }]);
  s.finish();
  await later();
  assert.equal(sent.length, 1);
});

test('close обрывает работу обработчиков: сигнал отменён с причиной закрытия', async () => {
  const [a, b] = pair();
  const s = slow();
  b.handle('work', s.handler);
  a.request('work', null).catch(() => undefined);
  await later();
  b.close(new CoreError('HostGone', 'упал'));
  assert.equal(first(s).aborted, true);
  assert.equal((first(s).reason as CoreError).code, 'HostGone');
});
