import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoreError } from '../src/errors.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Endpoint, type Owner, type Port } from '../src/rpc.ts';

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

test('ST-2001/5: функция не проходит границу ни в аргументах, ни в результате', async () => {
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

test('cancel: причина вне Cancelled, Timeout и HostGone приводится к Cancelled', async () => {
  const sent: unknown[] = [];
  const listeners: ((m: unknown) => void)[] = [];
  const server = new Endpoint({ post: (m) => void sent.push(m), onMessage: (l) => void listeners.push(l) });
  const reasons: unknown[] = [];
  server.handle('work', (_params, signal) => {
    signal.addEventListener('abort', () => reasons.push(signal.reason));
    return new Promise(() => undefined);
  });
  const codes = ['Timeout', 'HostGone', 'Cancelled', 'PermissionDenied', 'NotFound', 'Remote', 'нет такого кода'];
  for (const [i, code] of codes.entries()) {
    listeners[0]?.({ t: 'req', id: i + 1, m: 'work', p: null });
    await later();
    listeners[0]?.({ t: 'cancel', id: i + 1, reason: { code, message: 'подделка' } });
    await later();
  }
  const expected = ['Timeout', 'HostGone', 'Cancelled', 'Cancelled', 'Cancelled', 'Cancelled', 'Cancelled'];
  assert.deepEqual(
    reasons.map((r) => (r as CoreError).code),
    expected,
  );
  assert.deepEqual(
    sent.map((m) => (m as { e: { code: string } }).e.code),
    expected,
    'собеседник получает отказ с тем же кодом, что видит обработчик',
  );
});

test('отмена ждущего запроса входит в плагин-вызывающий, как ответ: продолжение после отказа не приписывается чужому', async () => {
  let current: string | undefined = 'caller';
  const entered: (string | undefined)[] = [];
  const owner = {
    current: () => current,
    enter(id: string | undefined) {
      current = id;
      entered.push(id);
    },
    chain: () => undefined,
    within: <R>(_chain: number | undefined, run: () => R) => run(),
  };
  const endpoint = new Endpoint({ post: () => undefined, onMessage: () => undefined }, owner);
  const abort = new AbortController();
  const call = endpoint.request('work', null, abort.signal);
  current = 'other'; // сигнал сработал вне входа плагина: последним отметился другой
  entered.length = 0;
  abort.abort();
  await assert.rejects(call, { code: 'Cancelled' });
  assert.deepEqual(entered, ['caller']);
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

/** Owner с цепочкой в AsyncLocalStorage, как у ядра и хоста (core/src/trace.ts, host-runtime.ts). */
function chained(): Owner & { readonly als: AsyncLocalStorage<number | undefined> } {
  const als = new AsyncLocalStorage<number | undefined>();
  return { als, current: () => undefined, enter: () => undefined, chain: () => als.getStore(), within: (chain, run) => als.run(chain, run) };
}

test('цепочка: запрос и уведомление несут номер цепочки Owner, обработчик собеседника идёт внутри неё, ответный запрос продолжает её (FR-CH-4002)', async () => {
  const listeners: [((m: unknown) => void)[], ((m: unknown) => void)[]] = [[], []];
  const sent: unknown[] = [];
  const port = (to: 0 | 1, from: 0 | 1): Port => ({
    post(message) {
      sent.push(message);
      const copy = structuredClone(message);
      setImmediate(() => listeners[to].forEach((l) => l(copy)));
    },
    onMessage: (l) => void listeners[from].push(l),
  });
  const [oa, ob] = [chained(), chained()];
  const a = new Endpoint(port(1, 0), oa);
  const b = new Endpoint(port(0, 1), ob);
  const seen: unknown[] = [];
  b.handle('work', async () => {
    seen.push(['work', ob.chain()]);
    await b.request('back', null);
    return ob.chain();
  });
  a.handle('back', () => void seen.push(['back', oa.chain()]));
  b.handle('note', () => void seen.push(['note', ob.chain()]));

  assert.equal(await oa.als.run(7, () => a.request('work', null)), 7);
  oa.als.run(8, () => a.notify('note', null));
  a.notify('note', null);
  await a.request('back', null).catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [['work', 7], ['back', 7], ['note', 8], ['note', undefined]]);
  assert.ok(sent.some((m) => (m as { t: string; c?: number }).t === 'req' && (m as { c?: number }).c === 7));
  assert.ok(sent.filter((m) => (m as { t: string }).t === 'res').every((m) => !('c' in (m as object))), 'ответ номера не несёт');
});

test('цепочка: номер не по форме от собеседника отбрасывается, обработчик идёт вне цепочки, а не в цепочке того, кто доставил сообщение', async () => {
  const owner = chained();
  let deliver: (m: unknown) => void = () => undefined;
  const seen: unknown[] = [];
  const b = new Endpoint({ post: () => undefined, onMessage: (l) => (deliver = l) }, owner);
  b.handle('work', () => void seen.push(owner.chain()));
  owner.als.run(5, () => {
    for (const c of ['x', 1.5, null, Number.NaN, undefined]) deliver({ t: 'note', m: 'work', p: null, c });
    deliver({ t: 'note', m: 'work', p: null, c: 3 });
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [undefined, undefined, undefined, undefined, undefined, 3]);
});
