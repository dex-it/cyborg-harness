import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch as watchFs, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { forkHosts, load, PLUGIN_API_VERSION, type Kernel, type OsEnvironment } from '@cyborg-harness/core';
import { sandbox, type Sandbox } from '@cyborg-harness/testing';

// Общий стенд пилота PL-04 (files, git, viewer): настоящие плагины на хостах-процессах (forkHosts) над настоящим репозиторием git.
// Сюда же относятся счётчики, независимые от самих плагинов: запуски git считает программа-обёртка в PATH, слежения и события - обёртка над fs.watch шлюза.

const PLUGINS = path.join(import.meta.dirname, '..', 'plugins');
export const PILOT = ['files', 'git', 'viewer'] as const;
export type PilotId = (typeof PILOT)[number];

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Репозиторий с файлами `путь -> текст`, одним коммитом на ветке main. */
export async function makeRepo(box: Sandbox, files: Readonly<Record<string, string>>, name = 'repo'): Promise<string> {
  const repo = box.path(name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFiles(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

export async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
}

/** Проба: плагин-потребитель с заданными правами и кодом, который вызывает контракты и копит события подписок. */
export interface Probe {
  readonly id: string;
  readonly permissions?: Record<string, unknown>;
  readonly requires?: Record<string, string>;
  readonly consumes?: Record<string, string>;
}

const PROBE_CODE = `
const events = [];
const probe = {
  activate(ctx) {
    const target = (contract) => {
      try {
        return ctx.contracts.get(contract, 1);
      } catch {
        return ctx.contracts.all(contract, 1)[0]?.impl;
      }
    };
    ctx.commands.register(ctx.pluginId + '.call', (contract, member, ...args) => target(contract)[member](...args));
    // Слушатель - последний аргумент, как у всех подписок контрактов.
    ctx.commands.register(ctx.pluginId + '.watch', (contract, member, ...args) => {
      const sub = target(contract)[member](...args, (...got) => events.push(got));
      ctx.subscriptions.add({ dispose: () => void Promise.resolve(sub).then((s) => s.dispose(), () => undefined) });
    });
    ctx.commands.register(ctx.pluginId + '.events', () => events.splice(0));
    return undefined;
  },
};
export default probe;
`;

export interface Pilot {
  readonly k: Kernel;
  readonly box: Sandbox;
  readonly repo: string;
  /** Запуски git: по строке на запуск, как их видит программа-обёртка в PATH. */
  gitRuns(): Promise<string[]>;
  /** fs.watch шлюза: открытые за всё время, закрытые, события до склейки. */
  readonly watches: { readonly opened: string[]; closed: number; raw: number; readonly live: () => number };
  [Symbol.asyncDispose](): Promise<void>;
}

export interface PilotOptions {
  readonly repo: string;
  readonly box: Sandbox;
  readonly ids?: readonly PilotId[];
  readonly probes?: readonly Probe[];
  /** Корни воркспейса; по умолчанию репозиторий. */
  readonly roots?: readonly string[];
  /** Своя обёртка над fs.watch (замеры подмешивают задержку и счёт). */
  readonly watch?: OsEnvironment['watch'];
}

/** Поднимает ядро: каждый плагин пилота в своём хосте-процессе, пробы - тоже. */
export async function startPilot(options: PilotOptions): Promise<Pilot> {
  const { box, repo } = options;
  const ids = options.ids ?? PILOT;
  const bin = box.path('bin');
  const log = box.path('git-runs.log');
  await mkdir(bin, { recursive: true });
  await writeFile(log, '');
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`);
  await chmod(path.join(bin, 'git'), 0o755);

  const manifests: unknown[] = [];
  const entries = new Map<string, string>();
  for (const id of ids) {
    manifests.push(JSON.parse(await readFile(path.join(PLUGINS, id, 'manifest.json'), 'utf8')));
    entries.set(id, pathToFileURL(path.join(PLUGINS, id, 'index.ts')).href);
  }
  for (const probe of options.probes ?? []) {
    const dir = box.path('probes', probe.id);
    await mkdir(dir, { recursive: true });
    const commands = Object.fromEntries([['call', { args: ['string', 'string'], rest: 'any' }], ['watch', { args: ['string', 'string'], rest: 'any' }], ['events', {}]].map(([n, s]) => [`${probe.id}.${n as string}`, s]));
    manifests.push({ id: probe.id, version: '1.0.0', engines: { cyborg: '^1' }, commands, ...(probe.permissions && { permissions: probe.permissions }), ...(probe.requires && { requires: probe.requires }), ...(probe.consumes && { consumes: probe.consumes }) });
    await writeFile(path.join(dir, 'index.ts'), PROBE_CODE);
    entries.set(probe.id, pathToFileURL(path.join(dir, 'index.ts')).href);
  }

  const watches = { opened: [] as string[], closed: 0, raw: 0, live: () => watches.opened.length - watches.closed };
  type Watch = (target: string, listener: (event: string, name: string | null) => void) => FSWatcher;
  const inner = (options.watch ?? watchFs) as unknown as Watch;
  const counted = ((target: string, listener: (event: string, name: string | null) => void) => {
    watches.opened.push(target);
    const w = inner(target, (event, name) => {
      watches.raw++;
      listener(event, name);
    });
    const close = w.close.bind(w);
    let closed = false;
    w.close = () => {
      if (!closed) watches.closed++;
      closed = true;
      close();
    };
    return w;
  }) as unknown as NonNullable<OsEnvironment['watch']>;

  const allIds = manifests.map((m) => (m as { id: string }).id);
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: allIds,
    manifests,
    // Каждый плагин в своём хосте: граница, которую пилот должен проверить.
    hosts: Object.fromEntries(allIds.map((id) => [id, [id]])),
    spawnHost: forkHosts({ silent: true }),
    entry: (m) => entries.get(m.id) ?? m.id,
    os: {
      dataDir: box.path('data'),
      tempDir: box.path('temp'),
      home: box.root,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: box.root },
      roots: () => options.roots ?? [repo],
      watch: counted,
    },
    watchdog: { interval: 500, timeout: 20_000, strikes: 3 },
  });
  return {
    k,
    box,
    repo,
    watches,
    gitRuns: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    [Symbol.asyncDispose]: () => k.unload(),
  };
}

export { sandbox };
