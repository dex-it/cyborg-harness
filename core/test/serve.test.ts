import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, ServeRequest, ServeResponse } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { describePermissions } from '../src/permissions.ts';
import { HttpServes, MAX_REQUEST_BODY, MAX_SERVERS } from '../src/serve.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: options.method ?? 'POST', headers: options.headers ?? {}, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

/** dispose уходит в ядро без ожидания ответа: сервер закрывается чуть позже вызова. */
async function closed(url: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    const code = await send(url).then(
      () => undefined,
      (e: unknown) => (e as { code?: string }).code,
    );
    if (code === 'ECONNREFUSED') return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function kernel(permissions: Record<string, unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-serve-'));
  let ctx: PluginContext | undefined;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({
      activate: (c: PluginContext) => {
        ctx = c;
        return undefined;
      },
    })),
    enabled: ['srv'],
    manifests: [{ id: 'srv', version: '1.0.0', engines: { cyborg: '^1' }, permissions }],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
  });
  assert.ok(ctx);
  const dispose = async () => {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  };
  return { k, ctx, denied: () => k.journal.filter((e) => e.kind === 'denied').map((e) => `${e.pluginId}:${e.method}`), [Symbol.asyncDispose]: dispose };
}

test('ST-3002/6: serve: запрос доходит до обработчика в хосте, ответ - клиенту; длину тела считает сервер', async () => {
  await using s = await kernel({ serve: true });
  const seen: ServeRequest[] = [];
  const server = await s.ctx.os.serve!.http((request) => {
    seen.push(request);
    return { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Length': '1' }, body: '{"ок":1}' };
  });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const reply = await send(`${server.url}/mcp?x=1`, { headers: { Authorization: 'Bearer t', 'X-Many': 'a' }, body: 'привет' });
  assert.equal(reply.status, 201);
  assert.equal(reply.body, '{"ок":1}');
  assert.equal(reply.headers['content-type'], 'application/json');
  assert.equal(reply.headers['content-length'], String(Buffer.byteLength('{"ок":1}')));
  assert.equal(seen.length, 1);
  assert.deepEqual({ method: seen[0]!.method, path: seen[0]!.path, body: seen[0]!.body, auth: seen[0]!.headers.authorization, many: seen[0]!.headers['x-many'] }, { method: 'POST', path: '/mcp?x=1', body: 'привет', auth: 'Bearer t', many: 'a' });
  const local = await send(server.url.replace('127.0.0.1', 'localhost'), { method: 'GET' });
  assert.equal(local.status, 201, 'localhost с тем же портом - свой Host');
});

test('ST-3002/6, ST-3002/7: serve: чужой Host, Origin и тело больше предела до обработчика не доходят', async () => {
  await using s = await kernel({ serve: true });
  let calls = 0;
  const server = await s.ctx.os.serve!.http(() => {
    calls++;
    return { status: 200 };
  });
  const port = new URL(server.url).port;
  assert.equal((await send(server.url, { headers: { Host: `evil.example:${port}` } })).status, 421, 'подмена DNS');
  assert.equal((await send(server.url, { headers: { Host: '127.0.0.1:1' } })).status, 421);
  assert.equal((await send(server.url, { headers: { Origin: 'https://evil.example' } })).status, 403, 'страница в браузере');
  assert.equal((await send(server.url, { body: 'x'.repeat(MAX_REQUEST_BODY + 1) })).status, 413);
  assert.equal(calls, 0);
});

test('ST-3002/6: serve: падение обработчика и чужая форма ответа - 502; без права члена нет, dispose и выгрузка закрывают сервер', async () => {
  await using s = await kernel({ serve: true });
  const answers: (() => unknown)[] = [
    () => Promise.reject(new Error('упал')),
    () => ({ status: 99 }),
    () => ({ status: 200, body: 42 }),
    () => ({ status: 200, headers: { 'X-Bad': 'a\r\nSet-Cookie: x' }, body: 'ok' }),
  ];
  const server = await s.ctx.os.serve!.http(() => answers.shift()!() as ServeResponse);
  assert.equal((await send(server.url)).status, 502, 'исключение');
  assert.equal((await send(server.url)).status, 502, 'status вне 200-599');
  assert.equal((await send(server.url)).status, 502, 'тело не строка');
  const split = await send(server.url);
  assert.equal(split.status, 200);
  assert.equal(split.headers['x-bad'], undefined, 'перевод строки в заголовке не уходит клиенту');
  assert.equal(split.headers['set-cookie'], undefined);

  server.dispose();
  assert.ok(await closed(server.url));
  const others = await Promise.all(Array.from({ length: MAX_SERVERS }, () => s.ctx.os.serve!.http(() => ({ status: 204 }))));
  await assert.rejects(s.ctx.os.serve!.http(() => ({ status: 204 })), { code: 'Invalid' }, 'предел серверов на плагин');
  await s.k.unload();
  for (const o of others) assert.ok(await closed(o.url), 'выгрузка закрывает серверы плагина');

  await using bare = await kernel({});
  assert.equal(bare.ctx.os.serve, undefined);
  assert.deepEqual(describePermissions({ serve: true }), ['принимает запросы HTTP на 127.0.0.1 - от программ этого компьютера'], 'право словами для окна');
});

test('ST-3002/6: serve: обработчик не ответил за срок - 504', async () => {
  const serves = new HttpServes(() => new Promise(() => undefined), 50);
  const url = await serves.open('p', 'h1');
  assert.equal((await send(url)).status, 504);
  serves.forget('p');
  assert.ok(await closed(url));
});

test('ST-3002/7: serve: срок ответа обработчика по умолчанию - 30 с на подставных часах, затем 504', async (t) => {
  let asked = 0;
  const serves = new HttpServes(() => {
    asked++;
    return new Promise(() => undefined);
  });
  const url = await serves.open('p', 'h1');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let status: number | undefined;
  const pending = send(url).then((r) => (status = r.status));
  // Под подставными часами timers/promises стоит: ждём оборотами цикла событий, ввод-вывод идёт между ними.
  const spin = async (until: () => boolean) => {
    for (let i = 0; i < 2000 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
  };
  await spin(() => asked === 1);
  assert.equal(asked, 1);
  t.mock.timers.tick(29_999);
  await spin(() => status !== undefined);
  assert.equal(status, undefined, 'срок по умолчанию короче 30 с');
  t.mock.timers.tick(1);
  await spin(() => status !== undefined);
  assert.equal(status, 504, 'срок по умолчанию длиннее 30 с');
  await pending;
  t.mock.timers.reset();
  serves.forget('p');
  assert.ok(await closed(url));
});
