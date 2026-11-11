// Пул запросов плагина: не больше `limit` задач одновременно, остальные ждут в очереди по порядку. Очередь принадлежит плагину, а не ядру: ядро держит только потолок одновременных
// `process.run` на плагин (LIMITS.runs, 16), сверх которого отказывает `Invalid`, и очереди не ведёт (SAD, 3.7).

interface Waiting {
  readonly go: () => void;
}

export class Pool {
  readonly limit: number;
  readonly #queue: Waiting[] = [];
  #running = 0;
  #peak = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get running(): number {
    return this.#running;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** Наибольшее число задач, шедших одновременно. */
  get peak(): number {
    return this.#peak;
  }

  /**
   * Запускает `task`, когда есть место. Сигнал сработал в очереди - задача уходит из неё и вызывается сразу, не занимая места: она держит тот же сигнал,
   * и `process.run` с сработавшим сигналом отказывает `Cancelled`, не запуская программу. Так отказ несёт настоящий код ядра, а плагин не строит его сам.
   */
  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) return task();
    return new Promise<T>((resolve, reject) => {
      const leave = (): void => {
        const at = this.#queue.indexOf(entry);
        if (at >= 0) this.#queue.splice(at, 1);
        task().then(resolve, reject);
      };
      const entry: Waiting = {
        go: () => {
          signal.removeEventListener('abort', leave);
          this.#running++;
          this.#peak = Math.max(this.#peak, this.#running);
          // Место освобождается до ответа вызывающему: следующая задача из очереди уже идёт, когда он получает результат.
          const release = (): void => {
            this.#running--;
            this.#queue.shift()?.go();
          };
          task().then(
            (value) => {
              release();
              resolve(value);
            },
            (error: unknown) => {
              release();
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- причина задачи отдаётся как есть (у process.run это CoreError)
              reject(error);
            },
          );
        },
      };
      if (this.#running < this.limit) entry.go();
      else {
        this.#queue.push(entry);
        signal.addEventListener('abort', leave, { once: true });
      }
    });
  }
}
