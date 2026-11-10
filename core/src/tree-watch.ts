import { Worker } from 'node:worker_threads';
import { CoreError } from './errors.ts';

// Рекурсивное слежение (`fs.watch(..., { recursive: true })` шлюза) живёт в потоке `node:worker_threads`, а не в главном (#211). На Linux Node ставит inotify на каждый каталог под корнем
// и обслуживает их в JavaScript того же потока: checkout, удаляющий тысячи каталогов, останавливал бы цикл главного процесса на секунды. Поток обходит дерево и разбирает события сам,
// а главному отдаёт готовые пачки имён сообщениями. Контракт шлюза от этого не меняется: имена событий, закрытие и отказ `Unavailable` те же.

/** Сколько мс поток копит имена, прежде чем отдать пачку: тысячи событий лавины уходят единицами сообщений. */
const FLUSH_MS = 20;
/** Имён в одном сообщении: пачка длиннее режется, чтобы разбор одного сообщения в главном потоке был коротким. */
const CHUNK = 2000;
/** Сколько мс поток получает на мирное закрытие, прежде чем его завершат принудительно. */
const CLOSE_GRACE_MS = 1000;

/**
 * Код потока: обычный сценарий CommonJS, который выполняется как строка (`eval`), а не как файл рядом. Так он не зависит от того, как собрано ядро:
 * из исходников `.ts`, из `core/dist` или бандлом приложения (esbuild), где отдельного файла у модуля нет. Зависимости только `node:*`.
 */
const WORKER_SOURCE = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { watch } = require('node:fs');
const FLUSH_MS = ${String(FLUSH_MS)};
const CHUNK = ${String(CHUNK)};
const names = new Set();
let timer;
let watcher;
const flush = () => {
  timer = undefined;
  const list = [...names];
  names.clear();
  for (let i = 0; i < list.length; i += CHUNK) parentPort.postMessage({ type: 'names', names: list.slice(i, i + CHUNK) });
};
const start = () => {
  try {
    watcher = watch(workerData.target, { recursive: true }, (_event, name) => {
      if (!name) return;
      names.add(name);
      timer ??= setTimeout(flush, FLUSH_MS);
    });
  } catch (error) {
    parentPort.postMessage({ type: 'failed', code: error && typeof error.code === 'string' ? error.code : undefined, message: error instanceof Error ? error.message : String(error) });
    return;
  }
  watcher.on('error', (error) => parentPort.postMessage({ type: 'error', message: error.message }));
  parentPort.on('message', (message) => {
    if (message !== 'close') return;
    clearTimeout(timer);
    watcher.close();
    parentPort.close();
  });
  parentPort.postMessage({ type: 'ready' });
};
start();
`;

type FromWorker =
  | { readonly type: 'ready' }
  | { readonly type: 'failed'; readonly code?: string; readonly message: string }
  | { readonly type: 'names'; readonly names: readonly string[] }
  | { readonly type: 'error'; readonly message: string };

/** Поток слежения, уже следящий за деревом. */
export interface TreeWatch {
  /** Останавливает поток. Промис выполняется, когда поток вышел; повторный вызов безвреден. */
  close(): Promise<void>;
}

export interface TreeWatchHandlers {
  /** Пачка имён от корня (в нативном разделителе пути ОС). Зовётся только пока слежение открыто. */
  readonly names: (batch: readonly string[]) => void;
  /** Слежение прервано не по `close`: ошибка наблюдателя, исключение или выход потока. Зовётся один раз, поток уже остановлен. */
  readonly failed: (reason: string) => void;
}

export interface TreeWatchOptions {
  /** Отмена до готовности: поток останавливается, `startTreeWatch` отказывает. */
  readonly signal?: AbortSignal;
  /** Код потока вместо настоящего: для тестов отказов и выхода потока. */
  readonly source?: string;
}

const live = new Set<Worker>();

/** Сколько потоков рекурсивного слежения сейчас живо: для проверок утечек в тестах и диагностики. */
export function activeTreeWatches(): number {
  return live.size;
}

/**
 * Запускает поток, который следит за деревом под `target`, и ждёт, пока слежение поставлено (обход каталогов закончен). Отказ ОС при постановке приходит ошибкой с её кодом
 * (`ENOSPC`, `ENOENT`, `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`), как у синхронного `fs.watch`; падение или выход потока - `Unavailable`.
 */
export function startTreeWatch(target: string, handlers: TreeWatchHandlers, options: TreeWatchOptions = {}): Promise<TreeWatch> {
  return new Promise<TreeWatch>((resolve, reject) => {
    let worker: Worker;
    try {
      // execArgv пустой: поток не должен наследовать флаги главного процесса (--inspect, --test, ...), с ними он иногда не стартует.
      worker = new Worker(options.source ?? WORKER_SOURCE, { eval: true, workerData: { target }, execArgv: [] });
    } catch (error) {
      reject(new CoreError('Unavailable', `не удалось запустить поток рекурсивного слежения: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    live.add(worker);
    let phase: 'starting' | 'ready' | 'closed' = 'starting';
    let grace: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((done) => {
      worker.once('exit', () => {
        live.delete(worker);
        clearTimeout(grace);
        options.signal?.removeEventListener('abort', onAbort);
        done();
        // Поток вышел сам, никто не просил: до готовности это отказ постановки, после - прерванное слежение.
        if (phase !== 'closed') stop(`поток рекурсивного слежения завершился сам`);
      });
    });
    const stop = (reason: string): void => {
      const before = phase;
      phase = 'closed';
      void worker.terminate();
      if (before === 'starting') reject(new CoreError('Unavailable', reason));
      else if (before === 'ready') handlers.failed(reason);
    };
    const handle: TreeWatch = {
      close: () => {
        if (phase !== 'closed') {
          phase = 'closed';
          worker.postMessage('close');
          // Поток, который не откликнулся на закрытие, завершается принудительно.
          grace = setTimeout(() => void worker.terminate(), CLOSE_GRACE_MS);
          grace.unref();
        }
        return exited;
      },
    };
    function onAbort(): void {
      stop('слежение отменено до готовности');
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();
    worker.on('message', (message: FromWorker) => {
      if (phase === 'closed') return;
      switch (message.type) {
        case 'ready':
          if (phase !== 'starting') return;
          phase = 'ready';
          // Открытое слежение не держит процесс: выход приложения не ждёт поток.
          worker.unref();
          resolve(handle);
          return;
        case 'failed': {
          phase = 'closed';
          void worker.terminate();
          reject(Object.assign(new Error(message.message), message.code === undefined ? {} : { code: message.code }));
          return;
        }
        case 'names':
          if (phase === 'ready') handlers.names(message.names);
          return;
        case 'error':
          stop(message.message);
          return;
      }
    });
    worker.on('error', (error: Error) => {
      if (phase !== 'closed') stop(`поток рекурсивного слежения упал: ${error.message}`);
    });
  });
}
