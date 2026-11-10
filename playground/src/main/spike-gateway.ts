// Замер шлюза `ctx.os` (T-07, SAD открытый вопрос 9): каждое действие трижды - из плагина, `OsGateway.call` в главном процессе и голое.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { LookupFunction } from 'node:net';
import { pathToFileURL } from 'node:url';
import { safeStorage } from 'electron';
import { load, OsGateway, parseManifest, PLUGIN_API_VERSION, type JournalEntry, type OsEnvironment, type PluginManifest, type TraceRecord } from '@cyborg-harness/core';
import { closePools, guardedLookup, isLocalAddress, transport, type Lookup } from '../../../core/src/net-transport.ts';
import { measure, PTY_SCRIPT, SAMPLES, WARMUP, type ProbeOs, type ProbePath, type Sampled } from '../../bench/gateway-probe.ts';
import { electronOs, utilityHosts } from '@cyborg-harness/electron';

export interface GatewaySpikeOptions {
  readonly out: string;
  readonly hostEntry: string;
  readonly benchDir: string;
  /** Трасса операций (K-28, NFR-CH-4001) включена: ядро получает приёмник записей, как в приложении. По умолчанию да; `--trace=off` скрипта замера выключает. */
  readonly trace?: boolean;
}

export type Variant = 'плагин' | 'шлюз' | 'голое';

export interface GatewayRow {
  readonly path: ProbePath;
  readonly variant: Variant;
  readonly sizeBytes: number;
  readonly first: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface GatewayReport {
  readonly electron: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpus: string;
  readonly warmup: number;
  readonly samples: number;
  /** Чем шифрует safeStorage: на Linux без связки ключей - `basic_text`, и `secrets.get` дешевле, чем со связкой. */
  readonly secretsBackend: string;
  /** Была ли включена трасса в ядре замера и сколько записей она дала. */
  readonly trace: 'on' | 'off';
  traceRecords?: number;
  rows?: GatewayRow[];
  error?: string;
}

const SIZES = [64, 4096, 65536];
/** Крупный файл - только для `fs.readText`: остальные пути крупнее 64 КиБ на горячем пути не носят. */
const LARGE = 1024 * 1024;
const VARIANTS: readonly Variant[] = ['голое', 'шлюз', 'плагин'];
const ID = 'bench-gateway';

const round = (n: number) => Math.round(n * 1000) / 1000;
function row(probe: ProbePath, variant: Variant, sizeBytes: number, s: Sampled): GatewayRow {
  const times = s.times.toSorted((a, b) => a - b);
  const at = (q: number) => round(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? NaN);
  return { path: probe, variant, sizeBytes, first: round(s.first), p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/**
 * Замер мерит цену вызова, а не бюджет ввода: цикл `pty.write` шлёт сотни записей по 64 КиБ подряд и упирается в запас ввода одного pty (#134: 4 МиБ, затем 256 КиБ/с),
 * ядро отвечает `Invalid`, и замер шлюза не выходит ни одной цены. Предел ввода на время замера снят; в бюджет по разметке пути он не входит.
 */
const BENCH_LIMITS = { ptyInputBurst: 2 ** 30, ptyInputRate: 2 ** 30 };

function bareOs(env: OsEnvironment): ProbeOs {
  const { pty, secrets } = env;
  if (!pty || !secrets) throw new Error('в среде нет pty или секретов');
  return {
    readText: async (file) => {
      const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    },
    watch: (dir, listener) => {
      const watcher = fs.watch(dir, () => listener());
      return Promise.resolve(async () => watcher.close());
    },
    pty: async () => {
      const proc = await pty.spawn('/bin/sh', ['-c', PTY_SCRIPT], { name: 'xterm-256color', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() }, cols: 80, rows: 24 });
      return { write: async (data) => proc.write(data), onData: (listener) => void proc.onData(listener), kill: async () => proc.kill('SIGKILL') };
    },
    setSecret: (key, value) => secrets.set(`${ID}/${key}`, value),
    secret: (key) => secrets.get(`${ID}/${key}`),
    fetch: async (url) => {
      const response = await fetch(url, { redirect: 'manual' });
      return Buffer.from(await response.arrayBuffer()).toString('utf8');
    },
  };
}

/** Тот же шлюз, что у ядра, без хоста: разница с плагином - цена канала хоста, с голым действием - цена проверок. */
function gatewayOs(env: OsEnvironment, m: PluginManifest, denied: string[]): ProbeOs {
  const listeners = new Map<string, (params: { data?: string }) => void>();
  const gateway = new OsGateway(
    env,
    (d) => denied.push(`${d.method}: ${d.detail}`),
    () => ({ trusted: {}, untrusted: {} }),
    (_pluginId, method, params) => {
      const p = params as { id: string; data?: string };
      if (method === 'pty.data' || method === 'fs.change') listeners.get(p.id)?.(p);
    },
    () => m,
  );
  let watches = 0;
  return {
    readText: async (file) => (await gateway.call(m, 'fs.readText', [file])) as string,
    watch: async (dir, listener) => {
      const id = `w${String(++watches)}`;
      listeners.set(id, () => listener());
      await gateway.call(m, 'fs.watch', [dir, id]);
      return () => gateway.call(m, 'fs.unwatch', [id]);
    },
    pty: async () => {
      const wire = (await gateway.call(m, 'pty.spawn', [{ program: '/bin/sh', args: ['-c', PTY_SCRIPT] }])) as { id: string };
      return {
        write: (data) => gateway.call(m, 'pty.write', [wire.id, data]),
        onData: (listener) => void listeners.set(wire.id, (p) => p.data !== undefined && listener(p.data)),
        kill: () => gateway.call(m, 'pty.kill', [wire.id, 'SIGKILL']),
      };
    },
    setSecret: async (key, value) => {
      await gateway.call(m, 'secrets.set', [key, value]);
    },
    secret: async (key) => (await gateway.call(m, 'secrets.get', [key])) as string | undefined,
    fetch: async (url) => ((await gateway.call(m, 'net.fetch', [url])) as { body: string }).body,
  };
}

/**
 * Ветка `net.fetch` с проверкой адреса (K-25, замечание ревью): хост назван именем, резолв идёт через `guardedLookup` и `isLocalAddress`,
 * соединение берётся из пула `checked`. Адрес сервера замера - 127.0.0.1, поэтому вердикт проверки отбрасывается (иначе отказ). Резолв и проверка
 * идут один раз на соединение keep-alive: в цену вызова они не входят, мерится установившийся режим. Идёт через `transport`, без шлюза и канала хоста:
 * в `голое` - тот же транспорт без проверки.
 */
function checkedOs(port: number, checked: boolean): ProbeOs {
  const unsupported = () => Promise.reject(new Error('этот вариант меряет только net.fetch'));
  const toLoopback = ((_host: string, options: { all?: boolean }, callback: (error: null, result: unknown, family?: number) => void) => {
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
    else callback(null, '127.0.0.1', 4);
  }) as unknown as Lookup;
  const lookup = checked ? guardedLookup(toLoopback, (address) => void isLocalAddress(address)) : (toLoopback as unknown as LookupFunction);
  return {
    readText: unsupported,
    watch: unsupported,
    pty: unsupported,
    setSecret: unsupported,
    secret: unsupported,
    fetch: async (url) => {
      const target = new URL(url);
      target.host = `bench-checked.example:${String(port)}`;
      const response = await transport(target, { method: 'GET', headers: {}, signal: AbortSignal.timeout(10_000), lookup, local: !checked, owner: ID });
      return response.text();
    },
  };
}

function serve(): Promise<http.Server> {
  const bodies = new Map(SIZES.map((size) => [`/${String(size)}`, 'n'.repeat(size)]));
  const server = http.createServer((request, response) => {
    const body = bodies.get(request.url ?? '');
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/plain' }).end(body ?? '');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

export async function runGatewaySpike(options: GatewaySpikeOptions): Promise<void> {
  const report: GatewayReport = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} ${os.release()}`,
    arch: process.arch,
    cpus: `${String(os.cpus().length)} x ${os.cpus()[0]?.model ?? '?'}`,
    warmup: WARMUP,
    samples: SAMPLES,
    trace: options.trace === false ? 'off' : 'on',
    secretsBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'darwin' ? 'keychain' : 'dpapi',
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-spike-gateway-'));
  const server = await serve();
  const journal: JournalEntry[] = [];
  // Приёмник как у приложения: запись кладётся в кольцо (K-30 заменит его своим), содержимого в ней нет.
  const ring: (TraceRecord | undefined)[] = new Array<TraceRecord | undefined>(4096);
  let traced = 0;
  try {
    const files = path.join(base, 'files');
    const prepare = (dir: string) => {
      fs.mkdirSync(path.join(files, dir), { recursive: true });
      return path.join(files, dir);
    };
    for (const size of [...SIZES, LARGE]) fs.writeFileSync(path.join(prepare('warm'), String(size)), 'f'.repeat(size));
    const port = (server.address() as { port: number }).port;
    const host = `127.0.0.1:${String(port)}`;
    const raw = {
      id: ID,
      version: '1.0.0',
      engines: { cyborg: '^1' },
      commands: { 'bench-gateway.measure': { args: ['string', 'string', 'number'] } },
      permissions: { 'fs.read': [files], pty: [{ program: '/bin/sh', args: ['-c', PTY_SCRIPT] }], net: [host] },
    };
    const parsed = parseManifest(raw, PLUGIN_API_VERSION);
    if (!parsed.ok) throw new Error(`манифест замера: ${parsed.errors.join('; ')}`);
    const env: OsEnvironment = { ...electronOs({ userData: path.join(base, 'app'), roots: () => [], protectedPaths: [], raiseWindow: () => undefined }), limits: BENCH_LIMITS };
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: [ID],
      manifests: [raw],
      spawnHost: utilityHosts(options.hostEntry).spawn,
      entry: () => pathToFileURL(path.join(options.benchDir, 'gateway.ts')).href,
      bundled: [ID],
      hosts: { bench: [ID] },
      os: env,
      limits: BENCH_LIMITS,
      onJournal: (entry) => journal.push(entry),
      ...(options.trace !== false && { onTrace: (record: TraceRecord) => void (ring[traced++ % ring.length] = record) }),
    });
    await kernel.idle();
    if (!journal.some((e) => e.kind === 'activated') || journal.some((e) => e.kind !== 'activated')) throw new Error(`загрузка не чистая: ${JSON.stringify(journal)}`);
    const denied: string[] = [];
    const inMain: Record<Exclude<Variant, 'плагин'>, ProbeOs> = { голое: bareOs(env), шлюз: gatewayOs(env, parsed.manifest, denied) };
    const run = (variant: Variant, probe: ProbePath, target: string, size: number): Promise<Sampled> =>
      variant === 'плагин' ? (kernel.run('bench-gateway.measure', probe, target, size) as Promise<Sampled>) : measure(inMain[variant], probe, target, size);

    const rows: GatewayRow[] = [];
    const each = async (probe: ProbePath, sizes: readonly number[], target: (variant: Variant, size: number) => string) => {
      for (const size of sizes) for (const variant of VARIANTS) rows.push(row(probe, variant, size, await run(variant, probe, target(variant, size), size)));
    };
    await each('fs.readText', [...SIZES, LARGE], (_v, size) => path.join(files, 'warm', String(size)));
    await each('fs.readText.cold', SIZES, (variant, size) => {
      const dir = prepare(`cold-${variant}-${String(size)}`);
      for (let i = 0; i < WARMUP + SAMPLES; i++) fs.writeFileSync(path.join(dir, String(i)), 'c'.repeat(size));
      return dir;
    });
    // Размер дописанного не меняет событие: оно несёт имена, а не данные.
    await each('fs.watch', [64], (variant) => prepare(`watch-${variant}`));
    await each('pty.write', SIZES, () => '');
    await each('secrets.get', SIZES, (_v, size) => `key-${String(size)}`);
    await each('net.fetch', SIZES, (_v, size) => `http://${host}/${String(size)}`);
    // Ветка с проверкой адреса в плагине не мерится: имя хоста с адресом 127.0.0.1 шлюз отверг бы. Бюджет сверяется по `шлюз`.
    for (const size of SIZES) {
      for (const variant of ['голое', 'шлюз'] as const) rows.push(row('net.fetch.checked', variant, size, await measure(checkedOs(port, variant === 'шлюз'), 'net.fetch.checked', `http://${host}/${String(size)}`, size)));
    }
    closePools(ID);
    report.rows = rows;
    await kernel.unload();
    report.traceRecords = traced;
    if (options.trace !== false && traced === 0) throw new Error('трасса включена, а записей нет');
    if (denied.length > 0) throw new Error(`шлюз отказал: ${denied.join('; ')}`);
  } catch (error) {
    report.error = `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\nжурнал: ${JSON.stringify(journal)}`;
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  fs.writeFileSync(options.out, JSON.stringify(report, null, 2));
}
