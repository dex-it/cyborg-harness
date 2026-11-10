import type dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { pipeline, Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';

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

function localV4([a = 0, b = 0, c = 0]: readonly number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8: «этот хост», на Linux и macOS соединяется с самим собой
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10: общее адресное пространство провайдеров и VPN
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24: служебные назначения IETF
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24: документация (TEST-NET-1)
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24: документация (TEST-NET-2)
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24: документация (TEST-NET-3)
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15: стенды замеров, в сети не маршрутизируются
    a >= 224 // многоадресные, зарезервированные и 255.255.255.255
  );
}

function localV6(bytes: readonly number[]): boolean {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((x) => x === 0);
  const [b0 = 0, b1 = 0] = bytes;
  // Адреса, в которых лежит IPv4: стоит вести себя как с ним, иначе `::ffff:127.0.0.1` обходит правило.
  if (zeros(0, 12)) return localV4(bytes.slice(12)); // ::/96, в том числе :: и ::1
  if (zeros(0, 8) && bytes[8] === 255 && bytes[9] === 255 && bytes[10] === 0 && bytes[11] === 0) return true; // ::ffff:0:0:0/96: трансляция IPv4 в IPv6 (RFC 2765), адрес в сети не маршрутизируется
  if (zeros(0, 10) && bytes[10] === 255 && bytes[11] === 255) return localV4(bytes.slice(12)); // ::ffff:0:0/96
  if (b0 === 0 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return localV4(bytes.slice(12)); // 64:ff9b::/96, NAT64
  if (b0 === 0 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0 && bytes[5] === 1) return true; // 64:ff9b:1::/48: локальный NAT64 (RFC 8215), адрес не несёт публичный IPv4
  if (b0 === 0x20 && b1 === 0x02) return localV4(bytes.slice(2, 6)); // 2002::/16, 6to4
  const [b2 = 0, b3 = 0] = bytes.slice(2);
  return (
    (b0 === 0x01 && b1 === 0 && zeros(2, 8)) || // 100::/64: только сброс (RFC 6666)
    (b0 === 0x20 && b1 === 0x01 && b2 === 0 && b3 === 0) || // 2001::/32: Teredo, в адрес зашит IPv4 сервера и клиента
    (b0 === 0x20 && b1 === 0x01 && b2 === 0 && b3 === 0x02 && bytes[4] === 0 && bytes[5] === 0) || // 2001:2::/48: стенды замеров (RFC 5180)
    (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) || // 2001:db8::/32: документация
    (b0 === 0x3f && b1 === 0xff && (b2 & 0xf0) === 0) || // 3fff::/20: документация (RFC 9637)
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
      const refusal = addresses.reduce<Error | undefined>((found, a) => found ?? refuse(a.address), undefined);
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
  /** Локальный адрес этому запросу разрешён: пул соединений у таких запросов свой, см. `poolFor`. */
  readonly local: boolean;
  /** Чей запрос (id плагина): пулы соединений у плагинов свои, чужой запрос не пойдёт по сокету этого. */
  readonly owner: string;
}

const pools = new Map<string, http.Agent | https.Agent>();

/**
 * Пул соединений по плагину, протоколу и режиму проверки. Соединение, открытое без проверки адреса (хост назван в праве),
 * не должно обслужить запрос с проверкой, а сокет одного плагина - запрос другого (ADR-CH-0014 п. 4: секрет не проходит через третьих).
 * Простаивающие сокеты агент не держит живыми для процесса.
 */
function poolFor(secure: boolean, local: boolean, owner: string): http.Agent | https.Agent {
  const key = `${owner}\0${secure ? 'https' : 'http'}\0${local ? 'named' : 'checked'}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
    pools.set(key, pool);
  }
  return pool;
}

/** Плагин выгружен: его соединения закрываются, пулы уходят. */
export function closePools(owner: string): void {
  for (const [key, pool] of pools) {
    if (!key.startsWith(`${owner}\0`)) continue;
    pool.destroy();
    pools.delete(key);
  }
}

/**
 * Заголовки разметки сообщения и соединения задаёт `node:http`, а не плагин: `content-length` не по телу оставил бы в keep-alive сокете
 * хвост - начало чужого запроса. `host` - это хост из права, по которому запрос проверен; свой `host` отправил бы запрос на другой виртуальный хост.
 */
const FRAMING = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection', 'host']);

/** Статусы без тела: конструктор `Response` отвергает тело при них. */
const NO_BODY = new Set([101, 204, 205, 304]);

const LENIENT = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };

/** Звеньев `content-encoding` больше этого - отказ: цепочка из сотен звеньев - способ раздуть работу распаковки (как предел у undici). */
const MAX_CODINGS = 4;

type Decoder = zlib.Gunzip | zlib.BrotliDecompress | zlib.ZstdDecompress | Transform;

/**
 * `deflate` в HTTP - то zlib-обёртка (RFC 1950), то сырой поток (так отвечают старые серверы). Различает первый байт, как в undici:
 * у zlib младшие четыре бита - способ сжатия 8.
 */
function inflateAuto(): Transform {
  let inner: zlib.Inflate | zlib.InflateRaw | undefined;
  const out: Transform = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!inner) {
        const stream = ((chunk[0] ?? 0) & 0x0f) === 8 ? zlib.createInflate(LENIENT) : zlib.createInflateRaw(LENIENT);
        stream.on('data', (part: Buffer) => {
          if (!out.push(part)) stream.pause();
        });
        stream.on('error', (error) => out.destroy(error));
        inner = stream;
      }
      inner.write(chunk, (error) => done(error));
    },
    read() {
      inner?.resume();
    },
    flush(done) {
      if (!inner) return done();
      inner.once('end', () => done());
      inner.end();
    },
  });
  return out;
}

/**
 * Распаковка ответа, который сервер сжал вопреки `accept-encoding: identity`; предел размера - у читающего тело.
 * Конец потока без полного блока - как у прежнего fetch (undici): пустое тело при `content-encoding` (HEAD, S3-объект) не ошибка.
 * Кодировки накладываются слева направо, снимаются справа налево; повторные заголовки node уже склеил через запятую.
 * Возвращает звенья в порядке снятия; `undefined` - есть кодировка, которой ядро не знает, тело уходит как есть, заголовок остаётся.
 * Звеньев больше `MAX_CODINGS` - ошибка.
 */
function decodersFor(header: string): Decoder[] | undefined {
  const codings = header.split(',').map((c) => c.trim().toLowerCase()).filter((c) => c !== '' && c !== 'identity');
  if (codings.length > MAX_CODINGS) throw new Error(`content-encoding: звеньев ${String(codings.length)}, предел ${String(MAX_CODINGS)}`);
  const decoders: Decoder[] = [];
  for (const coding of codings.reverse()) {
    switch (coding) {
      case 'gzip':
      case 'x-gzip':
        decoders.push(zlib.createGunzip(LENIENT));
        break;
      case 'deflate':
        decoders.push(inflateAuto());
        break;
      case 'br':
        decoders.push(zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }));
        break;
      case 'zstd':
        decoders.push(zlib.createZstdDecompress({ flush: zlib.constants.ZSTD_e_flush, finishFlush: zlib.constants.ZSTD_e_flush }));
        break;
      default:
        for (const made of decoders) made.destroy();
        return undefined;
    }
  }
  return decoders;
}

/** Запрос по `node:http(s)`, чтобы резолв шёл через свой `lookup`; ответ - обычный `Response`. Переадресация не идёт. */
export function transport(url: URL, init: TransportRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const send = secure ? https.request : http.request;
    const own = Object.entries(init.headers).flatMap(([k, v]): [string, string][] => (FRAMING.has(k.toLowerCase()) ? [] : [[k.toLowerCase(), v]]));
    // identity после заголовков плагина: сжатое тело пришло бы текстом-мусором.
    const headers = { accept: '*/*', 'user-agent': 'node', ...Object.fromEntries(own), 'accept-encoding': 'identity' };
    const request = send(url, { method: init.method, headers, signal: init.signal, lookup: init.lookup, agent: poolFor(secure, init.local, init.owner) }, (incoming) => {
      // Ответ сервера - чужие данные: `Response` бросает на статусе вне 200-599, и брошенное здесь ушло бы мимо промиса в процесс.
      try {
        const out = new Headers();
        for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) out.append(incoming.rawHeaders[i] ?? '', incoming.rawHeaders[i + 1] ?? '');
        const status = incoming.statusCode ?? 502;
        if (NO_BODY.has(status)) incoming.resume();
        const decoders = NO_BODY.has(status) ? undefined : decodersFor(incoming.headers['content-encoding'] ?? '');
        const last = decoders?.at(-1);
        if (decoders && last) {
          out.delete('content-encoding');
          out.delete('content-length');
          pipeline([incoming, ...decoders], () => undefined);
        }
        const source = last ?? incoming;
        resolve(new Response(NO_BODY.has(status) ? null : (Readable.toWeb(source) as ReadableStream<Uint8Array>), { status, statusText: incoming.statusMessage ?? '', headers: out }));
      } catch (error) {
        incoming.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.once('error', reject);
    request.end(init.body);
  });
}
