import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sandbox, type Sandbox } from '@cyborg-harness/testing';

// Общая фикстура подставных gh, glab и jira (PL-07): обёртки в PATH запускают playground/scripts/fake-trackers.mjs, журнал ведёт сама программа, независимо от плагина.
// Живые процессы и внуки читаются из журнала и каталога `live/`; «сирота» - pid, который ещё отвечает на `kill(pid, 0)` после отмены, тайм-аута или выгрузки.

const FAKE = path.join(import.meta.dirname, '..', 'scripts', 'fake-trackers.mjs');

export interface Behavior {
  readonly mode?: 'ok' | 'hang' | 'deaf' | 'big' | 'badjson' | 'login' | 'exit';
  /** Задержка ответа `ok`, мс. */
  readonly ms?: number;
  /** Число записей в ответе `ok`. */
  readonly count?: number;
  /** Размер JSON `big`, байт. */
  readonly bytes?: number;
  readonly code?: number;
  readonly stderr?: string;
  /** Программа запускает внука (он остаётся в группе процессов). */
  readonly child?: boolean;
}

export interface Scenario {
  readonly default?: Behavior;
  /** Первое правило, чья `match` входит в строку аргументов, определяет поведение. */
  readonly rules?: readonly (Behavior & { readonly match: string })[];
}

export interface FakeCall {
  readonly pid: number;
  readonly tool: string;
  readonly args: readonly string[];
  /** Сколько программ (с этой) было живо в момент старта. */
  readonly live: number;
  readonly cwd: string;
  readonly env: { readonly GH_PROMPT_DISABLED: string | null; readonly NO_COLOR: string | null };
}

export interface FakeTrackers {
  /** Каталог с обёртками `gh`, `glab`, `jira`: ставится в начало PATH плагина. */
  readonly bin: string;
  scenario(next: Scenario): Promise<void>;
  calls(): Promise<FakeCall[]>;
  /** Наибольшее число одновременно живых программ по журналу самих программ. */
  peak(): Promise<number>;
  /** pid внуков, которых запускали программы. */
  children(): Promise<number[]>;
  /** Из pid программ и внуков те, что ещё живы. */
  survivors(): Promise<number[]>;
  /** Добивает оставшихся: тест не оставляет процессов, даже упав. */
  cleanup(): Promise<void>;
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const lines = async <T>(file: string): Promise<T[]> => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

export async function fakeTrackers(box: Sandbox): Promise<FakeTrackers> {
  const dir = box.path('fake-trackers');
  const bin = box.path('fake-bin');
  await mkdir(dir, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const tool of ['gh', 'glab', 'jira']) {
    await writeFile(path.join(bin, tool), `#!/bin/sh\nFAKE_TRACKERS_DIR='${dir}' exec '${process.execPath}' '${FAKE}' ${tool} "$@"\n`);
    await chmod(path.join(bin, tool), 0o755);
  }
  const calls = () => lines<FakeCall>(path.join(dir, 'calls.log'));
  const children = async () => (await lines<{ pid: number }>(path.join(dir, 'children.log'))).map((c) => c.pid);
  const pids = async () => [...(await calls()).map((c) => c.pid), ...(await children())];
  return {
    bin,
    scenario: (next) => writeFile(path.join(dir, 'scenario.json'), JSON.stringify(next)),
    calls,
    peak: async () => Math.max(0, ...(await calls()).map((c) => c.live)),
    children,
    survivors: async () => (await pids()).filter(isAlive),
    cleanup: async () => {
      for (const pid of await pids()) if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    },
  };
}

export { sandbox };
