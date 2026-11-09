import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { closePools, guardedLookup, isLocalAddress, transport, type Lookup, type TransportRequest } from '../src/net-transport.ts';

// Пробы ревью K-25 (#99): транспорт net.fetch на node:http(s) с общими пулами соединений.

interface Seen {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly port: number | undefined;
  body: string;
}

async function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const entry: Seen = { url: request.url ?? '', headers: request.headers, port: request.socket.remotePort, body: '' };
    seen.push(entry);
    request.on('data', (c: Buffer) => (entry.body += c.toString()));
    request.on('end', () => handler(request, response, entry));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { seen, port, close, [Symbol.dispose]: close };
}

const base = (owner: string, over: Partial<TransportRequest> = {}): TransportRequest => ({
  method: 'GET',
  headers: {},
  signal: AbortSignal.timeout(3000),
  lookup: dns.lookup,
  local: true,
  owner,
  ...over,
});

test('transport: плагин не задаёт разметку сообщения - content-length не по телу не оставляет хвост в общем сокете', async () => {
  using s = await listen((_request, response, entry) => void response.end(`resp-for ${entry.url}`));
  const at = (p: string) => new URL(`http://127.0.0.1:${String(s.port)}${p}`);
  const smuggled = 'POST /attacker-sink HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\nstolen=';
  const a = await transport(at('/a-legit'), base('a', { method: 'POST', headers: { 'Content-Length': '0' }, body: smuggled }));
  assert.equal(await a.text(), 'resp-for /a-legit');
  // Второй плагин тем же сокетом: его Authorization не должен стать телом чужого запроса.
  const b = await transport(at('/b-private'), base('b', { headers: { authorization: 'Bearer B-SECRET' }, signal: AbortSignal.timeout(1000) }));
  assert.equal(await b.text(), 'resp-for /b-private');
  assert.equal(
    s.seen.find((e) => e.url === '/attacker-sink'),
    undefined,
    'вложенный запрос A дошёл до сервера как отдельный',
  );
  assert.deepEqual(
    s.seen.filter((e) => e.headers.authorization !== undefined || e.body.includes('B-SECRET')).map((e) => e.url),
    ['/b-private'],
    'секрет B ушёл не только в его собственный запрос',
  );
});

test('transport: content-length, transfer-encoding, host, connection и подобные от плагина отбрасываются; ставит их node:http', async () => {
  using s = await listen((_request, response) => void response.end('ok'));
  const url = new URL(`http://127.0.0.1:${String(s.port)}/x`);
  const headers = { 'Content-Length': '0', 'Transfer-Encoding': 'chunked', Host: 'evil.example', Connection: 'close', 'Keep-Alive': 'timeout=1', Upgrade: 'websocket', Expect: '100-continue', TE: 'trailers', Trailer: 'x', 'Proxy-Connection': 'close', 'X-Own': 'kept' };
  await (await transport(url, base('a', { method: 'POST', headers, body: 'abc' }))).text();
  const [first] = s.seen;
  assert.ok(first);
  const got = first.headers;
  assert.equal(got['content-length'], '3');
  assert.equal(got['transfer-encoding'], undefined);
  assert.equal(got.host, `127.0.0.1:${String(s.port)}`);
  assert.equal(got.connection, 'keep-alive');
  for (const h of ['keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection']) assert.equal(got[h], undefined, h);
  assert.equal(got['x-own'], 'kept');
  assert.equal(first.body, 'abc');
});

test('transport: пул у каждого плагина свой, а у одного плагина соединение переиспользуется', async () => {
  using s = await listen((_request, response) => void response.end('ok'));
  const url = new URL(`http://127.0.0.1:${String(s.port)}/x`);
  for (const owner of ['a', 'a', 'b', 'a', 'b']) await (await transport(url, base(owner))).text();
  const [a1, a2, b1, a3, b2] = s.seen.map((e) => e.port);
  assert.equal(a1, a2, 'keep-alive: второй запрос A на том же сокете');
  assert.equal(a1, a3);
  assert.equal(b1, b2);
  assert.notEqual(a1, b1, 'сокет A обслужил запрос B');
  closePools('a');
  closePools('b');
});

test('transport: пул без проверки адреса не обслуживает запрос с проверкой к тому же host:port', async () => {
  using s = await listen((_request, response) => void response.end('ok'));
  const url = new URL(`http://named.example:${String(s.port)}/x`);
  const toLoopback = ((_h: string, options: { all?: boolean }, cb: (e: null, r: unknown, f?: number) => void) => {
    if (options.all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
    else cb(null, '127.0.0.1', 4);
  }) as unknown as Lookup;
  // Первый запрос - хост назван в праве: соединение открыто без проверки и остаётся в пуле.
  await (await transport(url, base('a', { lookup: toLoopback, local: true }))).text();
  assert.equal(s.seen.length, 1);
  // Второй - с проверкой, имя резолвится в 127.0.0.1: даже у того же плагина отказ, а не чужой сокет.
  const refused = new Error('адрес локальный');
  const checked = guardedLookup(toLoopback, (address) => (isLocalAddress(address) ? refused : undefined));
  await assert.rejects(transport(url, base('a', { lookup: checked, local: false })), (e: unknown) => e === refused);
  assert.equal(s.seen.length, 1, 'запрос с проверкой дошёл до сервера по сокету без проверки');
  closePools('a');
});

test('transport: ответ со статусом вне 200-599 - отказ с ошибкой, а не исключение мимо промиса', async () => {
  const raw = net.createServer((socket) => {
    socket.once('data', () => socket.end('HTTP/1.1 999 Weird\r\ncontent-length: 0\r\n\r\n'));
  });
  await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
  try {
    const url = new URL(`http://127.0.0.1:${String((raw.address() as AddressInfo).port)}/`);
    await assert.rejects(transport(url, base('a', { signal: AbortSignal.timeout(2000) })), (e: unknown) => e instanceof Error && e.message.includes('status'));
  } finally {
    raw.close();
    closePools('a');
  }
});

test('transport: сжатый ответ сервера распаковывается, как у прежнего fetch', async () => {
  using s = await listen((_request, response) => void response.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('hello')));
  const url = new URL(`http://127.0.0.1:${String(s.port)}/`);
  const response = await transport(url, base('a', { headers: { 'Accept-Encoding': 'gzip' } }));
  assert.equal(await response.text(), 'hello');
  closePools('a');
});

test('transport: accept-encoding плагина не перебивает identity', async () => {
  using s = await listen((_request, response) => void response.end('ok'));
  const url = new URL(`http://127.0.0.1:${String(s.port)}/`);
  await (await transport(url, base('a', { headers: { 'Accept-Encoding': 'gzip, br' } }))).text();
  assert.equal(s.seen[0]?.headers['accept-encoding'], 'identity');
  closePools('a');
});

test('isLocalAddress: стенды 192.0.0.0/24 и 198.18.0.0/15, локальный NAT64 64:ff9b:1::/48 отвергаются; соседние публичные - нет', () => {
  for (const a of ['192.0.0.1', '192.0.0.255', '198.18.0.1', '198.19.255.255', '64:ff9b:1::1', '64:ff9b:1:ffff::1']) assert.equal(isLocalAddress(a), true, a);
  for (const a of ['192.0.1.1', '198.17.255.255', '198.20.0.1', '64:ff9b:2::1', '64:ff9a::1']) assert.equal(isLocalAddress(a), false, a);
});

test('transport: content-encoding при пустом теле (HEAD, пустой объект) - пустой ответ, как у прежнего fetch, а не ошибка распаковки', async () => {
  using s = await listen((request, response) => {
    response.writeHead(200, { 'content-encoding': request.url?.slice(1) ?? '', 'content-length': request.method === 'HEAD' ? '25' : '0' });
    response.end();
  });
  for (const encoding of ['gzip', 'deflate', 'br']) {
    const url = new URL(`http://127.0.0.1:${String(s.port)}/${encoding}`);
    for (const method of ['HEAD', 'GET']) {
      const response = await transport(url, base('a', { method }));
      assert.deepEqual([response.status, await response.text()], [200, ''], `${method} ${encoding}`);
      assert.equal(response.headers.get('content-length'), null, 'длина сжатого тела не описывает распакованное');
    }
  }
  closePools('a');
});
