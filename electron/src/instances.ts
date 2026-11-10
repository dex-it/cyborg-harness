// Несколько экземпляров приложения с общим `userData` (K-20): чистые части, без Electron. Подключение к `app` - в window.ts и restarts.ts.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claimInstance, workspaceKey, type Claim } from '@cyborg-harness/core';
import type { RestartFlags } from './restarts.ts';

/** Каталог сессии окна без воркспейса (и префикс его ключа экземпляра): такое окно в `userData` одно. */
export const NO_WORKSPACE_KEY = 'no-workspace';

/**
 * Ключ, по которому процессы узнают друг друга. Воркспейс - его `workspaceKey` (тот же `realpath`, что у замка и `state`), не зависящий от `userData`;
 * но адрес лежит в каталоге адресов, а без `XDG_RUNTIME_DIR` это `<userData>/run`, и приложения с разными `userData` друг друга не находят - второе
 * упирается в общий замок воркспейса. Окно без воркспейса - ключ своего `userData`: окна без воркспейса двух приложений друг друга не касаются.
 */
export const instanceKey = (workspaceFile: string | undefined, userData: string): string =>
  workspaceFile === undefined ? `${NO_WORKSPACE_KEY}-${createHash('sha256').update(realOf(userData)).digest('hex').slice(0, 12)}` : workspaceKey(workspaceFile);

const realOf = (dir: string): string => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/**
 * Каталог сессии Chromium (localStorage, IndexedDB, кэш, cookies) этого воркспейса: `<userData>/workspaces/<ключ>`.
 * Два процесса на одном каталоге сессии борются за замки LevelDB; `userData` остаётся общим для файлов приложения.
 * Назначается через `app.setPath('sessionData', …)` до готовности приложения.
 */
export const sessionDataDir = (userData: string, workspaceFile: string | undefined): string => path.join(userData, 'workspaces', workspaceFile === undefined ? NO_WORKSPACE_KEY : workspaceKey(workspaceFile));

// Порты отладки принадлежат процессу: второй с тем же портом не поднялся бы.
const PER_PROCESS = [/^--inspect(?:-brk|-port)?(?:=|$)/, /^--remote-debugging-(?:port|pipe)(?:=|$)/];

/** Аргументы процесса «в новом окне»: текущие без флагов воркспейса и отладки, плюс `--workspace=<файл>`. */
export function newWindowArgs(argv: readonly string[], file: string, flags: RestartFlags): string[] {
  const keep = argv.filter((a) => a !== flags.noWorkspace && !a.startsWith(flags.workspace) && !PER_PROCESS.some((re) => re.test(a)));
  return [...keep, `${flags.workspace}${file}`];
}

/**
 * Занимает экземпляр воркспейса (`claimInstance` ядра): адреса в личном каталоге (`XDG_RUNTIME_DIR` или `<userData>/run`). Отказ контроля
 * экземпляров (каталог адресов чужой или не создаётся, ошибка сокета) не оставляет процесс без окна: причина уходит в `onUnavailable`, процесс
 * становится владельцем без адреса. Данные при этом целы: их по-прежнему держит замок воркспейса; теряется только поднятие окна повторным запуском.
 */
export async function claimWorkspace(
  userData: string,
  workspaceFile: string | undefined,
  data: Record<string, unknown>,
  onSecond: (data: unknown) => void,
  onUnavailable?: (error: Error) => void,
): Promise<Claim> {
  try {
    return await claimInstance(instanceKey(workspaceFile, userData), data, onSecond, { home: userData });
  } catch (error) {
    onUnavailable?.(error instanceof Error ? error : new Error(String(error)));
    return { kind: 'owner', close: () => undefined };
  }
}
