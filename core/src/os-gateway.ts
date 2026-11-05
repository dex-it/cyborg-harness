import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirEntry, FileStat, HttpResponse, ProcessResult, PtyInfo, SecretValue } from '@cyborg/contracts';
import { CoreError } from './errors.ts';
import type { PluginManifest } from './manifest.ts';
import { PTY_SIGNALS, PtyTable, type PtyBackend, type TerminalSink, type TerminalView } from './pty.ts';
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
  /** Псевдотерминал; нет - `ctx.os.pty` отвечает `Unavailable`. */
  readonly pty?: PtyBackend;
  /** Хвост вывода pty, символов; по умолчанию 256 К. */
  readonly ptyBacklog?: number;
}

export interface Denial {
  readonly pluginId: string;
  readonly method: string;
  /** Что именно не пропущено; значения секретов и тела запросов сюда не попадают. */
  readonly detail: string;
}

const MAX_OUTPUT = 16 * 1024 * 1024;

/** Окружение запущенной программы: то, без чего она не найдёт себя и пользователя; остальное - по правилу. */
const BASE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z]+|SystemRoot|SYSTEMROOT|ComSpec|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|WINDIR)$/;

const inside = (dir: string, target: string) => target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const expand = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

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

function wildcard(mask: string, value: string): boolean {
  const re = new RegExp(`^${mask.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

const str = (method: string, v: unknown, name: string): string => {
  if (typeof v !== 'string') throw new CoreError('Invalid', `${method}: ${name} не строка`);
  return v;
};

/** Шлюз ОС в главном процессе: вызывающего знает ядро по каналу хоста, права - из его манифеста. */
export class OsGateway {
  readonly #env: OsEnvironment;
  readonly #deny: (denial: Denial) => void;
  readonly #configOf: (pluginId: string) => Readonly<Record<string, unknown>>;
  readonly #roots = new Map<string, readonly string[]>();
  /** Хосты `config:<поле>` на момент активации или правки файла человеком: своя запись плагина в config их не меняет. */
  readonly #approved = new Map<string, Readonly<Record<string, unknown>>>();

  readonly #pty: PtyTable | undefined;

  constructor(
    env: OsEnvironment,
    deny: (denial: Denial) => void,
    configOf: (pluginId: string) => Readonly<Record<string, unknown>> = () => ({}),
    push: (pluginId: string, method: 'pty.data' | 'pty.exit', params: unknown) => void = () => undefined,
  ) {
    this.#env = env;
    this.#deny = deny;
    this.#configOf = configOf;
    this.#pty = env.pty && new PtyTable(env.pty, push, env.ptyBacklog);
  }

  pathsOf(pluginId: string): { data: string; temp: string } {
    return { data: path.join(this.#env.dataDir, pluginId), temp: path.join(this.#env.tempDir, pluginId) };
  }

  /** Корни, принятые хосты и pty плагина уходят вместе с ним. pty: `detach` - упал хост, ждут только `persist`; `park` - человек оставил все живые; число оставленных. */
  forget(pluginId: string, pty: 'release' | 'detach' | 'park' = 'release'): number {
    this.#roots.delete(pluginId);
    this.#approved.delete(pluginId);
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

  #denied(m: PluginManifest, method: string, detail: string): CoreError {
    this.#deny({ pluginId: m.id, method, detail });
    return new CoreError('PermissionDenied', `${m.id}: ${method} - ${detail}`);
  }

  async #areas(m: PluginManifest, right: 'fs.read' | 'fs.write'): Promise<string[]> {
    const own = this.pathsOf(m.id);
    const named = m.permissions[right] ?? [];
    const out: string[] = [own.data, own.temp];
    for (const area of named) {
      if (area === 'workspace') out.push(...(this.#env.roots?.() ?? []), ...[...this.#roots.values()].flat());
      else if (area !== 'plugin-data' && area !== 'plugin-temp') out.push(expand(area));
    }
    return Promise.all(out.map(real));
  }

  async #checkPath(m: PluginManifest, method: string, raw: unknown, write: boolean): Promise<string> {
    const given = str(method, raw, 'путь');
    if (!path.isAbsolute(given) || given.includes('\0')) throw this.#denied(m, method, `путь не абсолютный: ${given}`);
    const target = await realOrParent(given);
    const areas = await this.#areas(m, write ? 'fs.write' : 'fs.read');
    const area = areas.find((a) => inside(a, target));
    if (area === undefined) throw this.#denied(m, method, `вне области ${write ? 'fs.write' : 'fs.read'}: ${given}`);
    const own = this.pathsOf(m.id);
    const isOwn = inside(await real(own.data), target) || inside(await real(own.temp), target);
    if (isOwn) return target;
    for (const dir of [this.#env.dataDir, this.#env.tempDir]) if (inside(await real(dir), target)) throw this.#denied(m, method, `каталог другого плагина: ${given}`);
    if (this.#env.appDir !== undefined && inside(await real(this.#env.appDir), target)) {
      const appRoots = await Promise.all((this.#env.roots?.() ?? []).map(real));
      if (!appRoots.some((r) => inside(r, target))) throw this.#denied(m, method, `данные приложения: ${given}`);
    }
    for (const p of this.#env.protectedPaths ?? []) {
      const protectedPath = await real(p);
      // Предок защищённого пути закрыт только для записи: удаление или перезапись каталога унесли бы и его.
      if (inside(protectedPath, target) || (write && inside(target, protectedPath))) throw this.#denied(m, method, `защищённый путь: ${given}`);
    }
    if (write && path.relative(area, target).split(path.sep).includes('.git')) throw this.#denied(m, method, `запись в .git: ${given}`);
    return target;
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
        if (areas.includes(target)) throw this.#denied(m, method, `корень области не удаляется: ${String(args[0])}`);
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
        const size = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000 ? (v as number) : fallback);
        return table.spawn(m.id, { program, args: checked.argv, ...(checked.cwd !== undefined && { cwd: checked.cwd }), env: checked.env, cols: size(o.cols, 80), rows: size(o.rows, 24), persist: o.persist === true });
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
      case 'security.setRoots': {
        if (!p['security.roots']) throw this.#denied(m, method, 'нет права security.roots');
        const roots = args[0];
        if (!Array.isArray(roots) || !roots.every((r): r is string => typeof r === 'string' && path.isAbsolute(r))) throw new CoreError('Invalid', `${method}: ожидается список абсолютных путей`);
        const accepted: string[] = [];
        // Корень - каталог проекта: корень ФС, домашний каталог или каталог приложения открыли бы плагинам с workspace всё.
        const closed = await Promise.all([os.homedir(), this.#env.dataDir, this.#env.tempDir, ...(this.#env.appDir === undefined ? [] : [this.#env.appDir]), ...(this.#env.protectedPaths ?? [])].map(real));
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
    if (!m.permissions['secrets.ref']?.some((mask) => wildcard(mask, ref))) throw this.#denied(m, 'secrets.resolve', `ссылка вне secrets.ref: ${ref}`);
    throw new CoreError('Unavailable', `источника секретов со схемой ${scheme} нет`);
  }

  #ptyTable(): PtyTable {
    if (!this.#pty) throw new CoreError('Unavailable', 'pty: у приложения нет псевдотерминала');
    return this.#pty;
  }

  /** Одна проверка на `process` и `pty`: копии разъехались бы, и отставшая открыла бы обход. */
  async #program(m: PluginManifest, key: 'process' | 'pty', method: string, program: string, argv: unknown, options: Record<string, unknown>) {
    if (!Array.isArray(argv) || !argv.every((a): a is string => typeof a === 'string')) throw new CoreError('Invalid', `${method}: аргументы не список строк`);
    const rule = (m.permissions[key] ?? []).find((r) => {
      if (typeof r === 'string') return r === program;
      return r.program === program && r.args.every((a, i) => argv[i] === a);
    });
    if (rule === undefined) throw this.#denied(m, method, `программа не в ${key}: ${[program, ...argv.slice(0, 2)].join(' ')}`);
    const cwd = options.cwd === undefined ? undefined : await this.#checkPath(m, method, options.cwd, false);
    const extra = isRecord(options.env) ? Object.fromEntries(Object.entries(options.env).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    // Окружение - тоже ввод программы (GIT_CONFIG_*, NODE_OPTIONS, LD_PRELOAD): только имена из правила.
    const allowedEnv = typeof rule === 'string' ? [] : (rule.env ?? []);
    const foreign = Object.keys(extra).filter((k) => !allowedEnv.includes(k));
    if (foreign.length > 0) throw this.#denied(m, method, `переменные не в правиле ${key}: ${foreign.join(', ')}`);
    const base = Object.fromEntries(Object.entries(this.#env.env ?? process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && BASE_ENV.test(e[0])));
    return { argv, cwd, env: { ...base, ...extra } };
  }

  async #run(m: PluginManifest, args: readonly unknown[]): Promise<ProcessResult> {
    const method = 'process.run';
    const program = str(method, args[0], 'программа');
    const options = isRecord(args[2]) ? args[2] : {};
    const { argv, cwd, env } = await this.#program(m, 'process', method, program, args[1], options);
    const timeout = typeof options.timeoutMs === 'number' ? options.timeoutMs : 0;
    return new Promise((resolve, reject) => {
      const child = spawn(program, argv, { cwd, env, shell: false, timeout, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const cap = (s: string, chunk: Buffer) => (s.length < MAX_OUTPUT ? s + chunk.toString('utf8') : s);
      child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
      child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
      child.once('error', (error) => reject(new CoreError('Remote', `${program}: ${error.message}`)));
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      child.stdin.end(typeof options.input === 'string' ? options.input : undefined);
    });
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
    // Переадресация не идёт сама: иначе ответ пришёл бы с хоста, которого нет в праве.
    const response = await (this.#env.fetch ?? fetch)(url, {
      method: typeof request.method === 'string' ? request.method : 'GET',
      headers,
      redirect: 'manual',
      ...(typeof request.body === 'string' && { body: request.body }),
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }
}
