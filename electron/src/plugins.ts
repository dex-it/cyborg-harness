import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LogLevel } from '@cyborg-harness/contracts';
import {
  describeEntry,
  describeOpenCommands,
  describePermissions,
  entryLevel,
  entryPlugins,
  appendBounded,
  keyOfInput,
  load,
  pluginStatuses,
  openWorkspace,
  PLUGIN_API_VERSION,
  type Diagnostics,
  type JournalEntry,
  type Kernel,
  type KeyInput,
  type KeyPress,
  type LoadOptions,
  type MenuEntry,
  type MigrateWorkspace,
  type OsEnvironment,
  type SpawnHost,
  type SystemEvent,
  type TerminalChannel,
  type TerminalView,
  type TraceRecord,
  type WatchdogOptions,
  type WindowSnapshot,
  MENU_OWNER,
  WINDOW_OWNER,
} from '@cyborg-harness/core';
import { readDelivery, verifyDelivery } from '@cyborg-harness/core/delivery';
import { errorMessage, isRecord } from './guards.ts';
import type { DiagnosticsExport, DiagnosticsStatus, FeedLine, KeyRow, LayoutRow, PluginJournalLine, PluginOrigin, PluginRow, PluginsSnapshot, Reply, WorkspaceInfo } from './snapshot.ts';
import { violationDetail } from './shell/csp-note.ts';
import { viewUrl } from './view-protocol.ts';
import type { ViewGroups } from './view-frames.ts';
import type { PluginUi } from './view-files.ts';

/** Имена точки входа главной части по порядку; тот же набор у `check` и `build` (`ENTRY_FILES` в `@cyborg-harness/core/plugin-check`, их равенство держит electron/test/plugins.test.ts). Угадывание по ним - плагины каталога пользователя и режим стенда (SAD 3.2). */
export const ENTRY_FILES: readonly string[] = ['index.mjs', 'index.js', 'index.ts'];
/** Точка входа плагина поставки: собранный `cyborg-plugin build` плагин всегда несёт `index.mjs`, и только его грузит поставка (SAD 3.2, «Точка входа»). */
const DELIVERY_ENTRY = 'index.mjs';

/** Флаг запуска, включающий каталог плагинов пользователя (политика этапа 1, SAD 6.1). */
export const USER_PLUGINS_FLAG = '--user-plugins';

function countDirs(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

export interface Discovered {
  readonly manifests: unknown[];
  /** id -> file URL точки входа (первая найденная по порядку `ENTRY_FILES`; файла нет - путь первого кандидата, причина в `problems`); при повторе id остаётся первый, второй манифест пропущен с записью в `problems`. */
  readonly entries: Map<string, string>;
  /** id -> каталог, где найден первым. */
  readonly origins: Map<string, string>;
  /** id -> каталог плагина, объявившего `ui` в манифесте; сами виды берутся из разобранного ядром манифеста. */
  readonly views: Map<string, string>;
  /** id -> каталог плагина: оттуда ядро берёт файлы схем разделов. */
  readonly homes: Map<string, string>;
  /** id -> причина, по которой точки входа нет: плагин ядру передан, а его активация откажет этой причиной. */
  readonly missing: Map<string, string>;
  readonly problems: string[];
}

export interface DiscoverOptions {
  /** Каталоги поставки: плагин оттуда грузится только по `index.mjs`, без угадывания по именам файлов. */
  readonly strictEntry?: readonly string[];
}

/** Каталоги по порядку приоритета: встроенные раньше пользовательских. */
export function discoverPlugins(dirs: readonly string[], options: DiscoverOptions = {}): Discovered {
  const found: Discovered = { manifests: [], entries: new Map(), origins: new Map(), views: new Map(), homes: new Map(), missing: new Map(), problems: [] };
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
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : undefined;
      // Второй манифест с тем же id ядру не отдаётся: граф отверг бы оба, и встроенный плагин пропал бы вместе с пользовательским.
      const first = id === undefined ? undefined : found.homes.get(id);
      if (id !== undefined && first !== undefined) {
        found.problems.push(`повтор id ${id} в ${home}: действует ${first}`);
        continue;
      }
      found.manifests.push(raw);
      const isFile = (f: string): boolean => fs.statSync(path.join(home, f), { throwIfNoEntry: false })?.isFile() === true;
      if (options.strictEntry?.includes(dir) === true) {
        // Поставка не угадывает: рядом мог оказаться чужой index.js, и встроенный плагин не должен зависеть от того, что положили в его каталог.
        if (id && isFile(DELIVERY_ENTRY)) found.entries.set(id, pathToFileURL(path.join(home, DELIVERY_ENTRY)).href);
        else if (id) {
          const other = ENTRY_FILES.find((f) => f !== DELIVERY_ENTRY && isFile(f));
          const why = `нет точки входа ${DELIVERY_ENTRY}${other === undefined ? '' : ` (найден ${other}: поставка грузит только ${DELIVERY_ENTRY}, соберите плагин командой cyborg-plugin build)`}`;
          found.missing.set(id, why);
          found.problems.push(`плагин ${id} (${home}): ${why}`);
        }
      } else {
        const present = ENTRY_FILES.filter(isFile);
        if (present.length > 1) found.problems.push(`${home}: точек входа несколько (${present.join(', ')}), загружается ${present[0] ?? ''}`);
        if (present.length === 0) found.problems.push(`${home}: нет точки входа (ищутся ${ENTRY_FILES.join(', ')})${id === undefined ? '' : `, плагин ${id} не запустится`}`);
        // Без файла ядро получает путь первого кандидата, а не id: отказ загрузки в журнале назовёт файл, которого нет.
        if (id) found.entries.set(id, pathToFileURL(path.join(home, present[0] ?? ENTRY_FILES[0] ?? '')).href);
      }
      if (id) {
        found.origins.set(id, dir);
        found.homes.set(id, home);
        if (isRecord(raw) && raw.ui !== undefined) found.views.set(id, home);
      }
    }
  }
  return found;
}

/** Ссылка из каталога плагина наружу отдала бы хосту плагина чужой JSON, например файл пользователя. */
export function readSchemaFile(home: string | undefined, file: string): unknown {
  if (home === undefined) throw new Error('каталог плагина не найден');
  const root = fs.realpathSync(home);
  const real = fs.realpathSync(path.join(home, file));
  if (!real.startsWith(root + path.sep)) throw new Error('файл вне каталога плагина');
  return JSON.parse(fs.readFileSync(real, 'utf8'));
}

/** Сверка каталога поставки с `delivery.json`: строки о расхождениях; этап 1 только сообщает, подпись и отказ - этап 2. */
async function checkDelivery(dir: string): Promise<string[]> {
  try {
    const list = await readDelivery(dir);
    if (list === undefined) return [`в каталоге поставки ${dir} нет delivery.json: контрольные суммы не проверены`];
    return (await verifyDelivery(dir, list)).map((p) => `контрольная сумма поставки: ${p}`);
  } catch (error) {
    return [`контрольные суммы поставки ${dir}: ${errorMessage(error)}`];
  }
}

export interface StartOptions {
  readonly userData: string;
  /** Файл воркспейса; по умолчанию `<userData>/workspace.cyborg.json`. */
  readonly workspace?: string;
  /** Перенос формата старого файла воркспейса при открытии; приложение, у которого такого формата не было, его не задаёт. */
  readonly migrate?: MigrateWorkspace;
  /** Последний фрагмент заголовка окна: имя приложения; по умолчанию «Cyborg». */
  readonly appName?: string;
  readonly builtinDir: string;
  /**
   * Что такое `builtinDir`. `delivery` (по умолчанию) - каталог поставки приложения: точка входа плагина только `index.mjs`, а `delivery.json`
   * рядом сверяется с файлами при старте (расхождение - в лог и `problems`, не отказ: этап 1). `stand` - режим разработки стенда: точка входа
   * угадывается по `index.mjs`, `index.js`, `index.ts`, сумм нет (стенд собирает плагины как исходники).
   */
  readonly builtinMode?: 'delivery' | 'stand';
  /**
   * Читать ли каталог плагинов пользователя (`<userData>/plugins`). Политика этапа 1 (SAD 6.1): по умолчанию нет.
   * Включает только человек за машиной, флагом запуска: файл воркспейса может лежать в репозитории и включить это от чужого имени.
   */
  readonly userPlugins?: boolean;
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
  readonly onLog?: (pluginId: string, message: string, level: LogLevel) => void;
  /** Запись трассы операций ядра (FR-CH-4001…4008); без обработчика (и без `diagnostics`) трасса выключена. */
  readonly onTrace?: (record: TraceRecord) => void;
  /**
   * Хранение диагностики (K-30): журнал, строки плагинов и трасса идут в кольцо и в файлы в `userData`, причина сбоя прошлого запуска видна в окне, выгрузка - из окна.
   * Создаёт приложение (`fileDiagnostics`) до запуска ядра; `unload` закрывает хранилище. С ним трасса включена, а ядро платит за неё по NFR-CH-4001.
   */
  readonly diagnostics?: Diagnostics;
  /** Версии для выгрузки диагностики: приложение и пакет ядра; не названные в выгрузке не показываются. */
  readonly versions?: { readonly app?: string; readonly core?: string };
  /** Главная часть плагина послала сообщение виду: окно отдаёт его фреймам этого плагина с этим именем вида. */
  readonly onViewMessage?: (pluginId: string, view: string, message: unknown) => void;
  /** Что не дошло до ядра; по умолчанию - в log. */
  readonly onProblem?: (problem: string) => void;
  readonly onDiscovered?: (found: Discovered) => void;
  readonly onWindow?: (snapshot: WindowSnapshot) => void;
  readonly onDocuments?: () => void;
  readonly onKeptPty?: () => void;
  /** Снимок меню ядра (`Kernel.menus`) поменялся: приложение пересобирает меню ОС. */
  readonly onMenus?: () => void;
  /** `plugins.enabled` из файла применён. */
  readonly onEnabled?: () => void;
  /** Безопасный режим: манифесты разобраны, хосты не запускаются, «Включить» отвечает `Unavailable`. */
  readonly safeMode?: boolean;
  /** Соседние окна того же `userData` (`workspaceNeighbors`): `Kernel.uninstall` не стирает общие данные из-под плагина, который может работать у соседа (#154). */
  readonly neighbors?: LoadOptions['neighbors'];
}

export async function startPlugins(options: StartOptions): Promise<Kernel & { readonly workspace: string }> {
  const report = (p: string) => {
    options.log(`[plugins] ${p}`);
    options.onProblem?.(p);
  };
  const file = options.workspace ?? path.join(options.userData, 'workspace.cyborg.json');
  const opened = await openWorkspace({ file, userFile: path.join(options.userData, 'cyborg.json'), stateDir: path.join(options.userData, 'state'), ...(options.migrate !== undefined && { migrate: options.migrate }) });
  if (!opened.ok) throw new Error(`воркспейс ${file} уже открыт ${opened.owner > 0 ? `процессом ${String(opened.owner)}` : 'другим процессом'}`);
  const ws = opened.workspace;
  for (const p of ws.problems) report(p);
  for (const m of ws.migrated) options.log(`[plugins] ${m}`);
  const userDir = path.join(options.userData, 'plugins');
  const delivery = options.builtinMode !== 'stand';
  const found = discoverPlugins(options.userPlugins === true ? [options.builtinDir, userDir] : [options.builtinDir], { strictEntry: delivery ? [options.builtinDir] : [] });
  if (options.userPlugins !== true) {
    const skipped = countDirs(userDir);
    if (skipped > 0) options.log(`[plugins] каталог плагинов пользователя ${userDir} не читается (плагинов в нём: ${String(skipped)}); сторонний код загружается только запуском с ${USER_PLUGINS_FLAG}`);
  }
  for (const p of found.problems) report(p);
  if (delivery && countDirs(options.builtinDir) > 0) for (const p of await checkDelivery(options.builtinDir)) report(p);
  options.onDiscovered?.(found);

  const kernel = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ws.plugins.enabled,
    manifests: found.manifests,
    hosts: ws.plugins.hosts,
    uiGroups: ws.plugins.uiGroups,
    keybindings: ws.plugins.keybindings,
    // Признак поставки - каталог установки, а не манифест: сторонний автор пишет в манифест что угодно.
    bundled: [...found.origins].filter(([, dir]) => dir === options.builtinDir).map(([id]) => id),
    // ADR-CH-0002 п. 6: cyborg.* - пространство поставки; чужой поставщик cyborg.agent сделал бы встроенного потребителя ambiguous.
    reservedPrefixes: ['cyborg.'],
    spawnHost: options.spawnHost,
    entry: (m) => {
      const entry = found.entries.get(m.id);
      // Выброшенное здесь ядро записывает в журнал как отказ активации этого плагина, с текстом причины.
      if (entry === undefined) throw new Error(found.missing.get(m.id) ?? 'нет точки входа');
      return entry;
    },
    config: ws.config,
    state: ws.state,
    schema: (m, file) => readSchemaFile(found.homes.get(m.id), file),
    onJournal: (entry) => {
      options.log(`[plugins] ${JSON.stringify(entry)}`);
      options.diagnostics?.sinks.onJournal(entry);
      options.onJournal?.(entry);
    },
    watchdog: options.watchdog,
    os: options.os,
    platform: options.platform,
    idleSeconds: options.idleSeconds,
    windowTitle: { workspace: path.basename(file), app: options.appName ?? 'Cyborg' },
    safeMode: options.safeMode,
    neighbors: options.neighbors,
    onWindow: (snapshot) => options.onWindow?.(snapshot),
    onDocuments: () => options.onDocuments?.(),
    onKeptPty: () => options.onKeptPty?.(),
    onMenus: () => options.onMenus?.(),
    onLog: (id, message, level) => {
      options.log(`[plugins] ${id}${level === 'info' ? '' : ` [${level}]`}: ${message}`);
      options.diagnostics?.sinks.onLog(id, message, level);
      options.onLog?.(id, message, level);
    },
    // Без обработчика ядро трассу не ведёт вовсе: хранилище и приложение получают записи через один приёмник.
    onTrace:
      options.diagnostics === undefined
        ? options.onTrace
        : (record) => {
            options.diagnostics?.sinks.onTrace(record);
            options.onTrace?.(record);
          },
    ...(options.diagnostics !== undefined && { onGraph: options.diagnostics.sinks.onGraph }),
    onViewMessage: (id, view, message) => options.onViewMessage?.(id, view, message),
  }).catch((error: unknown) => {
    ws.close();
    options.diagnostics?.close();
    throw error;
  });
  const watching = ws.watch(
    (ids) => void kernel.reloadSections('config', ids),
    report,
    (enabled) =>
      void kernel.setEnabled(enabled).then(
        ({ restart, failed }) => {
          if (restart.length > 0) report(`plugins.enabled: ${restart.join(', ')} - включатся после перезапуска`);
          for (const f of failed) report(`plugins.enabled: ${f}`);
          options.onEnabled?.();
        },
        (error: unknown) => report(`plugins.enabled: ${error instanceof Error ? error.message : String(error)}`),
      ),
  );
  return {
    ...kernel,
    // Спред вычисляет геттер один раз: без этого снимок слоя застыл бы на старте.
    get window() {
      return kernel.window;
    },
    get documents() {
      return kernel.documents;
    },
    get layout() {
      return kernel.layout;
    },
    get menus() {
      return kernel.menus;
    },
    workspace: ws.file,
    async unload() {
      watching.dispose();
      try {
        await kernel.unload();
      } finally {
        ws.close();
        // После выгрузки ядра: её записи (снятие плагинов, остановка хостов) тоже уходят в файл.
        options.diagnostics?.close();
      }
    },
  };
}

export interface PluginsEvents {
  /** Снимок поменялся: открытое окно перечитывает его. */
  changed(): void;
  /** Плагин выключился во время работы: видов у плагинов пока нет, поэтому одно уведомление ядра (SAD §3.5). */
  alert(title: string, body: string): void;
  /** Сообщение плагина: его вид получает строку сразу, без снимка. `group` - группа рендера плагина: кадры соседей по группе строки не получают. */
  log?(pluginId: string, line: FeedLine, group: string | undefined): void;
  /** Главная часть плагина послала сообщение виду `view` (`ctx.views.channel`): окно отдаёт его фреймам этого плагина с этим именем и никому больше (`group` - группа рендера плагина). */
  viewMessage?(pluginId: string, view: string, message: unknown, group: string | undefined): void;
  /** Заголовок окна от ядра: воркспейс, фрагменты плагинов, приложение. */
  title?(title: string): void;
  /** Команда окна (`WINDOW_COMMANDS`): исполняет окно, а не плагин. */
  windowCommand?(command: string): void;
}

export interface ServiceOptions extends Omit<StartOptions, 'onJournal' | 'onProblem' | 'onLog' | 'onViewMessage' | 'onDiscovered' | 'onWindow' | 'onDocuments' | 'onKeptPty' | 'onMenus'> {
  /** Процесс хоста для «Уронить» и «Повесить»; у хостов в том же процессе его нет. */
  readonly pidOf?: (hostId: string) => number | undefined;
}

const FEED_LIMIT = 300;

/** Ядро плагинов глазами окна playground: журнал, состояние плагинов, клавиши, лента сообщений и кнопки над ними. */
export class PluginsService implements ViewGroups {
  private kernel: Kernel | undefined;
  private phase: PluginsSnapshot['phase'] = 'starting';
  private workspace: WorkspaceInfo = { current: null, recent: [] };
  private error: string | undefined;
  private pidOf: ServiceOptions['pidOf'];
  private title: string | undefined;
  private safeMode = false;
  private userPlugins = false;
  private diagnostics: Diagnostics | undefined;
  private versions: StartOptions['versions'];
  /** id плагинов не из каталога поставки: происхождение определяет каталог установки, а не манифест. */
  private origins = new Map<string, PluginOrigin>();
  private readonly entries: { at: number; entry: JournalEntry }[] = [];
  private readonly problems: string[] = [];
  private readonly feed: FeedLine[] = [];
  private views = new Map<string, string>();
  private quitting: Promise<void> | undefined;
  private readonly watchers = new Set<() => void>();

  private readonly events: PluginsEvents;
  private readonly now: () => number;

  constructor(events: PluginsEvents, now: () => number = Date.now) {
    this.events = events;
    this.now = now;
  }

  /** Снимок поменялся: окно перечитывает его, а наблюдатели (меню приложения) пересобирают своё. */
  private changed(): void {
    this.events.changed();
    for (const watcher of [...this.watchers]) watcher();
  }

  /** Наблюдатель за изменением снимка, например `bindAppMenu`; возвращает снятие. */
  watch(watcher: () => void): () => void {
    this.watchers.add(watcher);
    return () => void this.watchers.delete(watcher);
  }

  /** Плагины, которые могут работать в этом окне (`Kernel.working`): их называет приложение соседним окнам (`workspaceInstance`); ядро не запущено - пусто. */
  working(): readonly string[] {
    return this.kernel?.working ?? [];
  }

  /** Меню окна по вкладам плагинов (`Kernel.menus`); ядро не запущено - пусто. */
  menus(): readonly MenuEntry[] {
    return this.kernel?.menus ?? [];
  }

  /** Нажатие пункта меню ОС: команду исполняет ядро от имени вкладчика; отказ идёт в ленту и журнал приложения, а не в меню. */
  async runMenuItem(pluginId: string, id: string): Promise<Reply> {
    return this.act(id, 'нет id пункта', async (kernel) => {
      try {
        return await kernel.runMenuItem(pluginId, id);
      } catch (error) {
        this.say({ kind: 'error', subject: `${pluginId}/${id}`, text: errorMessage(error) });
        throw error;
      }
    });
  }

  private showTitle(title: string): void {
    if (title === this.title) return;
    this.title = title;
    this.events.title?.(title);
  }

  setWorkspace(info: WorkspaceInfo): void {
    this.workspace = info;
    this.changed();
  }

  /** Окно без воркспейса: ядро не запускается, в окне - только выбор воркспейса. */
  withoutWorkspace(): void {
    this.phase = 'no-workspace';
    this.changed();
  }

  /** Живые pty плагинов: их завершит смена воркспейса, о них окно спрашивает человека. */
  get livePty(): number {
    const kernel = this.kernel;
    if (!kernel) return 0;
    return kernel.active.reduce((n, id) => n + kernel.disablePreview(id).ptys.filter((p) => p.pluginId === id).length, 0);
  }

  async start(options: ServiceOptions): Promise<void> {
    this.pidOf = options.pidOf;
    this.safeMode = options.safeMode === true;
    this.userPlugins = options.userPlugins === true;
    this.diagnostics = options.diagnostics;
    this.versions = options.versions;
    try {
      this.kernel = await startPlugins({
        ...options,
        onJournal: (entry) => this.record(entry),
        onProblem: (problem) => {
          this.problems.push(problem);
          this.changed();
        },
        onDiscovered: (found) => {
          this.views = found.views;
          this.origins = new Map([...found.origins].map(([id, dir]): [string, PluginOrigin] => [id, dir === options.builtinDir ? 'bundled' : 'user']));
        },
        onWindow: (snapshot) => {
          this.showTitle(snapshot.title);
          this.changed();
        },
        onDocuments: () => this.changed(),
        onKeptPty: () => this.changed(),
        onMenus: () => this.changed(),
        onLog: (pluginId, text) => {
          const line = this.say({ kind: 'log', subject: pluginId, text });
          this.events.log?.(pluginId, line, this.groupOf(pluginId));
        },
        onViewMessage: (pluginId, view, message) => this.events.viewMessage?.(pluginId, view, message, this.groupOf(pluginId)),
      });
      this.phase = 'ready';
      this.showTitle(this.kernel.window.title);
    } catch (error) {
      this.phase = 'failed';
      this.error = errorMessage(error);
      options.log(`[plugins] ядро не запустилось: ${(error as Error).stack ?? this.error}`);
    }
    this.changed();
  }

  private record(entry: JournalEntry): void {
    appendBounded(this.entries, { at: this.now(), entry }, (e) => e.entry);
    // Под замком с hideNotifications уведомление ядра тоже уходит без текста: его видно на заблокированном экране ОС.
    const alert = (title: string, body: string) => (this.kernel?.window.locks.some((l) => l.hideNotifications) ? this.events.alert('Cyborg', 'новое событие') : this.events.alert(title, body));
    if (this.phase === 'ready' && entry.kind === 'switched-off') alert(`Плагин ${entry.pluginId} выключен`, describeEntry(entry));
    if (this.phase === 'ready' && entry.kind === 'host-abandoned') alert(`Плагины выключены: ${entry.plugins.join(', ')}`, describeEntry(entry));
    this.changed();
  }

  private say(line: Omit<FeedLine, 'at'>): FeedLine {
    const stamped = { at: this.now(), ...line };
    this.feed.push(stamped);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
    this.changed();
    return stamped;
  }

  /** Группа рендера плагина с видами (`Kernel.groupOf`): хост адреса его видов, по ней мост проверяет, что плагин кадра состоит в группе кадра. */
  groupOf(pluginId: string): string | undefined {
    return this.kernel?.groupOf(pluginId);
  }

  /** Виды плагина: по ним протокол cyborg-plugin отдаёт оболочку и файлы. Ленивый плагин не будит: см. `wake`. */
  uiOf(pluginId: string): PluginUi | undefined {
    const dir = this.views.get(pluginId);
    const ui = this.kernel?.manifests.find((m) => m.id === pluginId)?.ui;
    const group = this.groupOf(pluginId);
    if (dir === undefined || ui === undefined || group === undefined) return undefined;
    return { dir, group, views: ui.views, ...(ui.overlay !== undefined && { overlay: ui.overlay }), ...(ui.inlineStyles === true && { inlineStyles: true as const }) };
  }

  /** Показ вида - вызов ленивого плагина: мосту вида нужна его главная часть. Зовут после сверки группы адреса (`resolveViewRequest`). */
  wake(pluginId: string): void {
    void this.kernel?.wake(pluginId).catch(() => undefined);
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
  runFor(pluginId: string, command: unknown, args: unknown = []): Promise<Reply> {
    if (typeof command !== 'string') return Promise.resolve({ error: 'нет имени команды' });
    if (!Array.isArray(args)) return Promise.resolve({ error: `${command}: аргументы - не массив` });
    const own = this.kernel?.manifests.find((m) => m.id === pluginId)?.commands ?? {};
    if (!Object.hasOwn(own, command)) return Promise.resolve({ error: `${command}: не команда плагина ${pluginId}` });
    return this.run(command, args, pluginId);
  }

  /** Терминал вида по билету `share()` его главной части; плагин - из origin фрейма. */
  openTerminal(pluginId: string, ticket: string, channel: TerminalChannel): Promise<TerminalView> {
    if (!this.kernel) return Promise.reject(new Error('ядро плагинов не запущено'));
    return this.kernel.openTerminal(pluginId, ticket, channel);
  }

  /** Память вида: плагин - из origin фрейма, имя вида - из слов вида, но чужого плагина вид так не достанет. */
  viewStateFor(pluginId: string, view: unknown): Reply {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      const value = this.kernel.viewState(pluginId, view as string);
      return value === undefined ? {} : { value };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  async setViewStateFor(pluginId: string, view: unknown, value: unknown): Promise<Reply> {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      await this.kernel.setViewState(pluginId, view as string, value);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Диалог вида в слое окна; плагин - из origin фрейма. */
  async dialogFor(pluginId: string, view: unknown, spec: unknown): Promise<Reply> {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      const value = await this.kernel.showDialog(pluginId, view as string, spec);
      return value === undefined ? {} : { value };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Сообщение вида своей главной части; плагин - из origin фрейма, имя вида - из слов вида (чужой плагин так недостижим). */
  async viewPostFrom(pluginId: string, view: unknown, message: unknown): Promise<Reply> {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    if (typeof view !== 'string') return { error: 'канал вида: ожидается имя вида' };
    try {
      await this.kernel.viewPost(pluginId, view, message);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Данные модального окна, показанного виду; не в окне - `{}` без значения. Плагин - из origin фрейма, имя вида - из слов вида. */
  modalFor(pluginId: string, view: unknown): Reply {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    if (typeof view !== 'string') return { error: 'модальное окно: ожидается имя вида' };
    const modal = this.kernel.modalFor(pluginId, view);
    return modal ? { value: modal } : {};
  }

  /** Вид закрывает своё модальное окно и отдаёт результат владельцу. */
  closeModalFor(pluginId: string, view: unknown, result: unknown): Reply {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    if (typeof view !== 'string') return { error: 'модальное окно: ожидается имя вида' };
    try {
      this.kernel.closeModal(pluginId, view, result);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Вид просит окно подогнать высоту области вида под содержимое; высоту и принадлежность окна проверяет ядро, отказ доходит виду текстом. */
  resizeModalFor(pluginId: string, view: unknown, size: unknown): Reply {
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    if (typeof view !== 'string') return { error: 'модальное окно: ожидается имя вида' };
    try {
      this.kernel.resizeModal(pluginId, view, size);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Человек закрыл модальное окно в самом окне (крестик, клик мимо): владелец получает undefined. */
  cancelModal(arg: unknown): Reply {
    if (!isRecord(arg) || typeof arg.id !== 'number') return { error: 'закрытие окна: { id }' };
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      this.kernel.cancelModal(arg.id);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Escape из `before-input-event`: `true` - нажатие принадлежит модальному окну, странице его отдавать не надо. */
  dismissModal(): boolean {
    return this.kernel?.dismissModal() ?? false;
  }

  keysFor(pluginId: string): Readonly<Record<string, string>> {
    return this.kernel?.keysOf(pluginId) ?? {};
  }

  /** Человек закрыл вкладку документа в окне. */
  closeDocument(id: unknown): Promise<Reply> {
    return this.act(id, 'нет id документа', (kernel, docId) => kernel.closeDocument(docId));
  }

  /** Ответ человека из окна. */
  answerDialog(arg: unknown): Reply {
    if (!isRecord(arg) || typeof arg.id !== 'number' || (arg.choice !== undefined && typeof arg.choice !== 'string')) return { error: 'ответ диалога: { id, choice? }' };
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      this.kernel.answerDialog(arg.id, arg.choice);
      return {};
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Окно не пустило вид на чужой адрес. */
  viewDenied(pluginId: string, url: string): void {
    this.kernel?.viewDenied(pluginId, url);
  }

  /** CSP отклонила запрос или стиль на странице вида: запись в журнал плагина (#160); плагин - из адреса фрейма, аргументы от вида - не строки игнорируются. */
  cspDeniedFrom(pluginId: string, directive: unknown, blocked: unknown): void {
    if (typeof directive !== 'string' || typeof blocked !== 'string') return;
    this.kernel?.viewCspDenied(pluginId, violationDetail({ violatedDirective: directive, blockedURI: blocked }));
  }

  /** Есть ли у плагина вида поставщик контракта; права те же, что у главной части: только requires и optional манифеста. */
  contractFor(pluginId: string, contract: unknown, major: unknown): Reply {
    if (typeof contract !== 'string' || typeof major !== 'number') return { error: 'контракт: ожидаются имя и мажорная версия' };
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      return { value: this.kernel.contracts.get(pluginId, contract, major) !== undefined };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  /** Метод контракта из вида: вызов идёт от имени плагина вида, аргументы и ответ - данные. */
  async callFor(pluginId: string, contract: unknown, major: unknown, method: unknown, args: unknown): Promise<Reply> {
    if (typeof contract !== 'string' || typeof major !== 'number' || typeof method !== 'string' || !Array.isArray(args)) return { error: 'вызов контракта: ожидаются имя, мажорная версия, метод и аргументы' };
    if (!this.kernel) return { error: 'ядро плагинов не запущено' };
    try {
      const value = await this.kernel.callAs(pluginId, contract, major, method, args);
      return value === undefined ? {} : { value };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  snapshot(): PluginsSnapshot {
    const kernel = this.kernel;
    const manifests = new Map(kernel?.manifests.map((m) => [m.id, m]));
    const kept = kernel?.keptPty() ?? [];
    const plugins: PluginRow[] = pluginStatuses(this.entries.map((e) => e.entry)).map((s) => {
      const manifest = manifests.get(s.id);
      const host = s.state === 'disabled' ? undefined : kernel?.hostOf(s.id);
      const pid = host !== undefined && s.state === 'active' ? this.pidOf?.(host) : undefined;
      const commands = Object.entries(manifest?.commands ?? {})
        .filter(([, spec]) => spec.args.every((a) => a.optional))
        .map(([name]) => name);
      const origin = this.origins.get(s.id);
      const previous = this.diagnostics?.previousFailures().get(s.id);
      const group = this.views.has(s.id) ? kernel?.groupOf(s.id) : undefined;
      const isolated = this.entries.findLast(({ entry }) => entry.kind === 'group-isolated' && entry.pluginId === s.id)?.entry;
      return {
        id: s.id,
        ...(origin !== undefined && { origin }),
        state: s.state,
        // В безопасном режиме кнопка остаётся: её отказ объясняет, почему плагин не работает.
        revivable: (s.revivable || s.cause?.kind === 'safe-mode') && kernel !== undefined,
        unloaded: s.cause?.kind === 'unloaded' && s.cause.by === s.id,
        commands,
        permissions: manifest ? [...describePermissions(manifest.permissions), ...describeOpenCommands(manifest.commands)] : [],
        ...(manifest && { version: manifest.version }),
        ...(manifest?.ui?.overlay !== undefined && this.views.has(s.id) && group !== undefined && { overlay: viewUrl(group, s.id, 'overlay') }),
        ...(group !== undefined && { group }),
        ...(isolated && { groupWarning: describeEntry(isolated) }),
        ...(host !== undefined && { host }),
        ...(pid !== undefined && { pid }),
        ...(s.cause && s.state !== 'active' && { reason: describeEntry(s.cause) }),
        ...(previous !== undefined && { previousFailure: { at: previous.at, text: previous.text } }),
        ...(kept.some((p) => p.pluginId === s.id) && {
          kept: kept
            .filter((p) => p.pluginId === s.id)
            .map((p) => ({ id: p.id, pid: p.pid, command: [p.program, ...p.args].join(' '), keptAt: p.keptAt, ...(p.exit && { exitCode: p.exit.code }) })),
        }),
      };
    });
    // Адрес вида решает метка раскладки ядра: у не включённого в настройках плагина вида нет, у снятого окно рисует заглушку на том же месте.
    const layout: LayoutRow[] = (kernel?.layout ?? []).map((e) => {
      const group = e.kind === 'view' && e.mark !== 'not-enabled' && this.views.has(e.pluginId) ? kernel?.groupOf(e.pluginId) : undefined;
      return { ...e, ...(group !== undefined && { url: viewUrl(group, e.pluginId, e.name) }) };
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
      safeMode: this.safeMode,
      userPlugins: this.userPlugins,
      ...(this.error !== undefined && { error: this.error }),
      problems: [...this.problems],
      plugins,
      layout,
      keys,
      feed: [...this.feed],
      journal,
      ...(this.diagnostics !== undefined && { diagnostics: this.diagnosticsStatus(this.diagnostics) }),
      canHang: process.platform !== 'win32' && this.pidOf !== undefined,
      window: kernel?.window ?? { title: '', queued: 0, locks: [] },
      documents: kernel?.documents ?? [],
      workspace: this.workspace,
    };
  }

  private diagnosticsStatus(diagnostics: Diagnostics): DiagnosticsStatus {
    const info = diagnostics.stored();
    return {
      files: info.files,
      bytes: info.bytes,
      ...(info.since !== undefined && { since: info.since }),
      ...(info.previousRunAt !== undefined && { previousRunAt: info.previousRunAt }),
      ...(info.problem !== undefined && { problem: info.problem }),
    };
  }

  /**
   * Выгрузка диагностики одним текстовым файлом (FR-CH-4015): путь называет окно (человек выбрал его в диалоге), файл остаётся там, где его положили, ядро его никуда не отправляет
   * (FR-CH-4016). Ядро не запустилось - выгрузка всё равно есть: записей запуска и прошлых запусков хватает, чтобы сказать, почему.
   */
  async exportDiagnostics(file: unknown): Promise<Reply> {
    if (typeof file !== 'string' || file === '') return { error: 'выгрузка: нужен путь файла' };
    if (!this.diagnostics) return { error: 'хранение диагностики не включено' };
    try {
      const text = this.diagnostics.export({
        ...(this.versions?.app !== undefined && { app: this.versions.app }),
        ...(this.versions?.core !== undefined && { core: this.versions.core }),
        ...(this.kernel !== undefined && { kernel: this.kernel }),
      });
      await fs.promises.writeFile(file, text, { mode: 0o600 });
      const done: DiagnosticsExport = { file, bytes: Buffer.byteLength(text) };
      return { value: done };
    } catch (error) {
      return { error: `выгрузка не записана: ${errorMessage(error)}` };
    }
  }

  /** Где сейчас фокус ввода, по сообщениям страниц: `before-input-event` DOM не видит, а решать надо синхронно. */
  #focus: NonNullable<KeyPress['focus']> = 'other';

  setInputFocus(kind: unknown): void {
    if (kind === 'text' || kind === 'terminal' || kind === 'other') this.#focus = kind;
  }

  /** Окно сообщает, виден ли вид плагина (`when.visible` у динамических сочетаний: плагин виден, пока виден хоть один вид); плагина или вида нет или ядро не запущено - молча. */
  setViewVisible(pluginId: string, visible: boolean, view?: string): void {
    try {
      this.kernel?.setViewVisible(pluginId, visible, view);
    } catch {
      // Вид, которого ядро не знает, сочетаниям не нужен.
    }
  }

  /** Синхронно, иначе `preventDefault` в `before-input-event` опоздает: сочетание активного плагина страница не получает. */
  press(input: KeyInput, repeat = false): boolean {
    const key = keyOfInput(input);
    const kernel = this.kernel;
    const binding = key === undefined ? undefined : kernel?.keybinding(key, { repeat, focus: this.#focus });
    // Акселератор меню обрабатывает меню ОС, ядру его не отнять.
    if (!binding || binding.pluginId === MENU_OWNER) return false;
    this.say({ kind: 'key', subject: binding.key, text: `→ ${binding.command} (${binding.pluginId})` });
    if (binding.pluginId === WINDOW_OWNER) this.events.windowCommand?.(binding.command);
    else void this.run(binding.command, binding.args);
    return true;
  }

  /** `onBehalfOf` - плагин, от имени которого зовёт его вид: ядро исполняет только его команду, даже если то же имя объявил другой плагин. */
  run(command: unknown, args: readonly unknown[] = [], onBehalfOf?: string): Promise<Reply> {
    return this.act(command, 'нет имени команды', async (kernel, name) => {
      try {
        return await (onBehalfOf === undefined ? kernel.run(name, ...args) : kernel.runOwn(onBehalfOf, name, ...args));
      } catch (error) {
        this.say({ kind: 'error', subject: name, text: errorMessage(error) });
        throw error;
      }
    });
  }

  /** Вместе с плагином уходят те, кто требует его через requires. */
  /** `keepPty` - ответ человека на вопрос о процессах плагина: оставить их ждать его возвращения. */
  disable(id: unknown, keepPty: unknown = false): Promise<Reply> {
    return this.act(id, 'нет id плагина', (kernel, pluginId) => kernel.disable(pluginId, { keepPty: keepPty === true }));
  }

  /** Что заберёт выключение: окно спрашивает человека, только если есть живые pty. */
  disablePreview(id: unknown): Promise<Reply> {
    return this.act(id, 'нет id плагина', async (kernel, pluginId) => kernel.disablePreview(pluginId));
  }

  /** Человек завершил оставленный процесс выключенного плагина или убрал завершившийся. */
  endKeptPty(id: unknown): Promise<Reply> {
    return this.act(id, 'нет id процесса', async (kernel, ptyId) => kernel.endKeptPty(ptyId));
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
      const result = await action(this.kernel, value);
      return result === undefined ? {} : { value: result };
    } catch (error) {
      return { error: errorMessage(error) };
    } finally {
      this.changed();
    }
  }

  async unload(): Promise<void> {
    await this.kernel?.unload();
  }
}
