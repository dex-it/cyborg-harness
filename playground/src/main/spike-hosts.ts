// Замер хостов плагинов (SAD, открытый вопрос 7): память на хост, цена RPC, пороги сторожа.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, type JournalEntry, type Kernel, type WatchdogOptions } from '@cyborg-harness/core';
import { PLUGIN_API_VERSION } from '@cyborg-harness/core';
import { utilityHosts, type UtilityHosts } from '@cyborg-harness/electron';
import { pssKb, rssKb } from './proc-memory.ts';

export interface HostsSpikeOptions {
  readonly out: string;
  readonly hostEntry: string;
  readonly benchDir: string;
  /** Откуда берутся хосты замера; по умолчанию utilityProcess из `hostEntry`. Спайк TR-20 подставляет процессы Node (spike-node-host.ts). */
  readonly spawn?: () => UtilityHosts;
}

export const manifest = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...extra });
const PROVIDER = manifest('bench-provider', {
  provides: { 'bench.rpc': '1.0' },
  commands: {
    'bench-provider.echo': { args: ['string'] },
    'bench-provider.block': { args: ['number'] },
    'bench-provider.parse': { args: ['number'] },
    'bench-provider.scan': { args: ['string'] },
  },
});
const CONSUMER = manifest('bench-consumer', {
  requires: { 'bench.rpc': '^1' },
  commands: { 'bench-consumer.calls': { args: ['number', 'number'] }, 'bench-consumer.stream': { args: ['number', 'number'] } },
});
const idleIds = (n: number) => Array.from({ length: n }, (_, i) => `idle-${i}`);

export interface Session {
  readonly kernel: Kernel;
  readonly hosts: UtilityHosts;
  readonly journal: { at: number; entry: JournalEntry }[];
}

export async function start(options: HostsSpikeOptions, manifests: Record<string, unknown>[], groups: Readonly<Record<string, readonly string[]>>, watchdog?: Partial<WatchdogOptions>): Promise<Session> {
  const hosts = options.spawn?.() ?? utilityHosts(options.hostEntry);
  const journal: Session['journal'] = [];
  const file = (id: string) => path.join(options.benchDir, `${id.startsWith('idle-') ? 'idle' : id.replace('bench-', '')}.ts`);
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: manifests.map((m) => String(m.id)),
    manifests,
    spawnHost: hosts.spawn,
    entry: (m) => pathToFileURL(file(m.id)).href,
    bundled: manifests.map((m) => String(m.id)),
    hosts: groups,
    ...(watchdog && { watchdog }),
    onJournal: (entry) => journal.push({ at: performance.now(), entry }),
  });
  await kernel.idle();
  const failed = journal.filter((j) => j.entry.kind !== 'activated');
  if (failed.length > 0) throw new Error(`загрузка не чистая: ${JSON.stringify(failed.map((j) => j.entry))}`);
  return { kernel, hosts, journal };
}

export const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MemoryRow {
  readonly layout: string;
  readonly hosts: number;
  readonly plugins: number;
  readonly pssMb: number | null;
  readonly rssMb: number | null;
  readonly pssPerHostMb: number | null;
}

export async function memory(options: HostsSpikeOptions): Promise<MemoryRow[]> {
  const rows: MemoryRow[] = [];
  const layouts: [string, number, (ids: string[]) => Record<string, string[]>][] = [
    ['хост на плагин', 1, (ids) => Object.fromEntries(ids.map((id) => [`h-${id}`, [id]]))],
    ['хост на плагин', 2, (ids) => Object.fromEntries(ids.map((id) => [`h-${id}`, [id]]))],
    ['хост на плагин', 5, (ids) => Object.fromEntries(ids.map((id) => [`h-${id}`, [id]]))],
    ['хост на плагин', 10, (ids) => Object.fromEntries(ids.map((id) => [`h-${id}`, [id]]))],
    ['один хост', 10, (ids) => ({ shared: ids })],
  ];
  for (const [layout, n, groups] of layouts) {
    const ids = idleIds(n);
    const session = await start(options, ids.map((id) => manifest(id)), groups(ids));
    await sleep(1500);
    const hostIds = [...new Set(ids.map((id) => session.kernel.hostOf(id)).filter((h): h is string => h !== undefined))];
    const pids = hostIds.map((h) => session.hosts.pidOf(h));
    const pss = pids.map((p) => (p === undefined ? undefined : pssKb(p)));
    const rss = pids.map((p) => (p === undefined ? undefined : rssKb(p)));
    const sum = (xs: (number | undefined)[]) => (xs.every((x) => x !== undefined) ? round(xs.reduce((a, b) => a + b, 0) / 1024, 1) : null);
    const pssMb = sum(pss);
    rows.push({ layout, hosts: hostIds.length, plugins: n, pssMb, rssMb: sum(rss), pssPerHostMb: pssMb === null ? null : round(pssMb / hostIds.length, 1) });
    await session.kernel.unload();
  }
  return rows;
}

export interface RpcRow {
  readonly path: string;
  readonly sizeBytes: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface StreamRow {
  readonly path: string;
  readonly chunks: number;
  readonly chunkBytes: number;
  readonly ms: number;
  readonly mbps: number;
}

async function mainToHost(kernel: Kernel, size: number): Promise<RpcRow> {
  const data = 'x'.repeat(size);
  for (let i = 0; i < 30; i++) await kernel.run('bench-provider.echo', data);
  const times: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t = performance.now();
    await kernel.run('bench-provider.echo', data);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => round(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? NaN, 3);
  return { path: 'главный -> хост (команда)', sizeBytes: size, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export async function rpc(options: HostsSpikeOptions): Promise<{ calls: RpcRow[]; streams: StreamRow[] }> {
  const calls: RpcRow[] = [];
  const streams: StreamRow[] = [];
  const pair = [PROVIDER, CONSUMER];
  for (const [label, groups] of [
    ['хост -> хост, разные хосты', { prov: ['bench-provider'], cons: ['bench-consumer'] }],
    ['хост -> хост, один хост', { both: ['bench-provider', 'bench-consumer'] }],
  ] as const) {
    const session = await start(options, pair, { ...groups });
    if (label.includes('разные')) for (const size of [64, 4096, 65536]) calls.push(await mainToHost(session.kernel, size));
    for (const size of [64, 4096, 65536]) {
      const r = (await session.kernel.run('bench-consumer.calls', 300, size)) as Percentiles;
      calls.push({ path: `${label} (контракт)`, sizeBytes: size, p50: r.p50, p95: r.p95, p99: r.p99 });
    }
    const chunks = 1024;
    const chunkBytes = 4096;
    await session.kernel.run('bench-consumer.stream', 64, chunkBytes);
    const ms = (await session.kernel.run('bench-consumer.stream', chunks, chunkBytes)) as number;
    streams.push({ path: `${label} (события)`, chunks, chunkBytes, ms: round(ms, 1), mbps: round((chunks * chunkBytes) / 1048576 / (ms / 1000), 1) });
    if (label.includes('разные')) {
      const data = 'x'.repeat(chunkBytes);
      const t = performance.now();
      await Promise.all(Array.from({ length: chunks }, () => session.kernel.run('bench-provider.echo', data)));
      const pipeMs = performance.now() - t;
      streams.push({ path: 'главный -> хост (команды конвейером)', chunks, chunkBytes, ms: round(pipeMs, 1), mbps: round((chunks * chunkBytes) / 1048576 / (pipeMs / 1000), 1) });
    }
    await session.kernel.unload();
  }
  return { calls, streams };
}

export interface BlockingRow {
  readonly work: string;
  readonly ms: number;
  readonly detail: string;
}

export interface PingRow {
  readonly blockMs: number;
  readonly pingDuringMs: number;
}

export async function blocking(options: HostsSpikeOptions): Promise<{ work: BlockingRow[]; ping: PingRow[] }> {
  // Сторож отодвинут: меряется сама работа, а не то, переживёт ли её хост.
  const session = await start(options, [PROVIDER], { prov: ['bench-provider'] }, { interval: 1000, timeout: 600_000 });
  const work: BlockingRow[] = [];
  for (const mb of [1, 10, 50]) {
    const r = (await session.kernel.run('bench-provider.parse', mb)) as { ms: number; mb: number };
    work.push({ work: `JSON.parse ${round(r.mb, 1)} МБ`, ms: round(r.ms, 1), detail: '' });
  }
  for (const dir of [path.resolve(__dirname, '..', '..', 'node_modules'), '/usr/share']) {
    if (!fs.existsSync(dir)) continue;
    try {
      const r = (await session.kernel.run('bench-provider.scan', dir)) as { ms: number; entries: number };
      work.push({ work: `readdirSync recursive ${dir.replace(os.homedir(), '~')}`, ms: round(r.ms, 1), detail: `${r.entries} записей` });
    } catch (error) {
      work.push({ work: `readdirSync recursive ${dir.replace(os.homedir(), '~')}`, ms: NaN, detail: (error as Error).message.slice(0, 80) });
    }
  }
  // Пинг ядра встаёт в очередь за синхронной работой: его задержка и есть то, что видит сторож.
  const ping: PingRow[] = [];
  for (const blockMs of [100, 1000, 3000]) {
    const blocked = session.kernel.run('bench-provider.block', blockMs);
    await sleep(20);
    const t = performance.now();
    await session.kernel.run('bench-provider.echo', 'p');
    ping.push({ blockMs, pingDuringMs: round(performance.now() - t, 1) });
    await blocked;
  }
  await session.kernel.unload();
  return { work, ping };
}

export interface WatchdogRow {
  readonly watchdog: string;
  readonly failure: 'hang' | 'crash';
  readonly detectMs: number;
  readonly restartMs: number;
}

export async function watchdogTimes(options: HostsSpikeOptions): Promise<WatchdogRow[]> {
  const rows: WatchdogRow[] = [];
  for (const [interval, timeout] of [
    [1000, 5000],
    [500, 2500],
  ] as const) {
    for (const failure of ['hang', 'crash'] as const) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const session = await start(options, [manifest('idle-0')], { solo: ['idle-0'] }, { interval, timeout, strikes: 10 });
        const pid = session.hosts.pidOf('solo');
        if (pid === undefined) throw new Error('нет pid хоста solo');
        await sleep(interval * 1.5);
        const t0 = performance.now();
        process.kill(pid, failure === 'hang' ? 'SIGSTOP' : 'SIGKILL');
        const deadline = t0 + timeout + interval * 3 + 10_000;
        let down: number | undefined;
        let up: number | undefined;
        while (performance.now() < deadline && up === undefined) {
          await sleep(10);
          down ??= session.journal.find((j) => j.at >= t0 && j.entry.kind === 'host-down')?.at;
          const since = down;
          if (since !== undefined) up = session.journal.find((j) => j.at >= since && j.entry.kind === 'activated')?.at;
        }
        rows.push({ watchdog: `${interval}/${timeout}`, failure, detectMs: down === undefined ? NaN : round(down - t0, 0), restartMs: down === undefined || up === undefined ? NaN : round(up - down, 0) });
        await session.kernel.unload();
      }
    }
  }
  return rows;
}

export interface HostsReport {
  readonly electron: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpus: string;
  memory?: MemoryRow[];
  calls?: RpcRow[];
  streams?: StreamRow[];
  work?: BlockingRow[];
  ping?: PingRow[];
  watchdog?: WatchdogRow[];
  error?: string;
}

export async function runHostsSpike(options: HostsSpikeOptions): Promise<void> {
  const report: HostsReport = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`,
  };
  try {
    report.memory = await memory(options);
    Object.assign(report, await rpc(options));
    Object.assign(report, await blocking(options));
    report.watchdog = await watchdogTimes(options);
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  }
  fs.writeFileSync(options.out, JSON.stringify(report, null, 2));
}
