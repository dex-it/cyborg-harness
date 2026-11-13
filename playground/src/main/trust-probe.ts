// Проба доверия на настоящем utilityProcess (TR-01, docs/research/trust-and-isolation): плагин-нарушитель в хосте стороннего плагина.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProvenance, load, PLUGIN_API_VERSION, TrustStore, type JournalEntry } from '@cyborg-harness/core';
import { generateSigningKey, hashFiles, renderIntegrity, signIntegrity } from '@cyborg-harness/core/integrity';
import { isolatedHosts } from '@cyborg-harness/electron';
import type { IsolationSettings } from '@cyborg-harness/electron/isolation';

export interface TrustProbeOptions {
  readonly out: string;
  readonly hostEntry: string;
  readonly probeDir: string;
  /** Настройки изоляции для прохода «node» (бинарник Node, вход хоста, ограничитель); без них проход «node» не выполняется. */
  readonly isolation?: IsolationSettings;
}

const TOKEN = 'token-of-main-process';
const manifest = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...extra });

/** Что увидел нарушитель (`violator.probe`) плюс то, что про хосты знает ядро: один проход пробы по способу запуска стороннего хоста. */
export interface ModeReport {
  readonly hosts: Readonly<Record<string, { readonly hostId: string | undefined; readonly pid: number | undefined; readonly reported: number }>>;
  readonly violator?: {
    readonly channel: string;
    readonly worker: string;
    readonly addon: string;
    readonly permission: string;
    readonly envToken: string | null;
    readonly envKeys: readonly string[];
    readonly coreFile: string;
    readonly spawn: string;
    readonly tcp: string;
    readonly forged: string;
    readonly raw: { readonly messages: number; readonly initManifests: readonly string[]; readonly contractProviders: readonly string[]; readonly contractData: readonly string[] };
  };
  /** Потребитель в своём хосте получил данные поставщика: фильтры рассылок не должны этого ломать. */
  readonly friendRead?: string | null;
  readonly tcpConnections?: number;
  readonly journal: readonly string[];
  /** TR-24: уровень изоляции, который ядро записало для плагина (`isolation`), и то, что хост доказал; `ineffective` - причины записи `sandbox-ineffective`. */
  readonly isolation: Readonly<Record<string, { readonly level: number; readonly network: string; readonly reason: string } | undefined>>;
  readonly ineffective?: readonly string[];
  error?: string;
}

export interface TrustReport {
  readonly electron: string;
  readonly node: string;
  readonly platform: string;
  readonly mainPid: number;
  /** `utility` - сторонний плагин в utilityProcess (настройка возврата), `node` - процесс Node под запретами и ограничителем (TR-21, TR-22). */
  readonly modes: { readonly utility: ModeReport; readonly node?: ModeReport };
  /** TR-11: подписанный плагин, файл которого подменили сразу после проверки; что ответил хост и что лежит на диске. */
  readonly verified?: { readonly answer: unknown; readonly diskAfter: string; readonly pid: number | undefined; readonly refused: readonly string[]; readonly journal: readonly string[] };
  error?: string;
}

const GOOD = "export default { activate(ctx) { ctx.commands.register('signed.hello', () => 'GOOD'); } };\n";
const EVIL = "export default { activate(ctx) { ctx.commands.register('signed.hello', () => 'EVIL'); } };\n";

/**
 * TR-11 на настоящем utilityProcess: ядро проверяет подписанный пакет, и сразу после проверки файл на диске подменён; хост должен исполнить проверенные байты.
 * Второй пакет с изменённым файлом в режиме отказа не запускается вовсе.
 */
async function verifiedScenario(hostEntry: string, dir: string, isolation: IsolationSettings): Promise<NonNullable<TrustReport['verified']>> {
  const key = generateSigningKey();
  const make = (name: string, tamper: boolean) => {
    const home = path.join(dir, name);
    fs.mkdirSync(home, { recursive: true });
    const files = { 'manifest.json': JSON.stringify(manifest('signed', { commands: ['signed.hello'] })), 'index.mjs': GOOD };
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(home, file), text);
    fs.writeFileSync(path.join(home, 'integrity.json'), renderIntegrity(signIntegrity({ id: 'signed', version: '1.0.0', files: hashFiles(new Map(Object.entries(files).map(([f, t]) => [f, Buffer.from(t)]))), notAfter: new Date(Date.now() + 86_400_000) }, key.secretKey)));
    if (tamper) fs.appendFileSync(path.join(home, 'index.mjs'), '// подмена до проверки');
    return home;
  };
  const run = async (home: string, swapAfterCheck: boolean) => {
    const trust = await TrustStore.open(path.join(dir, `${path.basename(home)}-trust.json`));
    await trust.addPublisher(key.publicKey);
    const inner = createProvenance({ trust, releaseKeys: [], mode: () => 'enforce', bundled: () => false, homeOf: () => home });
    const journal: JournalEntry[] = [];
    const hosts = isolatedHosts(hostEntry, isolation);
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ['signed'],
      // Не из поставки: с настройкой `node` подписанный плагин идёт в процесс Node под запретами и исполняет проверенные байты, не читая файл.
      bundled: ['bundled-none'],
      manifests: [manifest('signed', { commands: ['signed.hello'] })],
      spawnHost: hosts.spawn,
      entry: () => pathToFileURL(path.join(home, 'index.mjs')).href,
      provenance: {
        async check(m) {
          const verdict = await inner.check(m);
          if (swapAfterCheck) fs.writeFileSync(path.join(home, 'index.mjs'), EVIL);
          return verdict;
        },
      },
      onJournal: (entry) => journal.push(entry),
    });
    try {
      await kernel.idle();
      const active = kernel.active.includes('signed');
      return { answer: active ? await kernel.run('signed.hello') : null, pid: active ? hosts.pidOf(kernel.hostOf('signed') ?? '') : undefined, journal: journal.flatMap((e) => (e.kind === 'integrity-failed' ? [`${e.code}/${e.mode}`] : [])), all: journal.map((e) => JSON.stringify(e)) };
    } finally {
      await kernel.unload();
    }
  };
  const good = make('good', false);
  const swapped = await run(good, true);
  const refused = await run(make('tampered', true), false);
  return { answer: swapped.answer, diskAfter: fs.readFileSync(path.join(good, 'index.mjs'), 'utf8') === EVIL ? 'EVIL' : 'GOOD', pid: swapped.pid, refused: refused.journal, journal: swapped.all };
}

/** Один проход пробы: ядро с поставкой (bystander, friend) и нарушителем-сторонним; способ запуска стороннего хоста задаёт `isolation`. */
async function scenario(options: TrustProbeOptions, isolation: IsolationSettings, dir: string, secretPath: string, port: number, connections: () => number): Promise<ModeReport> {
  const report: { -readonly [K in keyof ModeReport]: ModeReport[K] } = { hosts: {}, journal: [], isolation: {} };
  const journal: JournalEntry[] = [];
  const hosts = isolatedHosts(options.hostEntry, isolation);
  const ids = ['bystander', 'friend', 'violator'];
  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests: [
      manifest('bystander', { provides: { 'trust.vault': '1.0' }, commands: { 'bystander.reprovide': {}, 'bystander.pid': {} } }),
      manifest('friend', { host: 'own', requires: { 'trust.vault': '^1' }, commands: { 'friend.read': {}, 'friend.pid': {} } }),
      manifest('violator', { commands: { 'violator.probe': { args: ['any'] }, 'violator.pid': {} } }),
    ],
    spawnHost: hosts.spawn,
    entry: (m) => pathToFileURL(path.join(options.probeDir, `${m.id}.ts`)).href,
    // Сторонний - тот, кого нет в поставке; просьба сгруппировать его с соседом даёт запись host-isolated (FR-CH-1005).
    bundled: ['bystander', 'friend'],
    hosts: { shared: ['bystander', 'violator'] },
    onJournal: (entry) => journal.push(entry),
  });
  try {
    await kernel.idle();
    for (const id of ids) {
      const hostId = kernel.hostOf(id);
      const reported = (await kernel.run(`${id}.pid`)) as number;
      report.hosts = { ...report.hosts, [id]: { hostId, pid: hostId === undefined ? undefined : hosts.pidOf(hostId), reported } };
    }
    // Описание контракта уходит хостам при каждом provide; нарушитель к этому времени уже слушает канал.
    await kernel.run('bystander.reprovide');
    report.violator = (await kernel.run('violator.probe', { port, secretPath })) as NonNullable<ModeReport['violator']>;
    report.friendRead = (await kernel.run('friend.read')) as string | null;
    report.tcpConnections = connections();
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  } finally {
    report.journal = journal.map((e) => `${e.pluginId ?? ''}:${e.kind}`);
    for (const e of journal) {
      if (e.kind === 'isolation') report.isolation = { ...report.isolation, [e.pluginId]: { level: e.level, network: e.network, reason: e.reason } };
      if (e.kind === 'sandbox-ineffective') report.ineffective = e.reasons;
    }
    await kernel.unload();
  }
  return report;
}

export async function runTrustProbe(options: TrustProbeOptions): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-trust-probe-'));
  const secretPath = path.join(dir, 'core-secrets.json');
  fs.writeFileSync(secretPath, JSON.stringify({ 'bystander/token': 'secret-of-core' }));
  // Окружение главного процесса, которое хост без явного `env` наследует (находка 1, таблица 2.8).
  process.env.CYBORG_TRUST_TOKEN = TOKEN;
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const report: { -readonly [K in keyof TrustReport]: TrustReport[K] } = {
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    mainPid: process.pid,
    modes: undefined as unknown as TrustReport['modes'],
  };
  try {
    // Возврат одной настройкой: сторонний плагин в utilityProcess, как до TR-21.
    const utility = await scenario(options, { thirdPartyHost: 'utility' }, dir, secretPath, port, () => connections);
    connections = 0;
    const node = options.isolation?.node === undefined ? undefined : await scenario(options, options.isolation, dir, secretPath, port, () => connections);
    report.modes = { utility, ...(node !== undefined && { node }) };
    report.verified = await verifiedScenario(options.hostEntry, dir, options.isolation ?? {});
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.writeFileSync(options.out, JSON.stringify(report, null, 2));
  }
}
