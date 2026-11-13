// Спайк TR-20 (docs/research/trust-and-isolation/06-work-plan.md): хост плагинов как процесс Node под `--permission` с пустым env против utilityProcess.
// Ядро одно и то же (главный процесс Electron, как в приложении), меняется только способ запуска хоста; замеры - те же, что у spike-hosts (память, вызов, поток, пинг, сторож),
// плюс старт хоста, цена вызова `ctx.os` из плагина и сверка структурного клонирования. Итог - JSON в `--spike-node-host=<файл>`, печатает его playground/scripts/spike-node-host.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { forkHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';
import { utilityHosts, type UtilityHosts } from '@cyborg-harness/electron';
import { manifest, memory, rpc, round, sleep, start, watchdogTimes, blocking, type BlockingRow, type HostsSpikeOptions, type MemoryRow, type PingRow, type RpcRow, type StreamRow, type WatchdogRow } from './spike-hosts.ts';

export type HostMode = 'utilityProcess' | 'node-advanced' | 'node-json' | 'electron-as-node';

export interface NodeHostSpikeOptions {
  readonly out: string;
  /** Вход хоста для utilityProcess (`plugin-host.mjs`). */
  readonly utilityEntry: string;
  /** Вход хоста для child_process.fork (`node-host.mjs`, бандл `@cyborg-harness/core/host-entry`). */
  readonly nodeEntry: string;
  readonly benchDir: string;
  /** Отдельный бинарник Node (`--node-bin=`); без него режим `node` не меряется. */
  readonly nodeBin?: string;
}

export interface StartRow {
  readonly mode: HostMode;
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface OsRow {
  readonly mode: HostMode;
  readonly sizeBytes: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface CloneRow {
  readonly mode: HostMode;
  readonly value: string;
  readonly outcome: string;
}

export interface ModeReport {
  readonly mode: HostMode;
  readonly description: string;
  /** Режим не меряется целиком: проверен только запуск (процесс Node с другой версией V8 не читает advanced-сериализацию ядра). */
  probeOnly?: string;
  starts?: StartRow;
  memory?: MemoryRow[];
  calls?: RpcRow[];
  streams?: StreamRow[];
  os?: OsRow[];
  work?: BlockingRow[];
  ping?: PingRow[];
  watchdog?: WatchdogRow[];
  clone?: CloneRow[];
  error?: string;
}

export interface NodeHostReport {
  readonly electron: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpus: string;
  readonly nodeBin?: string;
  readonly nodeBinVersion?: string;
  modes: ModeReport[];
}

/** Хосты процессами Node: pid живого хоста берётся из таблицы процессов по аргументам запуска (`forkHosts` pid не отдаёт). */
function processHosts(entry: string, fork: Parameters<typeof forkHosts>[0]): UtilityHosts {
  const spawn = forkHosts({ silent: true, entry, ...fork });
  const pidOf = (hostId: string): number | undefined => {
    try {
      const out = execFileSync('pgrep', ['-P', String(process.pid), '-f', `${path.basename(entry)} ${hostId}$`], { encoding: 'utf8', timeout: 5000 });
      const pid = Number(out.split('\n')[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  return { spawn, pidOf };
}

interface ModeSetup {
  readonly mode: HostMode;
  readonly description: string;
  readonly hosts: () => UtilityHosts;
  /** Сначала проверяется, что хост вообще стартует и отвечает; если нет - режим дальше не меряется, причина идёт в отчёт. */
  readonly probeFirst?: boolean;
}

function modes(options: NodeHostSpikeOptions): ModeSetup[] {
  const allowed = [`--allow-fs-read=${path.dirname(options.nodeEntry)}`, `--allow-fs-read=${options.benchDir}`];
  // Хост стороннего плагина по рекомендации исследования (5.3): пустой env, чтение только каталога пакета и каталога бандла хоста, без child-process, worker и аддонов.
  const confined = ['--permission', ...allowed];
  const list: ModeSetup[] = [{ mode: 'utilityProcess', description: 'utilityProcess из playground (как сегодня): запреты Node не действуют', hosts: () => utilityHosts(options.utilityEntry) }];
  if (options.nodeBin !== undefined) {
    const execPath = options.nodeBin;
    const where = `бинарник Node ${execPath}, --permission, env пуст`;
    list.push({ mode: 'node-advanced', description: `${where}; канал advanced (structuredClone), как у utilityProcess`, probeFirst: true, hosts: () => processHosts(options.nodeEntry, { execPath, execArgv: confined, env: {} }) });
    list.push({ mode: 'node-json', description: `${where}; канал json (типы structuredClone теряются)`, hosts: () => processHosts(options.nodeEntry, { execPath, execArgv: confined, env: {}, serialization: 'json' }) });
  }
  list.push({
    mode: 'electron-as-node',
    description: 'бинарник Electron в режиме Node (RunAsNode, ELECTRON_RUN_AS_NODE=1), --permission, env пуст кроме флага режима',
    hosts: () => processHosts(options.nodeEntry, { execPath: process.execPath, execArgv: confined, env: { ELECTRON_RUN_AS_NODE: '1' } }),
  });
  return list;
}

/** Хост стартует и отвечает на вызов за 15 с? Нет - причина строкой. Ядро выгружается в любом случае: хост, который не читает канал, иначе перезапускался бы весь замер. */
async function probe(options: HostsSpikeOptions): Promise<string | undefined> {
  const hosts = options.spawn?.();
  if (hosts === undefined) return 'нет хостов';
  const journal: string[] = [];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['bench-clone'],
    manifests: [manifest('bench-clone', { commands: { 'bench-clone.echo': { args: ['any'] } } })],
    spawnHost: hosts.spawn,
    entry: () => pathToFileURL(path.join(options.benchDir, 'clone.ts')).href,
    bundled: ['bench-clone'],
    hosts: { solo: ['bench-clone'] },
    watchdog: { interval: 500, timeout: 2500, strikes: 1 },
    onJournal: (entry) => journal.push(entry.kind === 'host-down' ? `host-down: ${entry.reason}` : entry.kind),
  });
  try {
    const answer = await Promise.race([kernel.run('bench-clone.echo', { map: new Map([['a', 1]]) }).then(() => 'ok', (error: unknown) => `вызов: ${error instanceof Error ? error.message : String(error)}`), sleep(15_000).then(() => 'хост не ответил за 15 с')]);
    return answer === 'ok' ? undefined : `${answer}; журнал ядра: ${journal.join(', ')}`;
  } finally {
    await kernel.unload();
  }
}

/** Старт хоста: от запуска ядра с одним пустым плагином до его `activated`; каждый раз новое ядро и новый процесс. */
async function startTimes(options: HostsSpikeOptions, mode: HostMode, samples = 9): Promise<StartRow> {
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    const session = await start(options, [manifest('idle-0')], { solo: ['idle-0'] });
    times.push(performance.now() - t);
    await session.kernel.unload();
  }
  times.sort((a, b) => a - b);
  return { mode, samples, p50Ms: round(times[Math.floor(times.length / 2)] ?? NaN, 1), p95Ms: round(times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? NaN, 1), maxMs: round(times.at(-1) ?? NaN, 1) };
}

/** Вызов `ctx.os.fs.readText` из плагина: хост -> ядро -> шлюз -> хост. Плагин в хосте под --permission прочесть файл сам не может, шлюз - единственный путь. */
async function osCalls(options: HostsSpikeOptions, mode: HostMode, dir: string): Promise<OsRow[]> {
  const rows: OsRow[] = [];
  const hosts = options.spawn?.();
  if (hosts === undefined) throw new Error('нет хостов');
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['bench-osread'],
    manifests: [manifest('bench-osread', { permissions: { 'fs.read': [dir] }, commands: { 'bench-osread.run': { args: ['string', 'number'] } } })],
    spawnHost: hosts.spawn,
    entry: () => pathToFileURL(path.join(options.benchDir, 'os-read.ts')).href,
    bundled: ['bench-osread'],
    hosts: { solo: ['bench-osread'] },
    os: { dataDir: path.join(dir, 'data'), tempDir: path.join(dir, 'temp') },
  });
  try {
    await kernel.idle();
    for (const size of [64, 4096, 65536]) {
      const r = (await kernel.run('bench-osread.run', path.join(dir, `${String(size)}.bin`), 300)) as { p50: number; p95: number; p99: number };
      rows.push({ mode, sizeBytes: size, p50: r.p50, p95: r.p95, p99: r.p99 });
    }
  } finally {
    await kernel.unload();
  }
  return rows;
}

/** Значения, которые каналу клонирования положено пройти или отвергнуть одинаково во всех режимах (utilityProcess: structuredClone, fork: advanced-сериализация). */
const CLONE_CASES: readonly [string, () => unknown][] = [
  ['Map/Set/Date/BigInt', () => ({ m: new Map([['a', 1n]]), s: new Set([1]), d: new Date(0) })],
  ['Uint8Array', () => new Uint8Array([1, 2, 3])],
  ['ArrayBuffer 1 МиБ', () => new Uint8Array(1 << 20).buffer],
  ['Error', () => new RangeError('x', { cause: 'y' })],
  ['циклическая ссылка', () => { const o: Record<string, unknown> = {}; o.self = o; return o; }],
  ['разреженный массив, -0, NaN, undefined', () => { const a: unknown[] = []; a[0] = 1; a[2] = -0; a[3] = Number.NaN; a[4] = undefined; return a; }],
  ['экземпляр класса', () => new (class Point { x = 1; })()],
  ['RegExp', () => /a+/gi],
  ['функция', () => ({ f: () => 1 })],
  ['Symbol', () => Symbol('s')],
];

function describeValue(value: unknown): string {
  if (value instanceof Error) return `Error ${value.name}: cause=${String(value.cause)}`;
  if (value instanceof ArrayBuffer) return `ArrayBuffer ${String(value.byteLength)}`;
  if (value instanceof Uint8Array) return `Uint8Array ${String([...value])}`;
  if (value instanceof RegExp) return `RegExp ${String(value)}`;
  if (Array.isArray(value)) return `Array ${String(value.length)}: ${Object.keys(value).join(',')} ${String(Object.is(value[2], -0))}`;
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
    return `${proto?.constructor?.name ?? 'null'} {${Object.keys(value).join(',')}}`;
  }
  return typeof value;
}

async function cloneParity(options: HostsSpikeOptions, mode: HostMode): Promise<CloneRow[]> {
  const rows: CloneRow[] = [];
  const session = await start(options, [manifest('bench-clone', { commands: { 'bench-clone.echo': { args: ['any'] } } })], { solo: ['bench-clone'] }).catch(async () => undefined);
  if (session === undefined) return rows;
  try {
    for (const [name, make] of CLONE_CASES) {
      try {
        rows.push({ mode, value: name, outcome: describeValue(await session.kernel.run('bench-clone.echo', make())) });
      } catch (error) {
        rows.push({ mode, value: name, outcome: `отказ ${(error as { code?: string }).code ?? (error as Error).name}` });
      }
    }
  } finally {
    await session.kernel.unload();
  }
  return rows;
}

export async function runNodeHostSpike(options: NodeHostSpikeOptions): Promise<void> {
  const report: NodeHostReport = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model ?? '?'}`,
    ...(options.nodeBin !== undefined && { nodeBin: options.nodeBin, nodeBinVersion: execFileSync(options.nodeBin, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim() }),
    modes: [],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-spike-node-host-'));
  for (const size of [64, 4096, 65536]) fs.writeFileSync(path.join(dir, `${String(size)}.bin`), 'x'.repeat(size));
  try {
    for (const setup of modes(options)) {
      const result: ModeReport = { mode: setup.mode, description: setup.description };
      report.modes.push(result);
      const o: HostsSpikeOptions = { out: options.out, hostEntry: options.utilityEntry, benchDir: options.benchDir, spawn: setup.hosts };
      try {
        if (setup.probeFirst === true) {
          const problem = await probe(o);
          if (problem !== undefined) {
            result.probeOnly = problem;
            continue;
          }
        }
        result.starts = await startTimes(o, setup.mode);
        result.memory = (await memory(o)).filter((m) => m.layout === 'хост на плагин' && (m.hosts === 1 || m.hosts === 5));
        Object.assign(result, await rpc(o));
        result.os = await osCalls(o, setup.mode, dir);
        const b = await blocking(o);
        result.work = b.work;
        result.ping = b.ping;
        result.watchdog = await watchdogTimes(o);
        result.clone = await cloneParity(o, setup.mode);
      } catch (error) {
        result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.exitCode = 1;
      }
      await sleep(500);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.writeFileSync(options.out, JSON.stringify(report, null, 2));
}
