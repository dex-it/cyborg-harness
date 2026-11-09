import type { PtyInfo } from '@cyborg-harness/contracts';

// Типы pty, на которые опираются и таблица (`pty.ts`), и pty-хост (`pty-host.ts`), и канал к нему (`pty-link.ts`), и хост плагинов: лист графа импортов, чтобы они не ходили по кругу.

/** Процесс в псевдотерминале; форма совпадает с IPty из node-pty, так что адаптер Electron отдаёт его как есть. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** Откуда pty-хост берёт процессы (в нём живёт `node-pty`). Запуск может быть асинхронным: за границей процессов `pid` приходит позже. */
export interface PtyBackend {
  spawn(file: string, args: string[], options: { name: string; cwd?: string; env: Record<string, string>; cols: number; rows: number }): PtyProcess | Promise<PtyProcess>;
}

/** Что уходит в хост плагина на spawn и attach: описание плюс хвост вывода. */
export interface PtyWire extends PtyInfo {
  readonly backlog: string;
}
