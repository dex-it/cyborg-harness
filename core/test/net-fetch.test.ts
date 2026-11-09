import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load as loadKernel, type Kernel, type LoadOptions } from '../src/loader.ts';
import { trackKernels } from './kernels.ts';
import { guardedLookup, isLocalAddress, type Lookup } from '../src/net-transport.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// Ядро выгружается после каждого теста файла, и упавшим тоже: иначе слежение и программы держат процесс файла (core/test/kernels.ts).
const track = trackKernels();
const load = async (options: LoadOptions): Promise<Kernel> => track(await loadKernel(options));

const LOCAL = ['127.0.0.1', '127.255.255.254', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255'];
const PUBLIC = ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '192.169.0.1', '169.253.0.1'];
const LOCAL_V6 = ['::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:a9fe:a9fe', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::', '::127.0.0.1'];
const PUBLIC_V6 = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::'];

test('isLocalAddress: loopback, частные, link-local, служебные и вложенный IPv4 - да; публичные - нет', () => {
  for (const a of [...LOCAL, ...LOCAL_V6]) assert.equal(isLocalAddress(a), true, a);
  for (const a of [...PUBLIC, ...PUBLIC_V6]) assert.equal(isLocalAddress(a), false, a);
  assert.equal(isLocalAddress('не адрес'), true, 'непонятное отвергается');
});

const answer = (map: Record<string, string[]>): { lookup: Lookup; calls: string[] } => {
  const calls: string[] = [];
  const lookup = ((hostname: string, options: { all?: boolean }, callback: (error: Error | null, result?: unknown, family?: number) => void) => {
    calls.push(hostname);
    const addresses = (map[hostname] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (addresses.length === 0) callback(Object.assign(new Error('нет'), { code: 'ENOTFOUND' }));
    else if (options.all) callback(null, addresses);
    else callback(null, addresses[0]?.address, addresses[0]?.family);
  }) as unknown as Lookup;
  return { lookup, calls };
};

test('guardedLookup: каждый адрес ответа проходит проверку, один плохой - отказ всего ответа; форма ответа по options.all', async () => {
  const { lookup } = answer({ mixed: ['8.8.8.8', '127.0.0.1'], clean: ['8.8.8.8', '1.1.1.1'] });
  const guard = guardedLookup(lookup, (a) => (isLocalAddress(a) ? new Error(`локальный ${a}`) : undefined));
  const call = (host: string, all: boolean) =>
    new Promise<{ error: Error | null; result: unknown }>((resolve) => guard(host, { all }, (error, result) => resolve({ error, result })));
  assert.match((await call('mixed', true)).error?.message ?? '', /локальный 127\.0\.0\.1/);
  assert.match((await call('mixed', false)).error?.message ?? '', /локальный 127\.0\.0\.1/);
  assert.deepEqual((await call('clean', true)).result, [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }]);
  assert.equal((await call('clean', false)).result, '8.8.8.8');
  assert.equal((await call('нет-такого', true)).error?.message, 'нет');
});

async function fixture(permissions: Record<string, unknown>, lookup: Lookup, config?: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-net-')));
  const hits: string[] = [];
  const hung: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.headers.host ?? '');
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      if (request.url === '/hang') {
        response.on('close', () => hung.push(request.url ?? ''));
        return;
      }
      if (request.url === '/redirect') response.writeHead(302, { location: 'http://elsewhere.example/' }).end();
      else if (request.url === '/empty') response.writeHead(204).end();
      else if (request.url === '/weird') response.writeHead(999).end();
      else if (request.url === '/gzip') response.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('hello'));
      else if (request.url === '/bomb') response.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync(Buffer.alloc(17 * 1024 * 1024, 'a')));
      else if (request.url === '/echo') response.writeHead(200).end(JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString(), ua: request.headers['user-agent'], custom: request.headers['x-custom'] }));
      else response.writeHead(200, { 'content-type': 'text/plain', 'x-a': '1' }).end('hello');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let ctx: PluginContext | undefined;
  const fill = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('$PORT', String(port))) as T;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
    enabled: ['web'],
    manifests: [{ id: 'web', version: '1.0.0', engines: { cyborg: '^1' }, permissions: fill(permissions) }],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), lookup },
    ...(config && { config: { raw: () => [['user', fill(config)]] } as never }),
  });
  const net = (ctx!.os).net!;
  const denied = () => k.journal.filter((e) => e.kind === 'denied').map((e) => e.detail);
  const dispose = async () => {
    await k.unload();
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
  };
  return { net, k, port, server, hits, hung, denied, [Symbol.asyncDispose]: dispose };
}

test('net.fetch: хост из права, резолвящийся в локальный или частный адрес, получает отказ до соединения', async () => {
  const bad = [...LOCAL, ...LOCAL_V6].filter((a) => !a.includes('%'));
  const { lookup, calls } = answer(Object.fromEntries(bad.map((a, i) => [`h${String(i)}.example`, [a]])));
  await using f = await fixture({ net: bad.map((_, i) => `h${String(i)}.example:$PORT`) }, lookup);
  for (const [i, a] of bad.entries()) {
    await assert.rejects(f.net.fetch(`http://h${String(i)}.example:${String(f.port)}/`), { code: 'PermissionDenied' }, a);
  }
  assert.equal(f.hits.length, 0, 'запрос дошёл до сервера');
  assert.equal(calls.length, bad.length, 'имя резолвится один раз на запрос: проверка и соединение на одном ответе');
  assert.equal(f.denied().length, bad.length);
  assert.match(f.denied()[0] ?? '', /адрес 127\.0\.0\.1 локальный/);
});

test('net.fetch: один локальный адрес среди публичных в ответе - отказ', async () => {
  const { lookup } = answer({ 'mixed.example': ['8.8.8.8', '127.0.0.1'] });
  await using f = await fixture({ net: ['mixed.example:$PORT'] }, lookup);
  await assert.rejects(f.net.fetch(`http://mixed.example:${String(f.port)}/`), { code: 'PermissionDenied' });
  assert.equal(f.hits.length, 0);
});

test('net.fetch: право, названное локальным адресом или localhost, пускает; хост из config тоже (его назвал человек)', async () => {
  const { lookup, calls } = answer({ localhost: ['127.0.0.1'], 'svc.corp.local': ['127.0.0.1'] });
  await using f = await fixture({ net: ['127.0.0.1:$PORT', 'localhost:$PORT', 'config:baseUrl'] }, lookup, { baseUrl: 'http://svc.corp.local:$PORT' });
  for (const host of ['127.0.0.1', 'localhost', 'svc.corp.local']) {
    const response = await f.net.fetch(`http://${host}:${String(f.port)}/x`);
    assert.deepEqual([response.status, response.body, response.headers['x-a']], [200, 'hello', '1'], host);
  }
  assert.equal(f.hits.length, 3);
  assert.deepEqual([...new Set(f.hits)].sort(), [`127.0.0.1:${String(f.port)}`, `localhost:${String(f.port)}`, `svc.corp.local:${String(f.port)}`].sort());
  assert.ok(calls.includes('localhost'));
  assert.deepEqual(f.denied(), []);
});

test('net.fetch по node:http: метод, тело и заголовки доходят; переадресация не идёт; 204 без тела; тайм-аут и выгрузка обрывают запрос', async () => {
  const { lookup } = answer({});
  await using f = await fixture({ net: ['127.0.0.1:$PORT'] }, lookup);
  const at = (p: string) => `http://127.0.0.1:${String(f.port)}${p}`;
  const echoed = JSON.parse((await f.net.fetch(at('/echo'), { method: 'POST', body: 'тело', headers: { 'X-Custom': 'v' } })).body) as Record<string, string>;
  assert.deepEqual(echoed, { method: 'POST', body: 'тело', ua: 'node', custom: 'v' });
  const redirect = await f.net.fetch(at('/redirect'));
  assert.deepEqual([redirect.status, redirect.headers.location, redirect.body], [302, 'http://elsewhere.example/', '']);
  assert.deepEqual(await f.net.fetch(at('/empty')).then((r) => [r.status, r.body]), [204, '']);
  await assert.rejects(f.net.fetch(at('/hang'), { timeoutMs: 50 }), { code: 'Timeout' });
  const pending = f.net.fetch(at('/hang')).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await f.k.unload();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.hung.length, 2, 'сервер не увидел обрыва соединений: по тайм-ауту и по выгрузке плагина');
});

test('net.fetch: учётные данные в адресе (http://u:p@host/) - Invalid, как у прежнего fetch', async () => {
  const { lookup } = answer({});
  await using f = await fixture({ net: ['127.0.0.1:$PORT'] }, lookup);
  await assert.rejects(f.net.fetch(`http://u:p@127.0.0.1:${String(f.port)}/`), { code: 'Invalid' });
  assert.equal(f.hits.length, 0);
});

test('net.fetch: ответ со статусом вне 200-599 - Remote сразу, без зависания и исключения в процессе', async () => {
  const { lookup } = answer({});
  await using f = await fixture({ net: ['127.0.0.1:$PORT'] }, lookup);
  const started = Date.now();
  await assert.rejects(f.net.fetch(`http://127.0.0.1:${String(f.port)}/weird`), { code: 'Remote' });
  assert.ok(Date.now() - started < 5000, 'ждал тайм-аут вместо ошибки');
});

test('net.fetch: сжатый ответ приходит текстом, распакованное тело больше 16 МиБ обрывается Remote; accept-encoding плагина не мешает', async () => {
  const { lookup } = answer({});
  await using f = await fixture({ net: ['127.0.0.1:$PORT'] }, lookup);
  const at = (p: string) => `http://127.0.0.1:${String(f.port)}${p}`;
  assert.equal((await f.net.fetch(at('/gzip'), { headers: { 'Accept-Encoding': 'gzip' } })).body, 'hello');
  await assert.rejects(f.net.fetch(at('/bomb')), { code: 'Remote' });
});

test('net.fetch: выгрузка плагина закрывает его keep-alive соединения', async () => {
  const { lookup } = answer({});
  await using f = await fixture({ net: ['127.0.0.1:$PORT'] }, lookup);
  await f.net.fetch(`http://127.0.0.1:${String(f.port)}/`);
  const open = () => new Promise<number>((resolve) => f.server.getConnections((_e, n) => resolve(n)));
  assert.equal(await open(), 1, 'keep-alive: соединение осталось в пуле');
  await f.k.unload();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await open(), 0, 'соединение плагина пережило его выгрузку');
});
