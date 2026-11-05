import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServeRequest } from '@cyborg/contracts';
import { CoreError } from './errors.ts';
import { isRecord } from './wire.ts';

export const MAX_SERVERS = 4;
export const MAX_REQUEST_BODY = 1024 * 1024;
export const SERVE_TIMEOUT_MS = 30_000;
// Длину и кодирование тела считает сервер: плагин, задав их, рассогласовал бы ответ с телом.
const OWN_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** Запрос уходит в хост плагина и возвращается ответом; хоста нет - отказ. */
export type AskHost = (pluginId: string, params: { pluginId: string; id: string; request: ServeRequest }) => Promise<unknown>;

/** Серверы HTTP плагинов с правом `serve`: только 127.0.0.1, порт от ОС, свой Host и запрос без Origin. */
export class HttpServes {
  readonly #servers = new Map<string, Server | null>();
  readonly #ask: AskHost;
  readonly #timeoutMs: number;

  constructor(ask: AskHost, timeoutMs = SERVE_TIMEOUT_MS) {
    this.#ask = ask;
    this.#timeoutMs = timeoutMs;
  }

  async open(pluginId: string, id: string): Promise<string> {
    const key = `${pluginId}\0${id}`;
    if (this.#servers.has(key)) throw new CoreError('Invalid', `serve.http: id ${id} уже занят`);
    if (this.#count(pluginId) >= MAX_SERVERS) throw new CoreError('Invalid', `serve.http: больше ${String(MAX_SERVERS)} серверов`);
    // Место занято до await: выгрузка посреди listen закроет сервер, а не оставит его без владельца.
    this.#servers.set(key, null);
    let port = 0;
    const server = createServer((req, res) => void this.#one(pluginId, id, port, req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    }).catch((error: unknown) => {
      this.#servers.delete(key);
      throw new CoreError('Unavailable', `serve.http: ${error instanceof Error ? error.message : String(error)}`);
    });
    port = (server.address() as AddressInfo).port;
    if (!this.#servers.has(key)) {
      server.close();
      throw new CoreError('Unavailable', 'serve.http: плагин выгружен');
    }
    this.#servers.set(key, server);
    return `http://127.0.0.1:${String(port)}`;
  }

  close(pluginId: string, id: string): void {
    const key = `${pluginId}\0${id}`;
    const server = this.#servers.get(key);
    this.#servers.delete(key);
    if (server) {
      server.close();
      server.closeAllConnections();
    }
  }

  forget(pluginId: string): void {
    for (const key of [...this.#servers.keys()]) if (key.startsWith(`${pluginId}\0`)) this.close(pluginId, key.slice(pluginId.length + 1));
  }

  #count(pluginId: string): number {
    return [...this.#servers.keys()].filter((k) => k.startsWith(`${pluginId}\0`)).length;
  }

  async #one(pluginId: string, id: string, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, headers: Record<string, string> = {}, body = '') => {
      if (!res.headersSent) res.writeHead(status, { ...headers, 'content-length': String(Buffer.byteLength(body)) }).end(body);
    };
    // Чужой Host - подмена DNS, Origin - запрос со страницы в браузере: ни то, ни другое не клиент плагина.
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${String(port)}` && host !== `localhost:${String(port)}`) {
      reply(421);
      return;
    }
    if (req.headers.origin !== undefined) {
      reply(403);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_REQUEST_BODY) {
          reply(413, { connection: 'close' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      // Клиент оборвал тело: отвечать некому, а отказ ушёл бы необработанным в главный процесс.
      req.destroy();
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : Array.isArray(v) ? [[k, v.join(', ')]] : [])));
    const request: ServeRequest = { method: req.method ?? 'GET', path: req.url ?? '/', headers, body: Buffer.concat(chunks).toString('utf8') };
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        this.#ask(pluginId, { pluginId, id, request }),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new CoreError('Timeout', 'serve.http: обработчик не ответил')), this.#timeoutMs))),
      ]);
      const r = readResponse(answer);
      reply(r.status, r.headers, r.body);
    } catch (error) {
      reply(error instanceof CoreError && error.code === 'Timeout' ? 504 : 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Чужая форма ответа - 502, а не то, что плагин успел насобирать. */
function readResponse(raw: unknown): { status: number; headers: Record<string, string>; body: string } {
  if (!isRecord(raw) || typeof raw.status !== 'number' || !Number.isInteger(raw.status) || raw.status < 200 || raw.status > 599) throw new CoreError('Invalid', 'serve.http: ответ без status 200-599');
  const headers = isRecord(raw.headers)
    ? Object.fromEntries(Object.entries(raw.headers).filter((e): e is [string, string] => typeof e[1] === 'string' && !OWN_HEADERS.has(e[0].toLowerCase()) && !/[\r\n]/.test(e[1])))
    : {};
  if (raw.body !== undefined && typeof raw.body !== 'string') throw new CoreError('Invalid', 'serve.http: тело ответа не строка');
  return { status: raw.status, headers, body: raw.body ?? '' };
}
