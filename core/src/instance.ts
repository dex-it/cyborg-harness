import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { NeighborInstance } from './kernel-types.ts';
import { lockWorkspace } from './workspace.ts';

// Один экземпляр приложения на воркспейс (K-20, SAD 3.1). Разные воркспейсы - разные процессы с общим `userData`.
// Замок `<файл>.lock` воркспейса отвечает за данные; здесь - за разговор: второй запуск того же воркспейса просит владельца
// поднять окно и уходит. Адрес владельца выводится из ключа воркспейса (`workspaceKey`), поэтому в замке его хранить не нужно.

export type Claim =
  /** Экземпляр этого воркспейса - наш; `close` отдаёт адрес. */
  | { readonly kind: 'owner'; close(): void }
  /** Владелец есть и получил запрос: этому процессу пора выйти. */
  | { readonly kind: 'handed' }
  /** Владелец есть, но не ответил в срок: второй экземпляр всё равно не запускается. */
  | { readonly kind: 'unresponsive' };

export interface InstanceOptions {
  /** Каталог адреса (unix-сокет); по умолчанию личный (см. `instanceDir`). На Windows адрес - именованный канал. */
  readonly dir?: string;
  /**
   * Личный каталог пользователя (в приложении - `userData`). Без `XDG_RUNTIME_DIR` адреса кладутся в `<home>/run`, а не в общий `/tmp`,
   * где предсказуемый каталог заранее занимает любой локальный пользователь и не даёт приложению запуститься.
   */
  readonly home?: string;
  /** Сколько ждать ответа владельца, мс; по умолчанию 3 с. */
  readonly askTimeoutMs?: number;
  /**
   * Плагины, которые могут работать в окне этого экземпляра (`Kernel.working`): их называет владелец соседнему окну того же `userData`, когда
   * то готовится удалить плагин (`neighborInstances`, `Kernel.uninstall`; #154). Читается при каждом запросе, поэтому ядро может появиться
   * позже claim; бросок или `undefined` - «не знаю», сосед в этом случае считает плагины неизвестными и удаление не разрешает.
   */
  readonly plugins?: (() => readonly string[]) | undefined;
  /** Шов для тестов: вызывается в `removeStale` после «сокет мёртв», до удаления файла; в нём должен быть не больше одного процесса. */
  readonly afterStaleCheck?: () => void | Promise<void>;
}

/**
 * Служебный запрос соседа: вместо `data` второго запуска (окно не поднимается) владелец отвечает строкой `{"ok":true,"plugins":[...]}`.
 * Ключ с `$`: данные приложения (`claimInstance(key, data)`) его не называют.
 */
const QUERY_KEY = '$query';
const QUERY_PLUGINS = 'plugins';
const MAX_MESSAGE = 64 * 1024;
const STARTUP_GRACE_MS = 500;

// Предел `sun_path`: 104 байта на macOS, 108 на Linux; берём с запасом. Самый длинный ключ - окно без воркспейса (`no-workspace-<12>`).
const SOCKET_PATH_LIMIT = 100;
const LONGEST_ADDRESS = 'no-workspace-0123456789ab.sock';

/**
 * Каталог адресов: личный, не общий. Порядок: `XDG_RUNTIME_DIR`, если он абсолютный (его создаёт и закрывает система; пустое и относительное значение
 * недействительны по XDG Base Directory); иначе `<home>/run`, если адрес в него влезает (`home` - `userData`, создан самим пользователем,
 * заранее его не подсунуть); иначе `tmpdir`: на macOS он личный (`/var/folders/...`), на других unix общий, и предсказуемый каталог там может занять
 * заранее любой, - `privateDir` тогда отказывает, а приложение запускается без контроля экземпляров (см. `workspaceInstance`).
 */
export function instanceDir(home?: string): string {
  const uid = process.getuid?.();
  const name = `cyborg-harness${uid === undefined ? '' : `-${String(uid)}`}`;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime !== undefined && path.isAbsolute(runtime)) return path.join(runtime, name);
  if (home !== undefined) {
    const own = path.join(path.resolve(home), 'run');
    if (Buffer.byteLength(path.join(own, LONGEST_ADDRESS)) <= SOCKET_PATH_LIMIT) return own;
  }
  return path.join(os.tmpdir(), name);
}

/**
 * Адрес владельца. Windows: имя именованного канала общее для всех сессий машины, а ключ выводится из пути воркспейса, поэтому чужой процесс,
 * занявший имя первым, получит запрос второго запуска или не даст стать владельцем. Windows вне v1 (D-00, строка 7, принято по поручению
 * владельца 2026-11-09), оговорка записана в SAD 3.1 и threat-model §5.6; для поддержки нужен канал с дескриптором безопасности текущего пользователя.
 */
export function instanceAddress(key: string, dir: string = instanceDir()): string {
  return process.platform === 'win32' ? `\\\\.\\pipe\\cyborg-harness-${key}` : path.join(dir, `${key}.sock`);
}

function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  // Чужой или открытый каталог адресов - способ подсунуть сокет: такому каталогу не доверяем.
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error(`${dir}: каталог адресов экземпляров чужой или не каталог`);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Слушатель владельца: одна строка JSON на соединение, ответ - строка `{"ok":true}`. */
function listen(address: string, onAsked: (data: unknown) => void, conns: Set<net.Socket>, plugins: InstanceOptions['plugins']): Promise<net.Server | 'busy'> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      conns.add(conn);
      conn.once('close', () => conns.delete(conn));
      let text = '';
      conn.setEncoding('utf8');
      conn.setTimeout(3000, () => conn.destroy());
      conn.on('error', () => conn.destroy());
      conn.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > MAX_MESSAGE) return void conn.destroy();
        const end = text.indexOf('\n');
        if (end < 0) return;
        let message: unknown;
        try {
          message = JSON.parse(text.slice(0, end));
        } catch {
          // Не JSON: запрос не разобран, но второй процесс висеть не должен.
        }
        if (isQuery(message)) {
          conn.end(`${JSON.stringify({ ok: true, plugins: pluginsOf(plugins) })}\n`);
          return;
        }
        try {
          onAsked(message);
        } catch {
          // Сбой обработчика окна не должен оставлять второй процесс висеть: владелец жив, запрос получил.
        }
        conn.end('{"ok":true}\n');
      });
    });
    // Занятый адрес сообщается то как EADDRINUSE, то как EEXIST (файл сокета появился между проверкой и привязкой).
    server.once('error', (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' || error.code === 'EEXIST' ? resolve('busy') : reject(error)));
    server.listen(address, () => {
      server.removeAllListeners('error');
      // Ошибка принятия соединения (например EMFILE) не должна стать неперехваченной в главном процессе: владелец жив, следующее соединение примет.
      server.on('error', () => undefined);
      if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
      // Сокет не должен удерживать процесс, который собрался выйти.
      server.unref();
      resolve(server);
    });
  });
}

const isQuery = (message: unknown): boolean => typeof message === 'object' && message !== null && (message as Record<string, unknown>)[QUERY_KEY] === QUERY_PLUGINS;

/** Ответ на запрос соседа: список плагинов или `null` («не знаю»: источника нет, он бросил или вернул не список строк). */
function pluginsOf(source: InstanceOptions['plugins']): string[] | null {
  try {
    const list = source?.();
    return Array.isArray(list) && list.every((id): id is string => typeof id === 'string') ? [...list] : null;
  } catch {
    return null;
  }
}

type Answer = 'acked' | 'stale' | 'timeout';

/** Спрашивает владельца по адресу: `stale` - там никто не слушает (файл остался от убитого процесса или исчез). */
function ask(address: string, data: Record<string, unknown> | undefined, timeoutMs: number, onReply?: (line: string) => void): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(address);
    let done = false;
    const finish = (answer: Answer) => {
      if (done) return;
      done = true;
      conn.destroy();
      resolve(answer);
    };
    conn.setEncoding('utf8');
    conn.setTimeout(timeoutMs, () => finish('timeout'));
    conn.once('connect', () => {
      // Проверка живости владельца ничего не просит.
      if (data === undefined) {
        finish('acked');
        return;
      }
      conn.write(`${JSON.stringify(data)}\n`);
    });
    let reply = '';
    const answered = () => {
      if (done) return;
      onReply?.(reply.slice(0, reply.indexOf('\n')));
      finish('acked');
    };
    conn.on('data', (chunk: string) => {
      reply += chunk;
      if (reply.includes('\n')) answered();
    });
    conn.once('close', () => (reply.includes('\n') ? answered() : finish('timeout')));
    conn.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT' || error.code === 'ENOTSOCK') {
        finish('stale');
        return;
      }
      if (!done) {
        done = true;
        conn.destroy();
        reject(error);
      }
    });
  });
}

/** Устаревший файл сокета снимает один процесс: под замком и после повторной проверки, что слушателя нет. */
async function removeStale(address: string, timeoutMs: number, afterStaleCheck: InstanceOptions['afterStaleCheck']): Promise<void> {
  const lock = lockWorkspace(address);
  if (!lock.ok) {
    await sleep(20);
    return;
  }
  try {
    // Файл появляется при `bind`, слушать владелец начинает следующим вызовом: в этот промежуток отказ в соединении
    // не значит, что сокет мёртвый. Сокет моложе порога не снимаем, а ждём, пока владелец закончит запуск.
    let young = false;
    try {
      young = Date.now() - fs.statSync(address).ctimeMs < STARTUP_GRACE_MS;
    } catch {
      // Файла уже нет: снимать нечего, следующая попытка займёт адрес.
    }
    if (young) await sleep(25);
    else if ((await ask(address, undefined, timeoutMs)) === 'stale') {
      await afterStaleCheck?.();
      fs.rmSync(address, { force: true });
    }
  } finally {
    lock.release();
  }
}

/**
 * Занимает экземпляр воркспейса `key` (`workspaceKey` файла). Свободно - процесс становится владельцем и слушает адрес; занято -
 * владельцу уходит `data` (его `onAsked` поднимает окно и решает, что сказать человеку), и процесс получает `handed`.
 */
export async function claimInstance(key: string, data: Record<string, unknown>, onAsked: (data: unknown) => void, options: InstanceOptions = {}): Promise<Claim> {
  const timeoutMs = options.askTimeoutMs ?? 3000;
  const win = process.platform === 'win32';
  const dir = options.dir ?? instanceDir(options.home);
  if (!win) privateDir(dir);
  const address = instanceAddress(key, dir);
  for (let attempt = 0; attempt < 200; attempt++) {
    const conns = new Set<net.Socket>();
    const server = await listen(address, onAsked, conns, options.plugins);
    if (server !== 'busy') {
      return {
        kind: 'owner',
        close: () => {
          server.close();
          // Соединения, не закончившие разговор, закрываются вместе с владельцем.
          for (const conn of conns) conn.destroy();
        },
      };
    }
    const answer = await ask(address, data, timeoutMs);
    if (answer === 'acked') return { kind: 'handed' };
    if (answer === 'timeout') return { kind: 'unresponsive' };
    if (win) await sleep(20);
    else await removeStale(address, timeoutMs, options.afterStaleCheck);
  }
  return { kind: 'unresponsive' };
}

export interface NeighborOptions {
  /** Каталог адресов; по умолчанию личный (см. `instanceDir`). */
  readonly dir?: string;
  readonly home?: string;
  /** Сколько ждать ответа каждого соседа, мс; по умолчанию 3 с. */
  readonly timeoutMs?: number;
}

/**
 * Живые экземпляры других воркспейсов того же каталога адресов и плагины, которые могут работать в их окнах (#154). Каталог пуст или его нет -
 * соседей нет. Адрес, где никто не слушает (файл от убитого процесса), не сосед и пропускается: снимает его claimInstance. Сосед жив, но ответ
 * не получен - `plugins: null`. Windows вне v1 (D-00, строка 7): каналов не перечислить, соседей нет.
 * Окно может открыть плагин сразу после ответа; закрыть это без замка на весь `userData` нельзя (SAD 3.7).
 */
export async function neighborInstances(ownKey: string, options: NeighborOptions = {}): Promise<NeighborInstance[]> {
  if (process.platform === 'win32') return [];
  const dir = options.dir ?? instanceDir(options.home);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const timeoutMs = options.timeoutMs ?? 3000;
  const asked = await Promise.all(
    names
      .filter((name) => name.endsWith('.sock') && name !== `${ownKey}.sock`)
      .map(async (name): Promise<NeighborInstance | undefined> => {
        const key = name.slice(0, -'.sock'.length);
        let line = '';
        let answer: Answer;
        try {
          answer = await ask(path.join(dir, name), { [QUERY_KEY]: QUERY_PLUGINS }, timeoutMs, (text) => (line = text));
        } catch {
          return { key, plugins: null };
        }
        if (answer === 'stale') return undefined;
        return { key, plugins: answer === 'acked' ? pluginsIn(line) : null };
      }),
  );
  return asked.filter((n): n is NeighborInstance => n !== undefined);
}

/** `plugins` из строки ответа; ответ прежнего образца (`{"ok":true}`) списка не несёт. */
function pluginsIn(line: string): string[] | null {
  try {
    const reply = JSON.parse(line) as { plugins?: unknown };
    return Array.isArray(reply.plugins) && reply.plugins.every((id): id is string => typeof id === 'string') ? reply.plugins : null;
  } catch {
    return null;
  }
}
