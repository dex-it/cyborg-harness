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
