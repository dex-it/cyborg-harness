import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SectionStore, type Layer, type LayerStore } from './config.ts';
import { toDisposable, type Disposable } from './disposable.ts';
import { isRecord } from './manifest.ts';
import type { UserKeybinding } from './loader.ts';

/** Формат главного конфига; старый `{projects, lastProjectId}` формата не имеет. */
export const CONFIG_FORMAT = 2;

/** Запись через временный файл и rename: оборванная запись не оставляет полупустой файл. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // pid в имени: два экземпляра приложения не делят временный файл.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Нет файла - undefined; битый файл - ошибка: его нельзя молча считать пустым и перезаписать. */
export function readJson(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) throw new Error(`${file}: корень не объект`);
  return doc;
}

/** Ключ state: один и тот же воркспейс, открытый по разным путям (симлинк, относительный путь), - одно состояние. */
export function workspaceKey(file: string): string {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    real = path.resolve(file);
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

export type LockResult = { readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly owner: number };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Замок `<файл>.lock` с pid владельца; замок умершего процесса забирается. */
export function lockWorkspace(file: string, pid = process.pid): LockResult {
  const lock = `${file}.lock`;
  // Замок появляется сразу с pid: файл, созданный пустым и дописанный потом, сосед успел бы счесть протухшим и снять.
  const draft = `${lock}.${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(draft, JSON.stringify({ pid }));
  try {
    return takeLock(lock, draft, pid);
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

function takeLock(lock: string, draft: string, pid: number): LockResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.linkSync(draft, lock);
      let held = true;
      return {
        ok: true,
        release: () => {
          if (!held) return;
          held = false;
          try {
            if (readJson(lock)?.pid === pid) fs.unlinkSync(lock);
          } catch {
            // Замок уже снят или перезаписан: снимать больше нечего.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner: unknown;
    try {
      owner = readJson(lock)?.pid;
    } catch {
      owner = undefined;
    }
    if (typeof owner === 'number' && owner !== pid && alive(owner)) return { ok: false, owner };
    fs.rmSync(lock, { force: true });
  }
  throw new Error(`${lock}: замок не взят`);
}

export interface Migrated {
  readonly config: Record<string, unknown>;
  /** Разделы state по id плагина. */
  readonly state: Record<string, Record<string, unknown>>;
}

/** Единственное место, где ядро знает чужие поля (SAD §3.10); удаляется через пару версий. */
export function migrateLegacy(doc: Record<string, unknown>): Migrated | undefined {
  if ('cyborg' in doc || !Array.isArray(doc.projects)) return undefined;
  const items: Record<string, unknown>[] = [];
  const byProject: Record<string, unknown> = {};
  for (const p of doc.projects) {
    if (!isRecord(p) || typeof p.id !== 'string') continue;
    const repos = Array.isArray(p.repos) ? p.repos.filter((r): r is string => typeof r === 'string') : typeof p.path === 'string' ? [p.path] : [];
    items.push({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id, description: typeof p.description === 'string' ? p.description : '', repos });
    const trackers = { ...(isRecord(p.trackers) ? p.trackers : {}), ...(p.jira !== undefined && { jira: p.jira }) };
    if (Object.keys(trackers).length > 0) byProject[p.id] = trackers;
  }
  const { lastProjectId } = doc;
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'projects' && k !== 'lastProjectId'));
  const settings = { ...(isRecord(rest.settings) ? rest.settings : {}), projects: { items }, ...(Object.keys(byProject).length > 0 && { trackers: { byProject } }) };
  return {
    config: { ...rest, cyborg: CONFIG_FORMAT, settings },
    state: typeof lastProjectId === 'string' ? { projects: { lastProjectId } } : {},
  };
}

/** Слой config поверх `settings` файла; остальные поля файла (`plugins`, `cyborg`) не трогаются. */
export function settingsLayer(file: string): { load(): Record<string, unknown> | undefined; save(settings: Record<string, unknown>): void } {
  return {
    load: () => {
      const settings = readJson(file)?.settings;
      return isRecord(settings) ? settings : undefined;
    },
    save: (settings) => writeJsonAtomic(file, { ...readJson(file), settings }),
  };
}

export interface PluginsList {
  readonly enabled: readonly string[];
  readonly hosts: Readonly<Record<string, readonly string[]>>;
  /** Сначала пользователя, затем воркспейса: у одного сочетания последнее слово за воркспейсом. */
  readonly keybindings: readonly UserKeybinding[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function pluginsOf(doc: Record<string, unknown> | undefined): { enabled?: string[]; hosts?: Record<string, string[]>; keybindings: UserKeybinding[] } {
  const plugins = isRecord(doc?.plugins) ? doc.plugins : {};
  const keys = Array.isArray(plugins.keybindings) ? plugins.keybindings : [];
  return {
    keybindings: keys.filter((k): k is UserKeybinding => isRecord(k) && typeof k.key === 'string' && (typeof k.command === 'string' || k.command === null)),
    ...(Array.isArray(plugins.enabled) && { enabled: strings(plugins.enabled) }),
    ...(isRecord(plugins.hosts) && { hosts: Object.fromEntries(Object.entries(plugins.hosts).map(([h, ids]) => [h, strings(ids)])) }),
  };
}

export interface WorkspaceOptions {
  /** Файл воркспейса. */
  readonly file: string;
  /** Файл пользователя: перекрывается файлом воркспейса. */
  readonly userFile: string;
  /** Каталог приложения: state лежит в `<stateDir>/<ключ>.json`. */
  readonly stateDir: string;
  readonly pid?: number;
}

export interface Workspace {
  readonly file: string;
  readonly key: string;
  readonly stateFile: string;
  /** `plugins` пользователя, перекрытые воркспейсом по полям. */
  readonly plugins: PluginsList;
  readonly config: SectionStore;
  readonly state: SectionStore;
  /** Что сделал перенос старого формата; пусто, если переносить было нечего. */
  readonly migrated: readonly string[];
  /** Файлы, которые не разобрались: их разделы пусты, а запись в них отменяется, чтобы не затереть правку человека. */
  readonly problems: readonly string[];
  /** Правка файла воркспейса или пользователя извне: id разделов config, которые поменялись; `onEnabled` - новый итоговый `plugins.enabled`. */
  watch(listener: (changed: readonly string[]) => void, onProblem?: (message: string) => void, onEnabled?: (enabled: readonly string[]) => void): Disposable;
  close(): void;
}

export type OpenResult = { readonly ok: true; readonly workspace: Workspace } | { readonly ok: false; readonly owner: number };

/** Воркспейс до загрузки любого плагина (SAD §3.1): замок, перенос старого формата, слои config и state. */
export async function openWorkspace(options: WorkspaceOptions): Promise<OpenResult> {
  const file = path.resolve(options.file);
  const lock = lockWorkspace(file, options.pid);
  if (!lock.ok) return lock;
  try {
    const key = workspaceKey(file);
    const stateFile = path.join(options.stateDir, `${key}.json`);
    const migrated: string[] = [];
    const problems: string[] = [];
    const tolerant = (f: string): Record<string, unknown> | undefined => {
      try {
        return readJson(f);
      } catch (error) {
        problems.push(`${f}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };
    const broken = (f: string) => {
      try {
        readJson(f);
        return false;
      } catch {
        return true;
      }
    };
    const doc = tolerant(file);
    const legacy = doc && migrateLegacy(doc);
    if (legacy) {
      writeJsonAtomic(`${file}.v1.bak`, doc);
      writeJsonAtomic(file, legacy.config);
      migrated.push(`${file}: старый формат переведён в cyborg ${CONFIG_FORMAT}, копия - ${path.basename(file)}.v1.bak`);
      if (Object.keys(legacy.state).length > 0) {
        writeJsonAtomic(stateFile, { ...readJson(stateFile), ...legacy.state });
        migrated.push(`state: ${Object.keys(legacy.state).join(', ')}`);
      }
    } else if (!doc && !broken(file)) {
      writeJsonAtomic(file, { cyborg: CONFIG_FORMAT, plugins: {}, settings: {} });
    }

    const layers: Record<Layer, ReturnType<typeof settingsLayer>> = { user: settingsLayer(options.userFile), workspace: settingsLayer(file) };
    const written = new Map<string, string>();
    const remember = (f: string) => {
      try {
        written.set(f, fs.readFileSync(f, 'utf8'));
      } catch {
        written.delete(f);
      }
    };
    let opening = true;
    const configStore: LayerStore = {
      load: async (layer) => {
        try {
          return layers[layer]?.load();
        } catch (error) {
          // При открытии причину уже записал tolerant; при слежении ошибка оставляет разделы прежними.
          if (opening) return undefined;
          throw error;
        }
      },
      save: async (layer, settings) => {
        const target = layers[layer];
        if (!target) throw new Error(`слоя ${layer} нет`);
        const f = layer === 'user' ? options.userFile : file;
        let before: string | undefined;
        try {
          before = fs.readFileSync(f, 'utf8');
        } catch {
          before = undefined;
        }
        target.save(settings);
        // Неподхваченная правка извне вошла в запись: файл не помечается своим, и слежение сообщит о ней разделам.
        if (before === written.get(f)) remember(f);
      },
    };
    const stateStore: LayerStore = {
      load: async () => (opening ? tolerant(stateFile) : readJson(stateFile)),
      save: async (_layer, document) => {
        // Битый файл - правка человека: запись его не затирает.
        if (broken(stateFile)) throw new Error(`${stateFile}: не разобран, запись отменена`);
        writeJsonAtomic(stateFile, document);
      },
    };
    const config = await SectionStore.open(configStore, ['user', 'workspace']);
    const state = await SectionStore.open(stateStore, ['workspace']);
    opening = false;
    const user = pluginsOf(tolerant(options.userFile));
    const own = pluginsOf(legacy ? legacy.config : doc);
    const plugins = { enabled: own.enabled ?? user.enabled ?? [], hosts: { ...user.hosts, ...own.hosts }, keybindings: [...user.keybindings, ...own.keybindings] };
    let enabledNow = plugins.enabled;
    remember(file);
    remember(options.userFile);

    const watchers = new Set<fs.FSWatcher>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let closed = false;
    return {
      ok: true,
      workspace: {
        file,
        key,
        stateFile,
        plugins,
        config,
        state,
        migrated,
        problems,
        watch(listener, onProblem, onEnabled) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const check = () => {
            timer = undefined;
            if (closed) return;
            let changed = false;
            for (const f of [file, options.userFile]) {
              let text: string | undefined;
              try {
                text = fs.readFileSync(f, 'utf8');
              } catch {
                text = undefined;
              }
              // Своя запись тоже будит слежение: сравнение с последним записанным её отсеивает.
              if (text !== written.get(f)) changed = true;
              if (text === undefined) written.delete(f);
              else written.set(f, text);
            }
            if (!changed) return;
            const bad = [file, options.userFile].find(broken);
            if (bad) {
              onProblem?.(`${bad}: не разобран, разделы прежние`);
              return;
            }
            const next = pluginsOf(readJson(file)).enabled ?? pluginsOf(readJson(options.userFile)).enabled ?? [];
            if (JSON.stringify(next) !== JSON.stringify(enabledNow)) {
              enabledNow = next;
              onEnabled?.(next);
            }
            // Файл на середине правки не разбирается: разделы остаются прежними до следующей записи.
            config.reload().then(
              (ids) => {
                if (ids.length > 0) listener(ids);
              },
              (error: unknown) => onProblem?.(error instanceof Error ? error.message : String(error)),
            );
          };
          // Каталог, а не файл: атомарная запись редактора заменяет inode, и слежение за файлом теряется.
          // Каталога пользователя может ещё не быть: следим за тем, что есть.
          for (const dir of new Set([path.dirname(file), path.dirname(options.userFile)].filter((d) => fs.existsSync(d)))) {
            const names = new Set([file, options.userFile].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f)));
            const w = fs.watch(dir, (_event, name) => {
              if (name !== null && !names.has(name)) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(check, 50);
              timers.add(timer);
            });
            watchers.add(w);
          }
          return toDisposable(() => {
            for (const w of watchers) w.close();
            watchers.clear();
            if (timer) clearTimeout(timer);
          });
        },
        close() {
          if (closed) return;
          closed = true;
          for (const w of watchers) w.close();
          for (const t of timers) clearTimeout(t);
          lock.release();
        },
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}
