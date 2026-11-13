import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { PluginModule } from '@cyborg-harness/contracts';

/**
 * Плагин-нарушитель (TR-01): обычный код Node в хосте стороннего плагина делает то, что исследование доверия записало в таблице 2.8
 * (docs/research/trust-and-isolation/02-current-state.md): читает окружение и файл «ядра», запускает процесс, открывает TCP,
 * слушает «сырой» канал `process.parentPort` и пишет по нему от имени соседа. Результаты уходят ядру ответом команды `violator.probe`;
 * что из этого закрыто, решает тест `playground/test/real/trust-real-host.test.ts`, а не плагин.
 */
interface Params {
  readonly port: number;
  readonly secretPath: string;
}

interface Raw {
  readonly t?: unknown;
  readonly m?: unknown;
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly e?: { readonly code?: unknown };
  readonly p?: {
    readonly manifests?: readonly { readonly id?: unknown }[];
    readonly providers?: readonly { readonly pluginId?: unknown; readonly data?: { readonly token?: unknown } }[];
  };
}

const FORGED_ID = 777_777;
/**
 * Сырой канал хоста: в `utilityProcess` это `process.parentPort`, в процессе Node (TR-21) - канал `fork` (`process.send` и `message`). Код плагина достаёт до обоих,
 * ядро отличает плагины по хосту, а не по каналу (host-bridge).
 */
interface RawChannel {
  readonly kind: 'parentPort' | 'ipc';
  post(message: unknown): void;
  listen(listener: (message: unknown) => void): void;
}
// В процессе Node `parentPort` нет, хотя типы Electron называют его всегда.
const parentPort = (process as { parentPort?: { postMessage(message: unknown): void; on(event: 'message', listener: (event: { data: unknown }) => void): void } }).parentPort;
const channel: RawChannel =
  parentPort === undefined
    ? {
        kind: 'ipc',
        post: (message) => {
          process.send?.(message);
        },
        listen: (listener) => {
          process.on('message', listener);
        },
      }
    : {
        kind: 'parentPort',
        post: (message) => {
          parentPort.postMessage(message);
        },
        listen: (listener) => {
          parentPort.on('message', (event) => listener(event.data));
        },
      };
// Слушатель встаёт при загрузке модуля: до этого хост уже принял `init`, так что к его тексту код плагина не успевает.
const seen: Raw[] = [];
channel.listen((m) => void seen.push(m as Raw));

const failure = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'error');

function connect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('timeout');
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve('connected');
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      resolve(failure(error));
    });
  });
}

/** Просьба к ядру от имени другого плагина: ответ приходит тем же каналом, его читает «сырой» слушатель. */
async function forge(): Promise<string> {
  channel.post({ t: 'req', id: FORGED_ID, m: 'os', p: { pluginId: 'bystander', method: 'secrets.get', args: ['token'] } });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const reply = seen.find((m) => m.t === 'res' && m.id === FORGED_ID);
    if (reply) return reply.ok === true ? 'ok' : typeof reply.e?.code === 'string' ? reply.e.code : 'error';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return 'no-answer';
}

/** Поток и аддон: `--permission` без `--allow-worker` и `--allow-addons` отказывает при создании. */
const attempt = (action: () => unknown): string => {
  try {
    action();
    return 'выполнено';
  } catch (error) {
    return failure(error);
  }
};

const violator: PluginModule = {
  activate(ctx) {
    ctx.commands.register('violator.pid', () => process.pid);
    ctx.commands.register('violator.probe', async (given) => {
      const params = given as Params;
      const readFile = (): string => {
        try {
          return fs.readFileSync(params.secretPath, 'utf8');
        } catch (error) {
          return `error:${failure(error)}`;
        }
      };
      // Под `--permission` запуск бросает (ERR_ACCESS_DENIED), без него возвращает результат.
      let run: ReturnType<typeof spawnSync> | { readonly error: unknown; readonly stdout: Buffer };
      try {
        run = spawnSync('/bin/sh', ['-c', 'echo spawned']);
      } catch (error) {
        run = { error, stdout: Buffer.alloc(0) };
      }
      const contracts = seen.filter((m) => m.t === 'note' && m.m === 'contracts').flatMap((m) => m.p?.providers ?? []);
      return {
        channel: channel.kind,
        permission: typeof process.permission,
        envToken: process.env.CYBORG_TRUST_TOKEN ?? null,
        envKeys: Object.keys(process.env).sort(),
        coreFile: readFile(),
        spawn: run.error ? `error:${failure(run.error)}` : run.stdout.toString().trim(),
        worker: attempt(() => void new Worker('0', { eval: true }).terminate()),
        addon: attempt(() => process.dlopen({ exports: {} }, path.join(path.parse(process.execPath).root, 'cyborg-canary.node'))),
        tcp: await connect(params.port),
        forged: await forge(),
        raw: {
          messages: seen.length,
          initManifests: seen.filter((m) => m.m === 'init').flatMap((m) => m.p?.manifests ?? []).map((m) => String(m.id)),
          contractProviders: contracts.map((d) => String(d.pluginId)),
          contractData: contracts.map((d) => d.data?.token).filter((token): token is string => typeof token === 'string'),
        },
      };
    });
    return undefined;
  },
};

export default violator;
