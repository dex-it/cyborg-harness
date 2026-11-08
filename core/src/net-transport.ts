import type dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';

/** Резолв имени; подменяется в тестах и в средах со своим резолвером. */
export type Lookup = typeof dns.lookup;

function v4Bytes(text: string): number[] | undefined {
  if (!net.isIPv4(text)) return undefined;
  return text.split('.').map(Number);
}

function v6Bytes(text: string): number[] | undefined {
  let rest = text.split('%')[0] ?? '';
  if (!net.isIPv6(rest)) return undefined;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(rest)?.[1];
  if (tail !== undefined) {
    const v4 = v4Bytes(tail);
    if (!v4) return undefined;
    rest = `${rest.slice(0, -tail.length)}${(((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16)}:${(((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16)}`;
  }
  const halves = rest.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const end = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - end.length).fill('0'), ...end] : head;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
}

function localV4([a = 0, b = 0]: readonly number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8: «этот хост», на Linux и macOS соединяется с самим собой
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10: общее адресное пространство провайдеров и VPN
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // многоадресные, зарезервированные и 255.255.255.255
  );
}

function localV6(bytes: readonly number[]): boolean {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((x) => x === 0);
  const [b0 = 0, b1 = 0] = bytes;
  // Адреса, в которых лежит IPv4: стоит вести себя как с ним, иначе `::ffff:127.0.0.1` обходит правило.
  if (zeros(0, 12)) return localV4(bytes.slice(12)); // ::/96, в том числе :: и ::1
  if (zeros(0, 10) && bytes[10] === 255 && bytes[11] === 255) return localV4(bytes.slice(12)); // ::ffff:0:0/96
  if (b0 === 0 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return localV4(bytes.slice(12)); // 64:ff9b::/96, NAT64
  if (b0 === 0x20 && b1 === 0x02) return localV4(bytes.slice(2, 6)); // 2002::/16, 6to4
  return (
    (b0 & 0xfe) === 0xfc || // fc00::/7
    (b0 === 0xfe && (b1 & 0xc0) >= 0x80) || // fe80::/10 и устаревший fec0::/10
    b0 === 0xff // многоадресные
  );
}

/** Локальный, частный или служебный адрес. Не разобралось как адрес - тоже «да»: отказать безопаснее. */
export function isLocalAddress(address: string): boolean {
  const bytes = net.isIPv4(address) ? v4Bytes(address) : v6Bytes(address);
  if (bytes === undefined) return true;
  return bytes.length === 4 ? localV4(bytes) : localV6(bytes);
}

/**
 * Резолв для соединения: `refuse` видит каждый адрес ответа и возвращает ошибку отказа.
 * Проверка стоит в самом соединении, а не перед ним: второй запрос DNS между проверкой и соединением дал бы другой адрес.
 */
export function guardedLookup(real: Lookup, refuse: (address: string) => Error | undefined): net.LookupFunction {
  return (hostname, options, callback) => {
    real(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      // Один недопустимый адрес в ответе - отказ целиком: иначе соединение выбрало бы его из списка.
      const refusal = addresses.map((a) => refuse(a.address)).find((e) => e !== undefined);
      const first = addresses[0];
      if (refusal) callback(refusal, '', 0);
      else if (options.all) callback(null, addresses);
      else if (first) callback(null, first.address, first.family);
      else callback(Object.assign(new Error(`${hostname}: адресов нет`), { code: 'ENOTFOUND' }), '', 0);
    });
  };
}

export interface TransportRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly lookup: net.LookupFunction;
}

/** Статусы без тела: конструктор `Response` отвергает тело при них. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** Запрос по `node:http(s)`, чтобы резолв шёл через свой `lookup`; ответ - обычный `Response`. Переадресация не идёт. */
export function transport(url: URL, init: TransportRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? https.request : http.request;
    const headers = { accept: '*/*', 'user-agent': 'node', 'accept-encoding': 'identity', ...Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])) };
    // Без общего пула: сокет, открытый для одного права, не должен обслужить другое, у которого свои правила резолва.
    const request = send(url, { method: init.method, headers, signal: init.signal, lookup: init.lookup, agent: false }, (incoming) => {
      const out = new Headers();
      for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) out.append(incoming.rawHeaders[i] ?? '', incoming.rawHeaders[i + 1] ?? '');
      const status = incoming.statusCode ?? 502;
      if (NO_BODY.has(status)) incoming.resume();
      resolve(new Response(NO_BODY.has(status) ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, statusText: incoming.statusMessage ?? '', headers: out }));
    });
    request.once('error', reject);
    request.end(init.body);
  });
}
