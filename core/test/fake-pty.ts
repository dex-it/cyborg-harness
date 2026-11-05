import type { PtyBackend, PtyProcess } from '../src/pty.ts';

export interface FakeProc extends PtyProcess {
  readonly file: string;
  readonly args: string[];
  readonly options: { cwd?: string; env: Record<string, string>; cols: number; rows: number };
  readonly writes: string[];
  readonly resizes: [number, number][];
  killed?: string;
  emit(data: string): void;
  exit(code: number): void;
}

/** Псевдотерминал без ОС: тест сам пишет вывод и завершает процесс. */
export function fakePty(): PtyBackend & { procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  return {
    procs,
    spawn(file, args, options) {
      const data = new Set<(d: string) => void>();
      const exits = new Set<(e: { exitCode: number; signal?: number }) => void>();
      const proc: FakeProc = {
        pid: 1000 + procs.length,
        file,
        args,
        options,
        writes: [],
        resizes: [],
        onData: (l) => (data.add(l), { dispose: () => data.delete(l) }),
        onExit: (l) => (exits.add(l), { dispose: () => exits.delete(l) }),
        write: (d) => void proc.writes.push(d),
        resize: (c, r) => void proc.resizes.push([c, r]),
        kill(signal) {
          proc.killed = signal ?? 'SIGHUP';
        },
        emit: (d) => {
          for (const l of data) l(d);
        },
        exit: (code) => {
          for (const l of exits) l({ exitCode: code });
        },
      };
      procs.push(proc);
      // Вывод сразу после запуска: проверяет, что хост не теряет его до подписки плагина.
      setImmediate(() => proc.emit('$ '));
      return proc;
    },
  };
}
