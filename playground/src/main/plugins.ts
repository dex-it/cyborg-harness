import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  describeEntry,
  describePermissions,
  entryLevel,
  errorMessage,
  entryPlugins,
  keyOfInput,
  load,
  pluginStatuses,
  openWorkspace,
  type JournalEntry,
  type Kernel,
  type KeyInput,
  type OsEnvironment,
  type SpawnHost,
  type SystemEvent,
  type WatchdogOptions,
} from '../../../core/src/index.ts';
import { isRecord } from '../../../core/src/manifest.ts';
import type { FeedLine, KeyRow, PluginJournalLine, PluginRow, PluginsSnapshot, Reply } from '../shared/plugins.ts';
import { viewOrigin } from '../shared/views.ts';

export const PLUGIN_API_VERSION = '1.0.0';

const ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'];

export interface Discovered {
  readonly manifests: unknown[];
  /** id -> file URL точки входа; при повторе id остаётся первый, второму граф откажет. */
  readonly entries: Map<string, string>;
  /** id -> каталог, где найден первым. */
  readonly origins: Map<string, string>;
  /** id -> каталог вида плагина, если в его каталоге есть view/index.html. */
  readonly views: Map<string, string>;
  readonly problems: string[];
}

/** Каталоги по порядку приоритета: встроенные раньше пользовательских. */
export function discoverPlugins(dirs: readonly string[]): Discovered {
  const found: Discovered = { manifests: [], entries: new Map(), origins: new Map(), views: new Map(), problems: [] };
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
      if (id && !found.origins.has(id)) {
        found.origins.set(id, dir);
        const view = path.join(home, 'view');
        if (fs.existsSync(path.join(view, 'index.html'))) found.views.set(id, view);
      }
    }
  }
  return found;
}

export interface StartOptions {
  readonly userData: string;
  /** Файл воркспейса; по умолчанию `<userData>/workspace.cyborg.json`. */
  readonly workspace?: string;
  readonly builtinDir: string;
  readonly spawnHost: SpawnHost;
  readonly log: (line: string) => void;
  readonly watchdog?: WatchdogOptions;
  /** Среда шлюза ctx.os; без неё - каталоги во временном каталоге ОС, без секретов и уведомлений. */
  readonly os?: OsEnvironment;
  /** Под какую платформу читать CmdOrCtrl; по умолчанию - текущая. */
  readonly platform?: string;
  /** Секунды простоя пользователя по ОС - для `ctx.system.onIdle`. */
  readonly idleSeconds?: () => number;
  readonly onJournal?: (entry: JournalEntry) => void;
  readonly onLog?: (pluginId: string, message: string) => void;
  /** Что не дошло до ядра; по умолчанию - в log. */
  readonly onProblem?: (problem: string) => void;
  readonly onDiscovered?: (found: Discovered) => void;
}

export async function startPlugins(options: StartOptions): Promise<Kernel & { readonly workspace: string }> {
  const report = (p: string) => {
    options.log(`[plugins] ${p}`);
    options.onProblem?.(p);
  };
  const file = options.workspace ?? path.join(options.userData, 'workspace.cyborg.json');
  const opened = await openWorkspace({ file, userFile: path.join(options.userData, 'cyborg.json'), stateDir: path.join(options.userData, 'state') });
  if (!opened.ok) throw new Error(`воркспейс ${file} уже открыт процессом ${opened.owner}`);
  const ws = opened.workspace;
  for (const p of ws.problems) report(p);
  for (const m of ws.migrated) options.log(`[plugins] ${m}`);
  const found = discoverPlugins([options.builtinDir, path.join(options.userData, 'plugins')]);
  for (const p of found.problems) report(p);
  options.onDiscovered?.(found);

  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ws.plugins.enabled,
    manifests: found.manifests,
    hosts: ws.plugins.hosts,
    keybindings: ws.plugins.keybindings,
    // Признак поставки - каталог установки, а не манифест: сторонний автор пишет в манифест что угодно.
    bundled: [...found.origins].filter(([, dir]) => dir === options.builtinDir).map(([id]) => id),
    spawnHost: options.spawnHost,
    entry: (m) => found.entries.get(m.id) ?? m.id,
    config: ws.config,
    state: ws.state,
    onJournal: (entry) => {
      options.log(`[plugins] ${JSON.stringify(entry)}`);
      options.onJournal?.(entry);
    },
    watchdog: options.watchdog,
    os: options.os,
    platform: options.platform,
    idleSeconds: options.idleSeconds,
    onLog: (id, message) => {
      options.log(`[plugins] ${id}: ${message}`);
      options.onLog?.(id, message);
    },
  }).catch((error: unknown) => {
    ws.close();
    throw error;
  });
  const watching = ws.watch((ids) => void kernel.reloadSections('config', ids), report);
  return {
    ...kernel,
    workspace: ws.file,
    async unload() {
      watching.dispose();
      try {
        await kernel.unload();
      } finally {
        ws.close();
      }
    },
  };
}

export interface PluginsEvents {
  /** Снимок поменялся: открытое окно перечитывает его. */
  changed(): void;
  /** Плагин выключился во время работы: видов у плагинов пока нет, поэтому одно уведомление ядра (SAD2 §3.5). */
  alert(title: string, body: string): void;
  /** Сообщение плагина: его вид получает строку сразу, без снимка. */
  log?(pluginId: string, line: FeedLine): void;
}

export interface ServiceOptions extends Omit<StartOptions, 'onJournal' | 'onProblem' | 'onLog' | 'onDiscovered'> {
  /** Процесс хоста для «Уронить» и «Повесить»; у хостов в том же процессе его нет. */
  readonly pidOf?: (hostId: string) => number | undefined;
}

const FEED_LIMIT = 300;

/** Ядро плагинов глазами окна playground: журнал, состояние плагинов, клавиши, лента сообщений и кнопки над ними. */
export class PluginsService {
  private kernel: Kernel | undefined;
  private phase: PluginsSnapshot['phase'] = 'starting';
  private error: string | undefined;
  private pidOf: ServiceOptions['pidOf'];
  private readonly entries: { at: number; entry: JournalEntry }[] = [];
  private readonly problems: string[] = [];
  private readonly feed: FeedLine[] = [];
  private views = new Map<string, string>();
  private quitting: Promise<void> | undefined;

  private readonly events: PluginsEvents;
  private readonly now: () => number;

  constructor(events: PluginsEvents, now: () => number = Date.now) {
    this.events = events;
    this.now = now;
  }

  async start(options: ServiceOptions): Promise<void> {
    this.pidOf = options.pidOf;
    try {
      this.kernel = await startPlugins({
        ...options,
        onJournal: (entry) => this.record(entry),
        onProblem: (problem) => {
          this.problems.push(problem);
          this.events.changed();
        },
        onDiscovered: (found) => (this.views = found.views),
        onLog: (pluginId, text) => {
          const line = this.say({ kind: 'log', subject: pluginId, text });
          this.events.log?.(pluginId, line);
        },
      });
      this.phase = 'ready';
    } catch (error) {
      this.phase = 'failed';
      this.error = errorMessage(error);
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

  private say(line: Omit<FeedLine, 'at'>): FeedLine {
    const stamped = { at: this.now(), ...line };
    this.feed.push(stamped);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
    this.events.changed();
    return stamped;
  }

  /** Каталог вида: по нему протокол cyborg-plugin отдаёт файлы. */
  viewDir(pluginId: string): string | undefined {
    const dir = this.views.get(pluginId);
    // Показ вида - вызов ленивого плагина: мосту вида нужна его главная часть.
    if (dir !== undefined) void this.kernel?.wake(pluginId).catch(() => undefined);
    return dir;
  }

  emit(event: SystemEvent): void {
    this.kernel?.emit(event);
  }

  /** Слушатели onBeforeQuit плагинов, потом выгрузка; повторный вызов ждёт первый. */
  quit(budget: number): Promise<void> {
    this.quitting ??= (async () => {
      await this.kernel?.beforeQuit(budget);
      await this.kernel?.unload();
    })();
    return this.quitting;
  }

  /** Лента одного плагина: её вид показывает при открытии. */
  logsOf(pluginId: string): FeedLine[] {
    return this.feed.filter((line) => line.kind === 'log' && line.subject === pluginId);
  }

  /** Команда из вида: плагин назван origin фрейма, и чужую команду вид не вызовет. */
  runFor(pluginId: string, command: unknown): Promise<Reply> {
    if (typeof command !== 'string') return Promise.resolve({ error: 'нет имени команды' });
    const own = this.kernel?.manifests.find((m) => m.id === pluginId)?.commands ?? {};
    if (!(command in own)) return Promise.resolve({ error: `${command}: не команда плагина ${pluginId}` });
    return this.run(command);
  }

  snapshot(): PluginsSnapshot {
    const kernel = this.kernel;
    const manifests = new Map(kernel?.manifests.map((m) => [m.id, m]));
    const plugins: PluginRow[] = pluginStatuses(this.entries.map((e) => e.entry)).map((s) => {
      const manifest = manifests.get(s.id);
      const host = s.state === 'disabled' ? undefined : kernel?.hostOf(s.id);
      const pid = host !== undefined && s.state === 'active' ? this.pidOf?.(host) : undefined;
      const commands = Object.entries(manifest?.commands ?? {})
        .filter(([, spec]) => spec.args.every((a) => a.optional))
        .map(([name]) => name);
      return {
        id: s.id,
        state: s.state,
        revivable: s.revivable && kernel !== undefined,
        unloaded: s.cause?.kind === 'unloaded' && s.cause.by === s.id,
        commands,
        permissions: manifest ? describePermissions(manifest.permissions) : [],
        ...(manifest && { version: manifest.version }),
        ...((s.state === 'active' || s.state === 'waiting') && this.views.has(s.id) && { view: `${viewOrigin(s.id)}/` }),
        ...(host !== undefined && { host }),
        ...(pid !== undefined && { pid }),
        ...(s.cause && s.state !== 'active' && { reason: describeEntry(s.cause) }),
      };
    });
    const keys: KeyRow[] = (kernel?.keybindings ?? []).map((k) => ({
      key: k.key,
      command: k.command,
      pluginId: k.pluginId,
      live: kernel?.keybinding(k.key) !== undefined,
      shadowed: k.shadowed,
    }));
    const journal: PluginJournalLine[] = this.entries.map(({ at, entry }) => ({
      at,
      subject: entry.pluginId ?? (entry.kind === 'key-ignored' ? 'сочетания' : `хост ${entry.hostId}`),
      // Задетые потребители тоже: в журнале плагина видно, что его поставщик пропадал.
      plugins: [...new Set([...entryPlugins(entry), ...('affects' in entry ? entry.affects : [])])],
      text: describeEntry(entry),
      level: entryLevel(entry),
    }));
    return {
      phase: this.phase,
      ...(this.error !== undefined && { error: this.error }),
      problems: [...this.problems],
      plugins,
      keys,
      feed: [...this.feed],
      journal,
      canHang: process.platform !== 'win32' && this.pidOf !== undefined,
    };
  }

  /** Синхронно, иначе `preventDefault` в `before-input-event` опоздает: сочетание активного плагина страница не получает. */
  press(input: KeyInput): boolean {
    const key = keyOfInput(input);
    const kernel = this.kernel;
    const binding = key === undefined ? undefined : kernel?.keybinding(key);
    if (!binding) return false;
    this.say({ kind: 'key', subject: binding.key, text: `→ ${binding.command} (${binding.pluginId})` });
    void this.run(binding.command);
    return true;
  }

  run(command: unknown): Promise<Reply> {
    return this.act(command, 'нет имени команды', async (kernel, name) => {
      try {
        await kernel.run(name);
      } catch (error) {
        this.say({ kind: 'error', subject: name, text: errorMessage(error) });
        throw error;
      }
    });
  }

  /** Вместе с плагином уходят те, кто требует его через requires. */
  disable(id: unknown): Promise<Reply> {
    return this.act(id, 'нет id плагина', (kernel, pluginId) => kernel.disable(pluginId));
  }

  /** «Загрузить» и «Включить снова» - одно действие ядра. */
  enable(id: unknown): Promise<Reply> {
    return this.act(id, 'нет id плагина', (kernel, pluginId) => kernel.enable(pluginId));
  }

  /** Для ядра это падение хоста: сторож перезапустит его. */
  crash(id: unknown): Promise<Reply> {
    return this.signal(id, 'SIGKILL');
  }

  /** Пинги остаются без ответа, сторож признаёт зависание и убивает хост. */
  hang(id: unknown): Promise<Reply> {
    if (process.platform === 'win32') return Promise.resolve({ error: 'на Windows процесс не остановить' });
    return this.signal(id, 'SIGSTOP');
  }

  private signal(id: unknown, signal: NodeJS.Signals): Promise<Reply> {
    return this.act(id, 'нет id плагина', async (kernel, pluginId) => {
      const host = kernel.hostOf(pluginId);
      const pid = host === undefined ? undefined : this.pidOf?.(host);
      if (pid === undefined) throw new Error(`у ${pluginId} нет живого процесса хоста`);
      process.kill(pid, signal);
    });
  }

  private async act(value: unknown, missing: string, action: (kernel: Kernel, value: string) => Promise<unknown>): Promise<Reply> {
    if (typeof value !== 'string') return { error: missing };
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      await action(this.kernel, value);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    } finally {
      this.events.changed();
    }
  }

  async unload(): Promise<void> {
    await this.kernel?.unload();
  }
}
