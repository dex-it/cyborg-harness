import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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
  /** Каталог адреса (unix-сокет); по умолчанию личный каталог в `XDG_RUNTIME_DIR` или `tmpdir`. На Windows адрес - именованный канал. */
  readonly dir?: string;
  /** Сколько ждать ответа владельца, мс; по умолчанию 3 с. */
  readonly askTimeoutMs?: number;
}

const MAX_MESSAGE = 64 * 1024;
const STARTUP_GRACE_MS = 500;

/** Каталог адресов: личный, не общий. Длинный путь `userData` в адрес сокета не годится (предел около 104 байт на macOS). */
export function instanceDir(): string {
  const uid = process.getuid?.();
  // XDG Base Directory: пустое или относительное значение недействительно, иначе каталог адресов окажется в текущем каталоге процесса.
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime !== undefined && path.isAbsolute(runtime) ? runtime : os.tmpdir();
  return path.join(base, `cyborg-harness${uid === undefined ? '' : `-${String(uid)}`}`);
}

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
function listen(address: string, onAsked: (data: unknown) => void, conns: Set<net.Socket>): Promise<net.Server | 'busy'> {
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
        try {
          onAsked(JSON.parse(text.slice(0, end)));
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
      if (process.platform !== 'win32') fs.chmodSync(address, 0o600);
      // Сокет не должен удерживать процесс, который собрался выйти.
      server.unref();
      resolve(server);
    });
  });
}

type Answer = 'acked' | 'stale' | 'timeout';

/** Спрашивает владельца по адресу: `stale` - там никто не слушает (файл остался от убитого процесса или исчез). */
function ask(address: string, data: Record<string, unknown> | undefined, timeoutMs: number): Promise<Answer> {
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
    conn.on('data', (chunk: string) => {
      reply += chunk;
      if (reply.includes('\n')) finish('acked');
    });
    conn.once('close', () => finish(reply.includes('\n') ? 'acked' : 'timeout'));
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
async function removeStale(address: string, timeoutMs: number): Promise<void> {
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
    else if ((await ask(address, undefined, timeoutMs)) === 'stale') fs.rmSync(address, { force: true });
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
  const dir = options.dir ?? instanceDir();
  if (!win) privateDir(dir);
  const address = instanceAddress(key, dir);
  for (let attempt = 0; attempt < 200; attempt++) {
    const conns = new Set<net.Socket>();
    const server = await listen(address, onAsked, conns);
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
    else await removeStale(address, timeoutMs);
  }
  return { kind: 'unresponsive' };
}
