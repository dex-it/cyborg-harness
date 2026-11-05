import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { CoreError } from '../src/errors.ts';
import { resolveGraph } from '../src/graph.ts';
import { normalizeKey } from '../src/keys.ts';
import { parseManifest, type PluginManifest } from '../src/manifest.ts';
import { ContractRegistry } from '../src/registry.ts';
import { Endpoint } from '../src/rpc.ts';
import { HttpServes } from '../src/serve.ts';

const base = (id: string, extra: object = {}) => ({ id, version: '1.0.0', engines: { cyborg: '*' }, ...extra });

function parsed(raw: unknown): PluginManifest {
  const r = parseManifest(raw);
  assert.ok(r.ok, JSON.stringify(r));
  return r.manifest;
}

/** Отказы промисов вне await: в главном процессе Electron это окно ошибки, в Node - падение процесса. */
async function unhandledDuring(run: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const listener = (e: unknown) => seen.push(String(e));
  process.on('unhandledRejection', listener);
  try {
    await run();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

test('манифест: имя из прототипа объекта в keybindings - отказ манифеста, а не исключение разбора', () => {
  const r = parseManifest(base('a', { commands: ['a.x'], keybindings: [{ key: 'F5', command: 'constructor' }] }));
  assert.equal(r.ok, false);
});

test('манифест: контракт constructor в requires - не «одновременно в optional»', () => {
  const r = parseManifest(base('a', { requires: { constructor: '*' } }));
  assert.ok(r.ok, JSON.stringify(r));
});

test('граф: контракт constructor в optional не роняет решение графа соседям', () => {
  const a = parsed(base('a', { optional: { constructor: '*' } }));
  const b = parsed(base('b'));
  const graph = resolveGraph([a, b], '1.0.0');
  assert.deepEqual(graph.order, ['a', 'b']);
  assert.equal(graph.bindings.get('a')?.size, 0);
});

test('клавиши: constructor и __proto__ - не модификаторы, голая буква не проходит', () => {
  assert.equal(normalizeKey('constructor+A'), undefined);
  assert.equal(normalizeKey('__proto__+Shift+A'), undefined);
  assert.equal(normalizeKey('CmdOrCtrl+A'), 'CmdOrCtrl+A');
});

test('реестр: контракт constructor, не объявленный потребителем, - NotDeclared', () => {
  const a = parsed(base('a'));
  const registry = new ContractRegistry([a], new Map());
  for (const call of [() => registry.get('a', 'constructor', 1), () => registry.all('a', 'constructor', 1), () => registry.onChange('a', 'constructor', () => undefined)]) {
    assert.throws(call, (e: unknown) => e instanceof CoreError && e.code === 'NotDeclared');
  }
});

test('канал: сообщение хоста не по форме не даёт необработанных отказов, ждущий запрос получает ошибку', async () => {
  let deliver: (m: unknown) => void = () => undefined;
  const ep = new Endpoint({ post: () => undefined, onMessage: (l) => (deliver = l) });
  let settled: unknown = 'не завершён';
  const seen = await unhandledDuring(async () => {
    const pending = ep.request('x', null).then(
      () => 'выполнен',
      (e: unknown) => e,
    );
    for (const junk of [null, 42, 'res', { t: 'res' }, { t: 'req', id: 'x', m: 1 }]) deliver(junk);
    deliver({ t: 'res', id: 1, ok: false, e: null });
    settled = await Promise.race([pending, new Promise((r) => setTimeout(() => r('не завершён'), 200))]);
  });
  assert.deepEqual(seen, []);
  assert.ok(settled instanceof CoreError, String(settled));
});

test('serve: клиент оборвал тело запроса - сервер живёт, необработанных отказов нет', async () => {
  const serves = new HttpServes(() => Promise.resolve({ status: 200, body: 'ok' }), 2000);
  const url = await serves.open('p', 'a');
  const port = Number(new URL(url).port);
  try {
    const seen = await unhandledDuring(async () => {
      await new Promise<void>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => {
          s.write(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nContent-Length: 100\r\n\r\nabc`);
          setTimeout(() => s.destroy(), 30);
        });
        s.on('close', () => resolve());
        s.on('error', () => resolve());
      });
    });
    assert.deepEqual(seen, []);
    const res = await fetch(url, { method: 'POST', body: 'x' });
    assert.equal(res.status, 200);
  } finally {
    serves.forget('p');
  }
});
