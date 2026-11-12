import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { forkHosts, load, PLUGIN_API_VERSION, SectionStore, type JournalEntry, type Kernel, type OsEnvironment, type TraceRecord } from '@cyborg-harness/core';
import { memorySecrets, memoryStore, sandbox, type MemorySecrets, type Sandbox } from '@cyborg-harness/testing';

// Общая фикстура пилота PL-10 (трекер через HTTP API): подставной GitLab на 127.0.0.1, настоящее ядро с плагином `trackers-http` и пробами в хостах-процессах,
// слои config в памяти (`user`, `workspace`) и сбор всего, что ядро пишет наружу: журнал, строки плагинов, трасса. Сервер ведёт свой журнал независимо от плагина.

const PLUGINS = path.join(import.meta.dirname, '..', 'plugins');
export { sandbox };

export interface Seen {
  /** Заголовок `Host` запроса: хаб, на который он пришёл. */
  readonly host: string;
  readonly url: string;
  /** Значение `PRIVATE-TOKEN`, как дошло до сервера. */
  readonly token: string | undefined;
}

export interface FakeGitlab {
  readonly port: number;
  readonly seen: Seen[];
  /** Токен, который принимает хаб (по `Host`); хаба нет в таблице - 401. */
  readonly accept: Map<string, string>;
  /** Сколько записей отдать на `проект/вид`; по умолчанию 3 задачи и 2 MR. */
  readonly total: Map<string, number>;
  /** 401 несёт в теле эхо присланного токена (так отвечают некоторые прокси). */
  echo: boolean;
  close(): Promise<void>;
}

export async function fakeGitlab(): Promise<FakeGitlab> {
  const seen: Seen[] = [];
  const accept = new Map<string, string>();
  const total = new Map<string, number>();
  const state = { echo: false };
  const server = http.createServer((request, response) => {
    const host = request.headers.host ?? '';
    const token = typeof request.headers['private-token'] === 'string' ? request.headers['private-token'] : undefined;
    const url = request.url ?? '';
    seen.push({ host, url, token });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    const route = /^\/api\/v4\/projects\/([^/?]+)\/(issues|merge_requests)\?(.*)$/.exec(url);
    if (!route) return void json(404, { message: '404 Not Found' });
    if (token === undefined || accept.get(host) !== token) return void json(401, { message: state.echo ? `401 Unauthorized: token ${token ?? ''}` : '401 Unauthorized' });
    const project = decodeURIComponent(route[1] ?? '');
    const kind = route[2] ?? '';
    if (project === 'moved/away') return void response.writeHead(302, { location: 'http://elsewhere.example/steal' }).end();
    if (project === 'broken/one') return void json(500, { message: 'server error' });
    const query = new URLSearchParams(route[3]);
    const page = Number(query.get('page') ?? '1');
    const perPage = Number(query.get('per_page') ?? '20');
    const count = total.get(`${project}/${kind}`) ?? (kind === 'issues' ? 3 : 2);
    const from = (page - 1) * perPage;
    const items = Array.from({ length: Math.max(0, Math.min(perPage, count - from)) }, (_, i) => {
      const iid = from + i + 1;
      return { iid, title: `${kind === 'issues' ? 'Задача' : 'MR'} ${String(iid)}`, web_url: `http://${host}/${project}/-/${kind}/${String(iid)}`, state: 'opened' };
    });
    json(200, items, from + perPage < count ? { 'x-next-page': String(page + 1) } : { 'x-next-page': '' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    accept,
    total,
    get echo() {
      return state.echo;
    },
    set echo(value: boolean) {
      state.echo = value;
    },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Проба: плагин с заданными правами, который ходит в сеть и зовёт команды trackers-http от своего имени. */
/** Запись журнала об отказе шлюза. */
export type Denied = Extract<JournalEntry, { kind: 'denied' }>;

export interface Probe {
  readonly id: string;
  readonly permissions?: Record<string, unknown>;
  readonly config?: boolean;
}

const PROBE_CODE = `
export default {
  activate(ctx) {
    ctx.commands.register(ctx.pluginId + '.get', async (url) => (await ctx.os.net.fetch(url)).status);
    ctx.commands.register(ctx.pluginId + '.run', (command, ...args) => ctx.commands.run(command, ...args));
    return undefined;
  },
};
`;

export interface Layers {
  readonly user?: readonly unknown[];
  readonly workspace?: readonly unknown[];
}

export interface Rig {
  readonly k: Kernel;
  readonly fake: FakeGitlab;
  readonly secrets: MemorySecrets;
  /** Документы слоёв config, как они лежат в хранилище слоёв. */
  readonly docs: Map<string, Record<string, unknown>>;
  /** Всё, что ядро отдало наружу: журнал (как JSON), строки плагинов, записи трассы. */
  readonly journal: JournalEntry[];
  readonly logs: string[];
  readonly traces: TraceRecord[];
  /** Хаб на подставной сервер: имя хоста + порт сервера. */
  hub(name: string): string;
  /** Команда как от человека (палитра, вид). */
  run(command: string, ...args: unknown[]): Promise<unknown>;
  /** Все выходы ядра одной строкой: по ней ищется, не просочился ли токен. */
  everything(): string;
  denied(): Denied[];
  [Symbol.asyncDispose](): Promise<void>;
}

export interface RigOptions {
  readonly box: Sandbox;
  /** Значения поля `hubs` по слоям; `$PORT` заменяется портом подставного сервера. */
  readonly layers?: Layers;
  /** Имена хостов, которые резолвятся в 127.0.0.1 (корпоративные имена с частным адресом в проде); прочие - как есть. */
  readonly resolve?: readonly string[];
  readonly probes?: readonly Probe[];
}

export async function rig(options: RigOptions): Promise<Rig> {
  const { box } = options;
  const fake = await fakeGitlab();
  const fill = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll('$PORT', String(fake.port))) as T;
  const secrets = memorySecrets();
  const layers = fill(options.layers ?? {});
  const initial: Record<string, Record<string, unknown>> = {};
  for (const layer of ['user', 'workspace'] as const) if (layers[layer] !== undefined) initial[layer] = { 'trackers-http': { $version: 1, hubs: layers[layer] } };
  const store = memoryStore(initial);
  const config = await SectionStore.open(store.store, ['user', 'workspace']);

  const manifests: unknown[] = [JSON.parse(await readFile(path.join(PLUGINS, 'trackers-http', 'manifest.json'), 'utf8'))];
  const entries = new Map<string, string>([['trackers-http', pathToFileURL(path.join(PLUGINS, 'trackers-http', 'index.ts')).href]]);
  for (const probe of options.probes ?? []) {
    const dir = box.path('probes', probe.id);
    await mkdir(dir, { recursive: true });
    const commands = Object.fromEntries([['get', { args: ['string'] }], ['run', { args: ['string'], rest: 'any' }]].map(([n, s]) => [`${probe.id}.${n as string}`, s]));
    manifests.push({ id: probe.id, version: '1.0.0', engines: { cyborg: '^1' }, commands, ...(probe.config === true && { config: { version: 1 } }), ...(probe.permissions && { permissions: fill(probe.permissions) }) });
    await writeFile(path.join(dir, 'index.ts'), PROBE_CODE);
    entries.set(probe.id, pathToFileURL(path.join(dir, 'index.ts')).href);
  }

  const journal: JournalEntry[] = [];
  const logs: string[] = [];
  const traces: TraceRecord[] = [];
  const resolve = new Set(options.resolve ?? []);
  const lookup = ((hostname: string, lookupOptions: { all?: boolean }, callback: (error: Error | null, result?: unknown, family?: number) => void) => {
    // Корпоративные имена ведут на подставной сервер; публичные адреса в тесте недоступны, остальное - как есть, отказом.
    const address = resolve.has(hostname) || hostname === 'localhost' ? '127.0.0.1' : undefined;
    if (address === undefined) callback(Object.assign(new Error(`${hostname}: нет`), { code: 'ENOTFOUND' }));
    else if (lookupOptions.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  }) as unknown as NonNullable<OsEnvironment['lookup']>;

  const ids = manifests.map((m) => (m as { id: string }).id);
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests,
    hosts: Object.fromEntries(ids.map((id) => [id, [id]])),
    spawnHost: forkHosts({ silent: true }),
    entry: (m) => entries.get(m.id) ?? m.id,
    os: { dataDir: box.path('data'), tempDir: box.path('temp'), home: box.root, env: { PATH: '/usr/bin:/bin' }, secrets, lookup },
    config,
    onJournal: (e) => void journal.push(e),
    onLog: (pluginId, message) => void logs.push(`${pluginId}: ${message}`),
    onTrace: (record) => void traces.push(record),
    watchdog: { interval: 500, timeout: 20_000, strikes: 3 },
  });
  return {
    k,
    fake,
    secrets,
    docs: store.docs,
    journal,
    logs,
    traces,
    hub: (name) => `http://${name}:${String(fake.port)}`,
    run: (command, ...args) => k.run(command, ...args),
    everything: () => [JSON.stringify(k.journal), JSON.stringify(journal), logs.join('\n'), JSON.stringify(traces), JSON.stringify([...store.docs])].join('\n'),
    denied: () => k.journal.filter((e): e is Denied => e.kind === 'denied'),
    [Symbol.asyncDispose]: async () => {
      await k.unload();
      await fake.close();
    },
  };
}
