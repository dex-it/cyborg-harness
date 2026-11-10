import { execFileSync } from 'node:child_process';

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Предел времени вызова, мс. По нему команда убивается SIGKILL: зависшая npm или tsc не должна держать весь `npm test` до отмены задания CI. */
  readonly timeout?: number;
}

const DEFAULT_TIMEOUT = 90_000;

/**
 * Внешняя команда теста с пределом времени. Ненулевой выход - результат `{ code, out }`; зависание, сигнал и отсутствие программы - ошибка,
 * в сообщении которой команда, каталог и весь вывод до отказа (без него падение npm на CI не разобрать).
 */
export function tryCommand(cmd: string, args: readonly string[], { cwd, env, timeout = DEFAULT_TIMEOUT }: CommandOptions = {}): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { ...(cwd !== undefined && { cwd }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(env && { env: { ...process.env, ...env } }), timeout, killSignal: 'SIGKILL' });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number | null; signal?: string | null; code?: string; message: string; stdout?: string; stderr?: string };
    if (typeof e.status === 'number') return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    throw failure(cmd, args, cwd, e, error);
  }
}

/** Как `tryCommand`, но ненулевой выход тоже ошибка с выводом. Возвращает stdout. */
export function runCommand(cmd: string, args: readonly string[], options: CommandOptions = {}): string {
  const { code, out } = tryCommand(cmd, args, options);
  if (code !== 0) throw new Error(`${describe(cmd, args, options.cwd)}: код выхода ${String(code)}\n--- вывод\n${out}`);
  return out;
}

const describe = (cmd: string, args: readonly string[], cwd: string | undefined): string => `${cmd} ${args.join(' ')}${cwd !== undefined ? ` (cwd ${cwd})` : ''}`;

function failure(cmd: string, args: readonly string[], cwd: string | undefined, e: { code?: string; signal?: string | null; message: string; stdout?: string; stderr?: string }, cause: unknown): Error {
  return new Error(`${describe(cmd, args, cwd)}: ${e.code ?? e.signal ?? ''} ${e.message}\n--- stdout\n${e.stdout ?? ''}\n--- stderr\n${e.stderr ?? ''}`, { cause });
}
