import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants, watch as watchFs, type Dirent, type Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirEntry, FileSlice, FileStat, HttpResponse, OpenDialogOptions, ProcessResult, PtyInfo, SecretValue } from '@cyborg-harness/contracts';
import { CoreError } from './errors.ts';
import type { PluginManifest } from './manifest.ts';
import { ANY_PATH, LOGIN_SHELL } from './permissions.ts';
import { killGroup, PTY_SIGNALS, PtyTable, type PtyBackend, type TerminalSink, type TerminalView } from './pty.ts';
import { HttpServes, type AskHost } from './serve.ts';
import type { GuardRight } from './via-contract.ts';
import { isRecord } from './wire.ts';

/** Хранилище секретов ядра: ключи `<pluginId>/<key>`; без шифрования ОС `available()` - false, и ядро отказывает, а не пишет открытым текстом. */
export interface SecretStore {
  available(): boolean | Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Среда шлюза: каталоги и то, что даёт только приложение (Electron). Нет адаптера - вызов получает `Unavailable`. */
export interface OsEnvironment {
  /** Каталог данных плагинов: `<dataDir>/<pluginId>` - область `plugin-data`. */
  readonly dataDir: string;
  readonly tempDir: string;
  /** Домашний каталог: `~` в правах и `paths.home`; по умолчанию - домашний каталог ОС. */
  readonly home?: string;
  /** Закрыты всегда: файл воркспейса, его замок, файл пользователя. */
  readonly protectedPaths?: readonly string[];
  /** Каталог данных приложения: закрыт целиком, кроме своих каталогов плагина и корней проектов от приложения. */
  readonly appDir?: string;
  /** Корни проектов от приложения; к ним добавляются корни плагинов с правом `security.roots`. */
  readonly roots?: () => readonly string[];
  readonly secrets?: SecretStore;
  readonly notify?: (title: string, body: string | undefined) => void | Promise<void>;
  readonly clipboard?: { readText(): string | Promise<string>; writeText(text: string): void | Promise<void> };
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly watch?: typeof watchFs;
  /** Псевдотерминал; нет - `ctx.os.pty` отвечает `Unavailable`. */
  readonly pty?: PtyBackend;
  /** Хвост вывода pty, символов; по умолчанию 256 К. */
  readonly ptyBacklog?: number;
  /** Открыть программой ОС; путь и URL шлюз уже проверил. */
  readonly shell?: { openPath(path: string): Promise<void>; openExternal(url: string): Promise<void> };
  /** Системный выбор файла; ответ - выбранные пути, отмена - пустой список. */
  readonly dialog?: { open(options: OpenDialogOptions): Promise<readonly string[]> };
}

/** Где живёт область `granted`: state воркспейса, чтобы выбор человека пережил перезапуск. */
export interface GrantStore {
  /** `{ <pluginId>: [путь, ...] }` из прошлых запусков; чужая форма - как пустая. */
  read(): unknown;
  write(byPlugin: Readonly<Record<string, readonly string[]>>): Promise<void>;
}

/** Область пути: каталог после realpath и хвост маски; `git` - запись в `.git` разрешена (`workspace.git`). */
interface Area {
  readonly root: string;
  readonly segs: readonly string[];
  readonly git: boolean;
  /** Область `any`: файл в ней мог положить кто угодно, не только человек. */
  readonly any?: boolean;
}

// Открыть такой файл - запустить его: это право `process`, а не `shell`.
// PATHEXT и список высокого риска Windows, пакеты и ярлыки macOS, установщики и скрипты Linux: всё, что система откроет запуском.
const EXECUTABLE =
  /\.(exe|bat|cmd|com|pif|scr|ps1|ps1xml|psc1|psm1|msi|msp|mst|msc|msix|appx|appinstaller|application|appref-ms|gadget|lnk|url|scf|settingcontent-ms|library-ms|reg|inf|ins|isp|chm|hta|cpl|xll|xbap|diagcab|vsix|vb|vbs|vbe|js|jse|mjs|cjs|ws|wsf|wsh|jar|py|pyw|pl|rb|iso|img|vhd|vhdx|app|bundle|prefpane|workflow|action|scpt|applescript|terminal|fileloc|inetloc|webloc|command|tool|sh|bash|zsh|csh|ksh|fish|desktop|appimage|run|bin|deb|rpm|snap|flatpakref|pkg|mpkg|dmg)$/i;

// Файл в области своей записи плагин мог создать сам, а запретительный список не бывает полным: там открывается только документ.
// HTML и SVG не здесь: браузер выполнит их скрипт и сходит в сеть в обход права `net`.
const DOCUMENT =
  /\.(txt|text|md|markdown|log|csv|tsv|json|pdf|rtf|odt|ods|odp|docx|xlsx|pptx|epub|png|jpe?g|gif|webp|bmp|tiff?|avif|heic|mp3|wav|ogg|oga|flac|m4a|opus|mp4|m4v|webm|mkv|mov|ogv)$/i;

export interface Denial {
  readonly pluginId: string;
  readonly method: string;
  /** Что именно не пропущено; значения секретов и тела запросов сюда не попадают. */
  readonly detail: string;
  /** Право проверено у вызывающего чужого контракта, а не у того, кто выполняет. */
  readonly reason?: 'via-contract';
}

const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_BODY = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SLICE = 1024 * 1024;
const MAX_WATCHES = 64;
const WATCH_COALESCE_MS = 50;

type PushMethod = 'pty.data' | 'pty.exit' | 'fs.change';

// Конец куска внутри многобайтного символа: кусок обрезается до его начала, символ придёт следующим куском.
function utf8End(buf: Buffer, n: number): number {
  for (let i = n - 1; i >= Math.max(0, n - 4); i--) {
    const b = buf[i] ?? 0;
    if ((b & 0xc0) === 0x80) continue;
    const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + len > n ? i : n;
  }
  return n;
}

const int = (method: string, v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new CoreError('Invalid', `${method}: ${name} - целое от ${String(min)} до ${String(max)}`);
  return v;
};

/** Окружение запущенной программы: то, без чего она не найдёт себя и пользователя; остальное - по правилу. */
const BASE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z]+|SystemRoot|SYSTEMROOT|ComSpec|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|WINDIR)$/;

const inside = (dir: string, target: string) => target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

async function real(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Ближайший существующий предок после realpath плюс несуществующий хвост: так проверяется путь, которого ещё нет. */
async function realOrParent(p: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Удаление каталога с репозиторием внутри уносит историю: запрет записи в .git должен держать и его. */
async function containsGit(dir: string): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name === '.git') return true;
    if (e.isDirectory() && (await containsGit(path.join(dir, e.name)))) return true;
  }
  return false;
}

const segmentGlob = (seg: string) => new RegExp(`^${seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/\\\\]*')}$`);

function segsMatch(segs: readonly string[], parts: readonly string[]): boolean {
  const [head, ...rest] = segs;
  if (head === undefined) return parts.length === 0;
  if (head === '**') return parts.some((_, i) => segsMatch(rest, parts.slice(i))) || segsMatch(rest, []);
  const [part, ...tail] = parts;
  return part !== undefined && segmentGlob(head).test(part) && segsMatch(rest, tail);
}

/** Каталог области, внутри которого лежит путь: корень или самый короткий префикс под маску. */
function areaDir(area: Area, target: string): string | undefined {
  if (!inside(area.root, target)) return undefined;
  if (area.segs.length === 0) return area.root;
  const parts = path.relative(area.root, target).split(path.sep).filter(Boolean);
  for (let k = 1; k <= parts.length; k++) if (segsMatch(area.segs, parts.slice(0, k))) return path.join(area.root, ...parts.slice(0, k));
  return undefined;
}

/** Сегмент `.` или `..`, в том числе закодированный: источник секретов нормализует путь сам и выйдет из-под маски. */
function dotSegment(ref: string): boolean {
  let current = ref;
  for (let i = 0; i < 4; i++) {
    if (current.split(/[/\\?#]/).some((s) => s === '.' || s === '..')) return true;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (next === current) return false;
    current = next;
  }
  return true;
}

function wildcard(mask: string, value: string): boolean {
  const re = new RegExp(`^${mask.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

function readDialogOptions(method: string, raw: unknown): OpenDialogOptions {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new CoreError('Invalid', `${method}: ожидается { title?, directory?, multiple? }`);
  const { title, directory, multiple, ...extra } = raw;
  const unknownKey = Object.keys(extra)[0];
  if (unknownKey !== undefined) throw new CoreError('Invalid', `${method}: нет поля ${unknownKey}`);
  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) throw new CoreError('Invalid', `${method}: title - строка до 200 символов`);
  for (const [name, v] of [['directory', directory], ['multiple', multiple]] as const) if (v !== undefined && typeof v !== 'boolean') throw new CoreError('Invalid', `${method}: ${name} - true или false`);
  return { ...(title !== undefined && { title }), ...(directory === true && { directory: true }), ...(multiple === true && { multiple: true }) };
}

const str = (method: string, v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new CoreError('Invalid', `${method}: ${name} не строка`);
  return v;
};

/** Причина отказа правила `process`, `pty` или `launch`; undefined - запуск подходит. */
function ruleRefusal(m: PluginManifest, key: 'process' | 'pty' | 'launch', program: string, argv: readonly string[], envNames: readonly string[]): string | undefined {
  const rule = (m.permissions[key] ?? []).find((r) => {
    if (typeof r === 'string') return r === program;
    return r.program === program && r.args.every((a, i) => argv[i] === a);
  });
  // Аргументы в журнал не идут: в них бывают токены (`--header 'Authorization: …'`).
  if (rule === undefined) return (m.permissions[key] ?? []).some((r) => (typeof r === 'string' ? r : r.program) === program) ? `аргументы не по правилу ${key}: ${program}` : `программа не в ${key}: ${program}`;
  // Окружение - тоже ввод программы (GIT_CONFIG_*, NODE_OPTIONS, LD_PRELOAD): только имена из правила.
  const allowedEnv = typeof rule === 'string' ? [] : (rule.env ?? []);
  const foreign = envNames.filter((k) => !allowedEnv.includes(k));
  return foreign.length > 0 ? `переменные не в правиле ${key}: ${foreign.join(', ')}` : undefined;
}

/** Шлюз ОС в главном процессе: вызывающего знает ядро по каналу хоста, права - из его манифеста. */
export class OsGateway {
  readonly #env: OsEnvironment;
  readonly #deny: (denial: Denial) => void;
  readonly #configOf: (pluginId: string) => Readonly<Record<string, unknown>>;
  readonly #manifestOf: (pluginId: string) => PluginManifest | undefined;
  readonly #roots = new Map<string, readonly string[]>();
  /** Хосты `config:<поле>` на момент активации или правки файла человеком: своя запись плагина в config их не меняет. */
  readonly #approved = new Map<string, Readonly<Record<string, unknown>>>();

  readonly #pty: PtyTable | undefined;
  readonly #push: (pluginId: string, method: PushMethod, params: unknown) => void;
  readonly #watches = new Map<string, () => void>();
  /** Что гасит незавершённые `process.run` и `net.fetch` плагина: его результат больше некому принять. */
  readonly #pending = new Map<string, Set<() => void>>();
  /** Выбор человека в `dialog`: область `granted` плагина, с `GrantStore` - и после перезапуска. */
  readonly #granted = new Map<string, Set<string>>();
  readonly #grants: GrantStore | undefined;
  #grantWrites: Promise<unknown> = Promise.resolve();
  readonly #serves: HttpServes;

  constructor(
    env: OsEnvironment,
    deny: (denial: Denial) => void,
    configOf: (pluginId: string) => Readonly<Record<string, unknown>> = () => ({}),
    push: (pluginId: string, method: PushMethod, params: unknown) => void = () => undefined,
    manifestOf: (pluginId: string) => PluginManifest | undefined = () => undefined,
    grants?: GrantStore,
    ask: AskHost = () => Promise.reject(new CoreError('Unavailable', 'хоста нет')),
  ) {
    this.#env = env;
    this.#serves = new HttpServes(ask);
    this.#grants = grants;
    const saved = grants?.read();
    if (isRecord(saved)) {
      for (const [pluginId, list] of Object.entries(saved)) {
        if (!Array.isArray(list)) continue;
        // Файл воркспейса правят руками: относительный путь сделал бы область зависимой от cwd приложения.
        const paths = list.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0'));
        if (paths.length > 0) this.#granted.set(pluginId, new Set(paths));
      }
    }
    this.#manifestOf = manifestOf;
    this.#push = push;
    this.#deny = deny;
    this.#configOf = configOf;
    this.#pty = env.pty && new PtyTable(env.pty, push, env.ptyBacklog);
  }

  pathsOf(pluginId: string): { data: string; temp: string; home: string } {
    return { data: path.join(this.#env.dataDir, pluginId), temp: path.join(this.#env.tempDir, pluginId), home: this.#home() };
  }

  #home = (): string => this.#env.home ?? os.homedir();

  #expand = (p: string): string => (p === '~' ? this.#home() : p.startsWith('~/') ? path.join(this.#home(), p.slice(2)) : p);

  /** Корни, принятые хосты и pty плагина уходят вместе с ним. pty: `detach` - упал хост, ждут только `persist`; `park` - человек оставил все живые; число оставленных. */
  forget(pluginId: string, pty: 'release' | 'detach' | 'park' = 'release'): number {
    this.#roots.delete(pluginId);
    this.#approved.delete(pluginId);
    for (const [key, close] of this.#watches) if (key.startsWith(`${pluginId}\0`)) close();
    for (const cancel of this.#pending.get(pluginId) ?? []) cancel();
    this.#pending.delete(pluginId);
    this.#serves.forget(pluginId);
    if (pty === 'park') return this.#pty?.park(pluginId) ?? 0;
    if (pty === 'detach') this.#pty?.detach(pluginId);
    else this.#pty?.release(pluginId);
    return 0;
  }

  /** Живые pty плагина - что завершит выключение без оставления. */
  ptysOf(pluginId: string): PtyInfo[] {
    return (this.#pty?.list(pluginId) ?? []).filter((p) => !p.exit);
  }

  releaseAllPty(): void {
    this.#pty?.releaseAll();
  }

  /** Вид плагина предъявил билет своей главной части; `pluginId` приложение берёт из origin фрейма, а не из слов вида. */
  openTerminal(pluginId: string, ticket: string, sink: TerminalSink): TerminalView {
    return this.#ptyTable().openTerminal(pluginId, ticket, sink);
  }

  /** Запомнить config плагина как принятый: зовётся при активации и после правки файла извне, но не после записи самого плагина. */
  approve(pluginId: string): void {
    this.#approved.set(pluginId, structuredClone(this.#configOf(pluginId)));
  }

  #denied(m: PluginManifest, method: string, detail: string, reason?: 'via-contract'): CoreError {
    this.#deny({ pluginId: m.id, method, detail, ...(reason && { reason }) });
    return new CoreError('PermissionDenied', `${m.id}: ${method} - ${detail}`);
  }

  async #areas(m: PluginManifest, right: 'fs.read' | 'fs.write' | 'shell'): Promise<Area[]> {
    const own = this.pathsOf(m.id);
    const named = m.permissions[right] ?? [];
    const plain = async (p: string, git = false): Promise<Area> => ({ root: await real(p), segs: [], git });
    const workspace = () => [...(this.#env.roots?.() ?? []), ...[...this.#roots.values()].flat()];
    // У shell своих каталогов нет: открыть свой файл в системе - тоже выход наружу, и он объявляется.
    const out: Promise<Area>[] = right === 'shell' ? [] : [plain(own.data), plain(own.temp)];
    for (const area of named) {
      if (area === 'workspace' || area === 'workspace.git') out.push(...workspace().map((r) => plain(r, area === 'workspace.git')));
      else if (area === 'granted') out.push(...[...(this.#granted.get(m.id) ?? [])].map((g) => plain(g)));
      else if (area === 'plugin-data' || area === 'plugin-temp') out.push(...(right === 'shell' ? [plain(area === 'plugin-data' ? own.data : own.temp)] : []));
      else if (area === ANY_PATH && right === 'shell') out.push(plain(path.parse(process.cwd()).root).then((a) => ({ ...a, any: true })));
      else if (area.startsWith('/') || area.startsWith('~')) out.push(this.#maskArea(area));
    }
    return Promise.all(out);
  }

  async #maskArea(area: string): Promise<Area> {
    const parts = this.#expand(area).split(/[\\/]/);
    const at = parts.findIndex((s) => s.includes('*'));
    if (at === -1) return { root: await real(this.#expand(area)), segs: [], git: false };
    return { root: await real(parts.slice(0, at).join(path.sep) || path.sep), segs: parts.slice(at).filter(Boolean), git: false };
  }

  async #checkPath(m: PluginManifest, method: string, raw: unknown, write: boolean, right: 'fs.read' | 'fs.write' | 'shell' = write ? 'fs.write' : 'fs.read', reason?: 'via-contract'): Promise<string> {
    const given = str(method, raw, 'путь');
    if (!path.isAbsolute(given) || given.includes('\0')) throw this.#denied(m, method, `путь не абсолютный: ${given}`, reason);
    const target = await realOrParent(given);
    const matched = (await this.#areas(m, right)).flatMap((a) => {
      const dir = areaDir(a, target);
      return dir === undefined ? [] : [{ dir, root: a.root, git: a.git }];
    });
    const area = matched[0]?.dir;
    if (area === undefined) throw this.#denied(m, method, `вне области ${right}: ${given}`, reason);
    const own = this.pathsOf(m.id);
    const isOwn = inside(await real(own.data), target) || inside(await real(own.temp), target);
    if (isOwn) return target;
    for (const dir of [this.#env.dataDir, this.#env.tempDir]) if (inside(await real(dir), target)) throw this.#denied(m, method, `каталог другого плагина: ${given}`, reason);
    if (this.#env.appDir !== undefined && inside(await real(this.#env.appDir), target)) {
      const appRoots = await Promise.all((this.#env.roots?.() ?? []).map(real));
      if (!appRoots.some((r) => inside(r, target))) throw this.#denied(m, method, `данные приложения: ${given}`, reason);
    }
    for (const p of this.#env.protectedPaths ?? []) {
      const protectedPath = await real(p);
      // Предок защищённого пути закрыт только для записи: удаление или перезапись каталога унесли бы и его.
      if (inside(protectedPath, target) || (write && inside(target, protectedPath))) throw this.#denied(m, method, `защищённый путь: ${given}`, reason);
    }
    const gitOk = matched.some((a) => a.git);
    // От корня области, а не от каталога под маску: `*` совпадает и с самим `.git`, и путь внутри него был бы без сегмента `.git`.
    const inGit = matched.some((a) => path.relative(a.root, target).split(path.sep).includes('.git'));
    if (write && !gitOk && inGit) throw this.#denied(m, method, `запись в .git: ${given}`, reason);
    return target;
  }

  /** `via-contract`: право вызывающего на аргумент чужого члена контракта; поставщик потом выполнит вызов по своим правам. */
  async checkFor(m: PluginManifest, method: string, right: GuardRight, value: string): Promise<void> {
    if (right !== 'secrets.ref') {
      const target = await this.#checkPath(m, method, value, right === 'fs.write', right, 'via-contract');
      // Иначе вызывающий запишет файл и попросит открыть его поставщика, который туда не пишет.
      if (right !== 'shell') return;
      const st = await fs.stat(target).catch(() => undefined);
      // Пропавший путь вызывающий успел бы создать, пока вызов идёт к поставщику.
      if (st === undefined) throw new CoreError('NotFound', `${method}: нет ${value}`);
      await this.#checkOpen(m, method, target, st, value, 'via-contract');
      return;
    }
    if (!this.refAllowed(m, value)) throw this.#denied(m, method, `ссылка вне secrets.ref: ${value}`, 'via-contract');
  }

  refAllowed(m: PluginManifest, ref: string): boolean {
    return !dotSegment(ref) && m.permissions['secrets.ref']?.some((mask) => wildcard(mask, ref)) === true;
  }

  // Записи по очереди: два диалога подряд не затрут друг друга снимком, снятым до чужой записи.
  #saveGrants(): Promise<void> {
    const store = this.#grants;
    if (!store) return Promise.resolve();
    const write = this.#grantWrites.then(() => store.write(Object.fromEntries([...this.#granted].map(([id, set]) => [id, [...set]]))));
    this.#grantWrites = write.catch(() => undefined);
    return write;
  }

  /** Программой ОС открывается не программа; файл, который мог подготовить не человек, - только документ. */
  async #checkOpen(m: PluginManifest, method: string, target: string, st: Stats, given: string, reason?: 'via-contract'): Promise<void> {
    if (EXECUTABLE.test(target) || (st.isFile() && (st.mode & 0o111) !== 0)) throw this.#denied(m, method, `исполняемый файл: ${given}`, reason);
    const document = st.isFile() && DOCUMENT.test(target);
    const writable = (await this.#areas(m, 'fs.write')).some((a) => areaDir(a, target) !== undefined);
    if (writable && !document) throw this.#denied(m, method, `в области своей записи открывается только документ: ${given}`, reason);
    const named = (await this.#areas(m, 'shell')).some((a) => a.any !== true && areaDir(a, target) !== undefined);
    if (!named && st.isFile() && !document) throw this.#denied(m, method, `вне названных областей открывается только документ или каталог: ${given}`, reason);
  }

  async #ownDirs(pluginId: string): Promise<void> {
    const own = this.pathsOf(pluginId);
    await fs.mkdir(own.data, { recursive: true });
    await fs.mkdir(own.temp, { recursive: true });
  }

  async call(m: PluginManifest, method: string, args: readonly unknown[]): Promise<unknown> {
    const p = m.permissions;
    switch (method) {
      case 'fs.readText': {
        await this.#ownDirs(m.id);
        const file = await this.#checkPath(m, method, args[0], false);
        // O_NOFOLLOW: путь уже без ссылок, подменённый на ссылку последний компонент не откроется.
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          return await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
      }
      case 'fs.readSlice': {
        await this.#ownDirs(m.id);
        const file = await this.#checkPath(m, method, args[0], false);
        const offset = int(method, args[1], 'offset', 0, Number.MAX_SAFE_INTEGER);
        const max = int(method, args[2], 'maxBytes', 4, MAX_SLICE);
        const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const size = (await handle.stat()).size;
          const buf = Buffer.alloc(Math.min(max, Math.max(0, size - offset)));
          const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
          const end = offset + bytesRead >= size ? bytesRead : utf8End(buf, bytesRead);
          return { text: buf.toString('utf8', 0, end), bytes: end, size } satisfies FileSlice;
        } finally {
          await handle.close();
        }
      }
      case 'fs.watch': {
        const id = str(method, args[1], 'id');
        const key = `${m.id}\0${id}`;
        if (this.#watches.has(key)) throw new CoreError('Invalid', `${method}: id ${id} уже занят`);
        if ([...this.#watches.keys()].filter((k) => k.startsWith(`${m.id}\0`)).length >= MAX_WATCHES) throw new CoreError('Invalid', `${method}: больше ${String(MAX_WATCHES)} слежений`);
        // Место занято до первого await: иначе параллельные вызовы прошли бы лимит, а выгрузка посреди вызова оставила бы наблюдателя.
        const reserved = () => void this.#watches.delete(key);
        this.#watches.set(key, reserved);
        let target: string;
        try {
          await this.#ownDirs(m.id);
          target = await this.#checkPath(m, method, args[0], false);
          await fs.stat(target);
        } catch (error) {
          if (this.#watches.get(key) === reserved) this.#watches.delete(key);
          throw error;
        }
        if (this.#watches.get(key) !== reserved) throw new CoreError('Unavailable', `${method}: плагин выгружен`);
        const names = new Set<string>();
        let timer: NodeJS.Timeout | undefined;
        const close = (reason?: string) => {
          clearTimeout(timer);
          watcher.close();
          if (this.#watches.get(key) !== close) return;
          this.#watches.delete(key);
          if (reason !== undefined) this.#push(m.id, 'fs.change', { pluginId: m.id, id, names: [], closed: reason });
        };
        // Право проверяется на каждой пачке: корни воркспейса могли сузиться после подписки.
        const send = async () => {
          timer = undefined;
          const list = [...names];
          names.clear();
          if ((await this.#checkPath(m, method, args[0], false).catch(() => undefined)) !== target) close('путь больше не в правах плагина');
          else if (this.#watches.get(key) === close) this.#push(m.id, 'fs.change', { pluginId: m.id, id, names: list });
        };
        const watcher = (this.#env.watch ?? watchFs)(target, (_event, name) => {
          if (name) names.add(name);
          timer ??= setTimeout(() => void send(), WATCH_COALESCE_MS);
        });
        // Без слушателя ошибка наблюдателя (удалён каталог, кончились inotify) уронила бы главный процесс.
        watcher.on('error', (error) => close(`наблюдение прервано: ${error.message}`));
        this.#watches.set(key, close);
        return undefined;
      }
      case 'fs.unwatch': {
        this.#watches.get(`${m.id}\0${str(method, args[0], 'id')}`)?.();
        return undefined;
      }
      case 'fs.list': {
        await this.#ownDirs(m.id);
        const dir = await this.#checkPath(m, method, args[0], false);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.map((e): DirEntry => ({ name: e.name, kind: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'other' }));
      }
      case 'fs.stat': {
        await this.#ownDirs(m.id);
        const file = await this.#checkPath(m, method, args[0], false);
        const s = await fs.stat(file);
        return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs } satisfies FileStat;
      }
      case 'fs.writeText': {
        await this.#ownDirs(m.id);
        const file = await this.#checkPath(m, method, args[0], true);
        const text = str(method, args[1], 'текст');
        const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
        try {
          await handle.writeFile(text, 'utf8');
        } finally {
          await handle.close();
        }
        return undefined;
      }
      case 'fs.mkdir': {
        await this.#ownDirs(m.id);
        await fs.mkdir(await this.#checkPath(m, method, args[0], true), { recursive: true });
        return undefined;
      }
      case 'fs.remove': {
        await this.#ownDirs(m.id);
        const target = await this.#checkPath(m, method, args[0], true);
        const own = this.pathsOf(m.id);
        if (target === (await real(own.data)) || target === (await real(own.temp))) throw this.#denied(m, method, 'свой каталог целиком не удаляется');
        const areas = await this.#areas(m, 'fs.write');
        if (areas.some((a) => areaDir(a, target) === target)) throw this.#denied(m, method, `корень области не удаляется: ${String(args[0])}`);
        if (!inside(await real(own.data), target) && !inside(await real(own.temp), target) && (await containsGit(target))) {
          throw this.#denied(m, method, `внутри есть .git: ${String(args[0])}`);
        }
        await fs.rm(target, { recursive: true, force: true });
        return undefined;
      }
      case 'process.run':
        return this.#run(m, args);
      case 'pty.spawn': {
        const table = this.#ptyTable();
        const o = isRecord(args[0]) ? args[0] : {};
        const program = str(method, o.program, 'программа');
        const argv = o.args ?? [];
        const checked = await this.#program(m, 'pty', method, program, argv, o);
        // Confused deputy: описание чужого поставщика идёт под правом потребителя, только если поставщик сам его объявил.
        if (o.describedBy !== undefined) {
          const id = str(method, o.describedBy, 'describedBy');
          const provider = this.#manifestOf(id);
          if (!provider) throw this.#denied(m, method, `плагина ${id} нет`);
          const refused = ruleRefusal(provider, 'launch', program, checked.argv, Object.keys(isRecord(o.env) ? o.env : {}));
          if (refused) throw this.#denied(m, method, `${id}: ${refused}`);
        }
        const size = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000 ? (v as number) : fallback);
        return table.spawn(m.id, { program: checked.file, args: checked.argv, ...(checked.cwd !== undefined && { cwd: checked.cwd }), env: checked.env, cols: size(o.cols, 80), rows: size(o.rows, 24), persist: o.persist === true });
      }
      case 'pty.share':
        return this.#ptyTable().share(m.id, str(method, args[0], 'id'));
      case 'pty.list':
        return this.#ptyTable().list(m.id);
      case 'pty.attach':
        return this.#ptyTable().attach(m.id, str(method, args[0], 'id'));
      case 'pty.write':
        this.#ptyTable().write(m.id, str(method, args[0], 'id'), str(method, args[1], 'ввод'));
        return undefined;
      case 'pty.resize': {
        const [cols, rows] = [args[1], args[2]];
        if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 1 || (rows as number) < 1 || (cols as number) > 1000 || (rows as number) > 1000) throw new CoreError('Invalid', `${method}: размер - целые 1..1000`);
        this.#ptyTable().resize(m.id, str(method, args[0], 'id'), cols as number, rows as number);
        return undefined;
      }
      case 'pty.kill': {
        const signal = args[1];
        if (signal !== undefined && !PTY_SIGNALS.includes(signal as never)) throw new CoreError('Invalid', `${method}: сигнал - один из ${PTY_SIGNALS.join(', ')}`);
        this.#ptyTable().kill(m.id, str(method, args[0], 'id'), signal as string | undefined);
        return undefined;
      }
      case 'net.fetch':
        return this.#fetch(m, args);
      case 'serve.http':
        if (!p.serve) throw this.#denied(m, method, 'нет права serve');
        return this.#serves.open(m.id, str(method, args[0], 'id'));
      case 'serve.close':
        this.#serves.close(m.id, str(method, args[0], 'id'));
        return undefined;
      case 'env.get': {
        const name = str(method, args[0], 'имя');
        if (!p.env?.includes(name)) throw this.#denied(m, method, `переменная ${name} не в env`);
        return (this.#env.env ?? process.env)[name];
      }
      case 'notify.show': {
        if (!p.notify) throw this.#denied(m, method, 'нет права notify');
        if (!this.#env.notify) throw new CoreError('Unavailable', 'уведомлений нет в этой среде');
        await this.#env.notify(str(method, args[0], 'заголовок'), typeof args[1] === 'string' ? args[1] : undefined);
        return undefined;
      }
      case 'clipboard.readText':
      case 'clipboard.writeText': {
        const want = method === 'clipboard.readText' ? 'read' : 'write';
        if (!p.clipboard?.includes(want)) throw this.#denied(m, method, `нет права clipboard: ${want}`);
        if (!this.#env.clipboard) throw new CoreError('Unavailable', 'буфера обмена нет в этой среде');
        if (want === 'read') return this.#env.clipboard.readText();
        await this.#env.clipboard.writeText(str(method, args[0], 'текст'));
        return undefined;
      }
      case 'secrets.get':
      case 'secrets.set':
      case 'secrets.delete': {
        const store = await this.#store();
        const key = `${m.id}/${str(method, args[0], 'ключ')}`;
        if (method === 'secrets.get') return store.get(key);
        if (method === 'secrets.set') return store.set(key, str(method, args[1], 'значение'));
        return store.delete(key);
      }
      case 'secrets.resolve':
        return this.#resolve(m, args[0]);
      case 'shell.openPath': {
        const target = await this.#checkPath(m, method, args[0], false, 'shell');
        const st = await fs.stat(target).catch(() => undefined);
        if (st === undefined) throw new CoreError('NotFound', `${method}: нет ${String(args[0])}`);
        await this.#checkOpen(m, method, target, st, String(args[0]));
        if (!this.#env.shell) throw new CoreError('Unavailable', 'открытия в системе нет в этой среде');
        await this.#env.shell.openPath(target);
        return undefined;
      }
      case 'shell.openExternal': {
        const raw = str(method, args[0], 'URL');
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          throw new CoreError('Invalid', `${method}: не URL: ${raw}`);
        }
        if (!(p.shell ?? []).includes(url.protocol)) throw this.#denied(m, method, `схема ${url.protocol} не в праве shell`);
        if (!this.#env.shell) throw new CoreError('Unavailable', 'открытия в системе нет в этой среде');
        await this.#env.shell.openExternal(url.href);
        return undefined;
      }
      case 'dialog.open': {
        const options = readDialogOptions(method, args[0]);
        if (!this.#env.dialog) throw new CoreError('Unavailable', 'диалога выбора нет в этой среде');
        const chosen = (await this.#env.dialog.open(options)).filter((c) => path.isAbsolute(c));
        const grants = this.#granted.get(m.id) ?? new Set<string>();
        const before = grants.size;
        for (const c of chosen) grants.add(await real(c));
        this.#granted.set(m.id, grants);
        // Выбор человека уже сделан и действует в этом запуске; несохранённый - его забота при следующем, а не отказ плагину сейчас.
        if (grants.size > before) await this.#saveGrants().catch(() => undefined);
        return chosen;
      }
      case 'security.setRoots': {
        if (!p['security.roots']) throw this.#denied(m, method, 'нет права security.roots');
        const roots = args[0];
        if (!Array.isArray(roots) || !roots.every((r): r is string => typeof r === 'string' && path.isAbsolute(r))) throw new CoreError('Invalid', `${method}: ожидается список абсолютных путей`);
        const accepted: string[] = [];
        // Корень - каталог проекта: корень ФС, домашний каталог или каталог приложения открыли бы плагинам с workspace всё.
        const closed = await Promise.all([this.#home(), this.#env.dataDir, this.#env.tempDir, ...(this.#env.appDir === undefined ? [] : [this.#env.appDir]), ...(this.#env.protectedPaths ?? [])].map(real));
        for (const r of roots) {
          const dir = await real(r);
          const stat = await fs.stat(dir).catch(() => undefined);
          if (!stat?.isDirectory()) throw this.#denied(m, method, `корень не каталог: ${r}`);
          if (path.dirname(dir) === dir || closed.some((c) => inside(dir, c))) throw this.#denied(m, method, `корень шире проекта: ${r}`);
          accepted.push(dir);
        }
        this.#roots.set(m.id, accepted);
        return undefined;
      }
      default:
        throw new CoreError('Invalid', `${method}: такого вызова ctx.os нет`);
    }
  }

  async #store(): Promise<SecretStore> {
    const store = this.#env.secrets;
    if (store === undefined || !(await store.available())) throw new CoreError('Unavailable', 'хранилище секретов недоступно: нет шифрования ОС');
    return store;
  }

  async #resolve(m: PluginManifest, raw: unknown): Promise<SecretValue> {
    const ref = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw.$secret === 'string' ? raw.$secret : undefined;
    if (ref === undefined) throw new CoreError('Invalid', 'secrets.resolve: ожидается строка или {$secret}');
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(ref)?.[1];
    if (scheme === undefined) {
      const value = await (await this.#store()).get(`${m.id}/${ref}`);
      if (value === undefined) throw new CoreError('Unavailable', `секрета ${ref} нет`);
      return { value };
    }
    if (!this.refAllowed(m, ref)) throw this.#denied(m, 'secrets.resolve', `ссылка вне secrets.ref: ${ref}`);
    throw new CoreError('Unavailable', `источника секретов со схемой ${scheme} нет`);
  }

  #ptyTable(): PtyTable {
    if (!this.#pty) throw new CoreError('Unavailable', 'pty: у приложения нет псевдотерминала');
    return this.#pty;
  }

  /** Одна проверка на `process` и `pty`: копии разъехались бы, и отставшая открыла бы обход. */
  async #program(m: PluginManifest, key: 'process' | 'pty', method: string, program: string, argv: unknown, options: Record<string, unknown>) {
    if (!Array.isArray(argv) || !argv.every((a): a is string => typeof a === 'string')) throw new CoreError('Invalid', `${method}: аргументы не список строк`);
    const extra = isRecord(options.env) ? Object.fromEntries(Object.entries(options.env).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    const refused = ruleRefusal(m, key, program, argv, Object.keys(extra));
    if (refused) throw this.#denied(m, method, refused);
    const env0 = this.#env.env ?? process.env;
    // Оболочка входа даёт программе PATH из профиля человека: окно, открытое из Dock или меню, его не наследует.
    const file = program === LOGIN_SHELL ? (env0.SHELL?.length ? env0.SHELL : '/bin/sh') : program;
    const cwd = options.cwd === undefined ? undefined : await this.#checkPath(m, method, options.cwd, false);
    const base = Object.fromEntries(Object.entries(env0).filter((e): e is [string, string] => typeof e[1] === 'string' && BASE_ENV.test(e[0])));
    return { file, argv, cwd, env: { ...base, ...extra } };
  }

  async #run(m: PluginManifest, args: readonly unknown[]): Promise<ProcessResult> {
    const method = 'process.run';
    const program = str(method, args[0], 'программа');
    const options = isRecord(args[2]) ? args[2] : {};
    const { file, argv, cwd, env } = await this.#program(m, 'process', method, program, args[1], options);
    const timeout = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0;
    return new Promise((resolve, reject) => {
      // Своя группа процессов: тайм-аут и выгрузка плагина гасят и то, что программа запустила сама.
      const child = spawn(file, argv, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const stop = (signal: NodeJS.Signals) => {
        // До close, а не до выхода лидера: потомки, держащие его вывод, ещё живы в группе.
        if (child.pid !== undefined) killGroup(child.pid, signal);
      };
      const timer = timeout > 0 ? setTimeout(() => stop('SIGTERM'), timeout) : undefined;
      const untrack = this.#track(m.id, () => stop('SIGKILL'));
      const done = () => {
        clearTimeout(timer);
        untrack();
      };
      let stdout = '';
      let stderr = '';
      const cap = (s: string, chunk: Buffer) => (s.length < MAX_OUTPUT ? s + chunk.toString('utf8') : s);
      child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
      child.once('error', (error) => {
        done();
        reject(new CoreError('Remote', `${program}: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        done();
        resolve({ code, signal, stdout, stderr });
      });
      child.stdin.end(typeof options.input === 'string' ? options.input : undefined);
    });
  }

  #track(pluginId: string, cancel: () => void): () => void {
    const set = this.#pending.get(pluginId) ?? new Set();
    this.#pending.set(pluginId, set);
    set.add(cancel);
    return () => void set.delete(cancel);
  }

  async #fetch(m: PluginManifest, args: readonly unknown[]): Promise<HttpResponse> {
    const method = 'net.fetch';
    let url: URL;
    try {
      url = new URL(str(method, args[0], 'адрес'));
    } catch {
      throw new CoreError('Invalid', `${method}: адрес не URL`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw this.#denied(m, method, `схема ${url.protocol}`);
    const config = this.#approved.get(m.id) ?? {};
    const hosts = (m.permissions.net ?? []).flatMap((h) => {
      if (!h.startsWith('config:')) return [h.toLowerCase()];
      const v = config[h.slice('config:'.length)];
      if (typeof v !== 'string') return [];
      try {
        return [new URL(v).host.toLowerCase()];
      } catch {
        return [v.toLowerCase()];
      }
    });
    // Запись без порта - только порт схемы по умолчанию: URL сводит его к пустой строке.
    if (!hosts.includes(url.host.toLowerCase())) throw this.#denied(m, method, `хост не в net: ${url.host}`);
    const request = isRecord(args[1]) ? args[1] : {};
    const headers = isRecord(request.headers) ? Object.fromEntries(Object.entries(request.headers).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    const timeout = typeof request.timeoutMs === 'number' && request.timeoutMs > 0 ? request.timeoutMs : FETCH_TIMEOUT_MS;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new CoreError('Timeout', `${method}: ${url.host} не ответил за ${String(timeout)} мс`)), timeout);
    const untrack = this.#track(m.id, () => abort.abort(new CoreError('Unavailable', `${method}: плагин выгружен`)));
    try {
      // Переадресация не идёт сама: иначе ответ пришёл бы с хоста, которого нет в праве.
      const response = await (this.#env.fetch ?? fetch)(url, {
        method: typeof request.method === 'string' ? request.method : 'GET',
        headers,
        redirect: 'manual',
        signal: abort.signal,
        ...(typeof request.body === 'string' && { body: request.body }),
      });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await readBody(response, MAX_BODY) };
    } catch (error) {
      throw abort.signal.aborted && abort.signal.reason instanceof CoreError ? abort.signal.reason : error;
    } finally {
      clearTimeout(timer);
      untrack();
    }
  }
}

/** Тело читается в главном процессе: без предела ответ сервера съел бы память всего приложения. */
async function readBody(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new CoreError('Remote', `net.fetch: ответ больше ${String(limit / 1024 / 1024)} МиБ`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
