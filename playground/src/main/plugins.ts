import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeEntry, entryLevel, entryPlugins, load, pluginStatuses, SectionStore, type JournalEntry, type Kernel, type LayerStore, type SpawnHost } from '../../../core/src/index.ts';
import { isRecord } from '../../../core/src/manifest.ts';
import type { PluginJournalLine, PluginRow, PluginsSnapshot } from '../shared/plugins.ts';
import { writeJsonAtomic } from './jsonfile.ts';

export const PLUGIN_API_VERSION = '1.0.0';

const ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'];

export interface Discovered {
  readonly manifests: unknown[];
  /** id -> file URL точки входа; при повторе id остаётся первый, второму граф откажет. */
  readonly entries: Map<string, string>;
  readonly problems: string[];
}

/** Каталоги по порядку приоритета: встроенные раньше пользовательских. */
export function discoverPlugins(dirs: readonly string[]): Discovered {
  const found: Discovered = { manifests: [], entries: new Map(), problems: [] };
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const home = path.join(dir, name);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(home, 'manifest.json'), 'utf8'));
      } catch (error) {
        found.problems.push(`${home}: manifest.json не прочитан - ${(error as Error).message}`);
        continue;
      }
      found.manifests.push(raw);
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined;
      const entry = ENTRY_FILES.map((f) => path.join(home, f)).find((f) => fs.existsSync(f));
      if (id && entry && !found.entries.has(id)) found.entries.set(id, pathToFileURL(entry).href);
    }
  }
  return found;
}

export interface UserConfig {
  readonly enabled: string[];
  readonly hosts: Record<string, string[]>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Файл пользователя в форме главного конфига SAD2 §3.10: `plugins` - ядру, `settings` - разделы плагинов. */
export function readUserConfig(file: string): { config: UserConfig; problem?: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { config: { enabled: [], hosts: {} }, ...(!missing && { problem: `${file}: ${(error as Error).message}` }) };
  }
  const plugins = isRecord(doc) && isRecord(doc.plugins) ? doc.plugins : {};
  const hosts = isRecord(plugins.hosts) ? Object.fromEntries(Object.entries(plugins.hosts).map(([h, ids]) => [h, strings(ids)])) : {};
  return { config: { enabled: strings(plugins.enabled), hosts } };
}

/** Слой user поверх `settings` того же файла; битый файл не перезаписывается. */
export function userLayerStore(file: string): LayerStore {
  const read = (): Record<string, unknown> => {
    try {
      const doc: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isRecord(doc)) throw new Error('корень не объект');
      return doc;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new Error(`${file} не разобран, запись отменена: ${(error as Error).message}`);
    }
  };
  return {
    async load() {
      const settings = read().settings;
      return isRecord(settings) ? settings : undefined;
    },
    async save(_layer, settings) {
      writeJsonAtomic(file, { ...read(), settings });
    },
  };
}

export interface StartOptions {
  readonly userData: string;
  readonly builtinDir: string;
  readonly spawnHost: SpawnHost;
  readonly log: (line: string) => void;
  readonly onJournal?: (entry: JournalEntry) => void;
  /** Что не дошло до ядра; по умолчанию - в log. */
  readonly onProblem?: (problem: string) => void;
}

export async function startPlugins(options: StartOptions): Promise<Kernel> {
  const file = path.join(options.userData, 'cyborg.json');
  const report = (p: string) => {
    options.log(`[plugins] ${p}`);
    options.onProblem?.(p);
  };
  const { config: user, problem } = readUserConfig(file);
  if (problem) report(problem);
  const found = discoverPlugins([options.builtinDir, path.join(options.userData, 'plugins')]);
  for (const p of found.problems) report(p);

  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: user.enabled,
    manifests: found.manifests,
    hosts: user.hosts,
    spawnHost: options.spawnHost,
    entry: (m) => found.entries.get(m.id) ?? m.id,
    config: await SectionStore.open(userLayerStore(file), ['user']),
    onJournal: (entry) => {
      options.log(`[plugins] ${JSON.stringify(entry)}`);
      options.onJournal?.(entry);
    },
    onLog: (id, message) => options.log(`[plugins] ${id}: ${message}`),
  });
}

export interface PluginsEvents {
  /** Снимок поменялся: открытое окно перечитывает его. */
  changed(): void;
  /** Плагин выключился во время работы: видов у плагинов пока нет, поэтому одно уведомление ядра (SAD2 §3.5). */
  alert(title: string, body: string): void;
}

/** Ядро плагинов глазами окна «Плагины Cyborg»: журнал с временем, состояние каждого плагина, «Включить снова». */
export class PluginsService {
  private kernel: Kernel | undefined;
  private phase: PluginsSnapshot['phase'] = 'starting';
  private error: string | undefined;
  private readonly entries: { at: number; entry: JournalEntry }[] = [];
  private readonly problems: string[] = [];

  private readonly events: PluginsEvents;
  private readonly now: () => number;

  constructor(events: PluginsEvents, now: () => number = Date.now) {
    this.events = events;
    this.now = now;
  }

  async start(options: Omit<StartOptions, 'onJournal' | 'onProblem'>): Promise<void> {
    try {
      this.kernel = await startPlugins({
        ...options,
        onJournal: (entry) => this.record(entry),
        onProblem: (problem) => {
          this.problems.push(problem);
          this.events.changed();
        },
      });
      this.phase = 'ready';
    } catch (error) {
      this.phase = 'failed';
      this.error = (error as Error).message;
      options.log(`[plugins] ядро не запустилось: ${(error as Error).stack ?? this.error}`);
    }
    this.events.changed();
  }

  private record(entry: JournalEntry): void {
    this.entries.push({ at: this.now(), entry });
    if (this.phase === 'ready' && entry.kind === 'switched-off') this.events.alert(`Плагин ${entry.pluginId} выключен`, describeEntry(entry));
    if (this.phase === 'ready' && entry.kind === 'host-abandoned') this.events.alert(`Плагины выключены: ${entry.plugins.join(', ')}`, describeEntry(entry));
    this.events.changed();
  }

  snapshot(): PluginsSnapshot {
    const kernel = this.kernel;
    const versions = new Map(kernel?.manifests.map((m) => [m.id, m.version]));
    const plugins: PluginRow[] = pluginStatuses(this.entries.map((e) => e.entry)).map((s) => {
      const host = s.state === 'disabled' ? undefined : kernel?.hostOf(s.id);
      return {
        id: s.id,
        state: s.state,
        revivable: s.revivable && kernel !== undefined,
        ...(versions.has(s.id) && { version: versions.get(s.id) }),
        ...(host !== undefined && { host }),
        ...(s.cause && s.state !== 'active' && { reason: describeEntry(s.cause) }),
      };
    });
    const journal: PluginJournalLine[] = this.entries.map(({ at, entry }) => ({
      at,
      subject: entry.pluginId ?? `хост ${entry.hostId}`,
      // Задетые потребители тоже: в журнале плагина видно, что его поставщик пропадал.
      plugins: [...new Set([...entryPlugins(entry), ...('affects' in entry ? entry.affects : [])])],
      text: describeEntry(entry),
      level: entryLevel(entry),
    }));
    return { phase: this.phase, ...(this.error !== undefined && { error: this.error }), problems: [...this.problems], plugins, journal };
  }

  async revive(id: unknown): Promise<{ error?: string }> {
    if (typeof id !== 'string') return { error: 'нет id плагина' };
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      await this.kernel.revive(id);
      return {};
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  async unload(): Promise<void> {
    await this.kernel?.unload();
  }
}
