import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { CoreError } from '../src/errors.ts';
import { load } from '../src/loader.ts';
import { inlineHosts } from '../src/transports.ts';
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

test('uninstall: недопустимый id (../, абсолютный путь, NUL, регистр) - Invalid, ни каталог рядом с данными, ни сами каталоги не тронуты', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-uninstall-id-')));
  try {
    const dataDir = path.join(root, 'data');
    const tempDir = path.join(root, 'temp');
    const precious = [path.join(root, 'precious.txt'), path.join(root, 'outside', 'keep.txt'), path.join(dataDir, 'jira', 'own.txt'), path.join(tempDir, 'jira', 'own.txt')];
    for (const f of precious) {
      await mkdir(path.dirname(f), { recursive: true });
      await writeFile(f, 'цело');
    }
    const deleted: string[] = [];
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
      enabled: [],
      manifests: [],
      os: {
        dataDir,
        tempDir,
        secrets: { available: () => true, get: async () => undefined, set: async () => undefined, delete: async () => undefined, deletePrefix: async (prefix) => {
            deleted.push(prefix);
            return 0;
          },
        },
      },
    });
    for (const id of ['..', '../outside', '../../etc', 'jira/..', 'jira/../..', '/etc/passwd', '', '.', 'jira\0', 'JIRA', 'jira x', `${dataDir}/jira`]) {
      await assert.rejects(k.uninstall(id), { code: 'Invalid' }, JSON.stringify(id));
    }
    for (const f of precious) assert.equal(await readFile(f, 'utf8'), 'цело', f);
    assert.deepEqual(deleted, [], 'в хранилище секретов недопустимый id не дошёл');
    assert.equal(k.journal.some((e) => e.kind === 'uninstalled'), false);
    await k.unload();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('cancel: собеседник отменяет только свои запросы, номера чужих запросов и не числа игнорируются' , async () => {
  const toA: ((m: unknown) => void)[] = [];
  const sent: unknown[] = [];
  const a = new Endpoint({ post: (m) => void sent.push(m), onMessage: (l) => void toA.push(l) });
  // a ждёт ответа на свой запрос номер 1 и сам исполняет запрос номер 5 собеседника
  let released: (() => void) | undefined;
  let aborted: boolean | undefined;
  a.handle('serve', (_p: unknown, signal: AbortSignal) => new Promise((resolve) => { released = () => { aborted = signal.aborted; resolve('ok'); }; }));
  const mine = a.request('mine', null).then(() => 'выполнен', (e: unknown) => e);
  toA[0]?.({ t: 'req', id: 5, m: 'serve', p: null });
  await new Promise((r) => setImmediate(r));
  // собеседник шлёт cancel с номером запроса, который ждёт сам a (1): a его не отдавал, значит, и отменять нечего
  for (const id of [1, 2, 6, 5.5, -5, Number.NaN, Infinity]) toA[0]?.({ t: 'cancel', id });
  for (const id of ['5', null, undefined, {}, [5]]) toA[0]?.({ t: 'cancel', id });
  await new Promise((r) => setImmediate(r));
  assert.equal(await Promise.race([mine, new Promise((r) => setTimeout(() => r('ждёт'), 50))]), 'ждёт', 'собственный запрос a не отменён чужим cancel');
  released?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(aborted, false, 'запрос 5 исполнялся до конца: cancel с чужим номером его не коснулся');
  assert.deepEqual(sent.filter((m) => (m as { t: string }).t === 'res'), [{ t: 'res', id: 5, ok: true, v: 'ok' }]);
});
