import { groupKilled, type PtyBackend, type PtyProcess } from '@cyborg-harness/core/pty-host';

// Бэкенд процессов pty поверх `node-pty` для главного процесса (без `ptyHost`) и для процесса pty-хоста.
// Выход процесса `node-pty` доставляет из потока ожидания через `ThreadSafeFunction`. Процесс, вошедший в очистку окружения Node (`app.exit()`, конец выгрузки)
// с недоставленным выходом, вызывает JS-обратный вызов в разрушаемом окружении, тот бросает исключение, а в C++ обработчика нет: `SIGABRT` и окно падения macOS (#185).
// Поэтому бэкенд помнит живые процессы, а `drain()` ждёт их выхода: хост зовёт его на выгрузке ядра, не убивая себя раньше.

type Spawn = PtyBackend['spawn'];

/** То, что бэкенд берёт у `node-pty`. */
export interface NodePtyModule {
  spawn(file: string, args: string[], options: Parameters<Spawn>[2]): PtyProcess;
}

export interface NodePtyBackendOptions {
  /** Загрузка `node-pty` при первом `spawn`, а не при создании бэкенда: главный процесс с pty-хостом `pty.node` не грузит совсем. По умолчанию `import('node-pty')`. */
  readonly load?: () => Promise<NodePtyModule>;
  /** Сигнал процессу и его группе (`groupKilled`); тесту с чужими pid подставляется тождество. */
  readonly group?: (proc: PtyProcess) => PtyProcess;
  /** Сколько `drain` ждёт выход после `kill` хоста, мс, прежде чем добить `SIGKILL`. */
  readonly graceMs?: number;
  /** Сколько `drain` ждёт выход после `SIGKILL`, мс: процесс в неубиваемом сне не держит выгрузку. */
  readonly killWaitMs?: number;
}

const DRAIN_GRACE = 1000;
const DRAIN_KILL_WAIT = 400;

/** Ждёт все `exits` не дольше `ms`; таймер не переживает ожидание. */
async function settled(exits: readonly Promise<void>[], ms: number): Promise<void> {
  if (exits.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(exits),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

export function nodePtyBackend(options: NodePtyBackendOptions = {}): PtyBackend {
  const { load = () => import('node-pty'), group = groupKilled, graceMs = DRAIN_GRACE, killWaitMs = DRAIN_KILL_WAIT } = options;
  let module: Promise<NodePtyModule> | undefined;
  /** Не вышедшие процессы и их выходы. */
  const live = new Map<PtyProcess, Promise<void>>();
  return {
    async spawn(file, args, spawnOptions) {
      module ??= load();
      let node: NodePtyModule;
      try {
        node = await module;
      } catch (error) {
        module = undefined;
        throw error;
      }
      const proc = group(node.spawn(file, args, spawnOptions));
      live.set(
        proc,
        new Promise<void>((resolve) => {
          proc.onExit(() => {
            live.delete(proc);
            resolve();
          });
        }),
      );
      return proc;
    },
    async drain() {
      await settled([...live.values()], graceMs);
      for (const proc of live.keys()) proc.kill('SIGKILL');
      await settled([...live.values()], killWaitMs);
    },
  };
}
