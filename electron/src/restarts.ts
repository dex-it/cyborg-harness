// Смена воркспейса и безопасного режима: перезапуск приложения; воркспейс «в новом окне» - ещё один процесс (K-20).
// Один экземпляр - один воркспейс - одно окно; ядро решает про безопасный режим один раз, до первого хоста.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app, dialog, type BrowserWindow } from 'electron';
import type { RecentWorkspaces } from '@cyborg-harness/core';
import { newWindowArgs } from './instances.ts';
import type { PluginsService } from './plugins.ts';
import type { WorkspaceInfo } from './snapshot.ts';

/** Флаги командной строки, которыми приложение передаёт себе же состояние при перезапуске. */
export interface RestartFlags {
  /** Префикс флага воркспейса: `--workspace=<файл>`. */
  readonly workspace: string;
  /** Флаг окна без воркспейса. */
  readonly noWorkspace: string;
  /** Флаг безопасного режима (BR-CH-005). */
  readonly safeMode: string;
}

export const DEFAULT_RESTART_FLAGS: RestartFlags = { workspace: '--workspace=', noWorkspace: '--no-workspace', safeMode: '--safe-mode' };

export interface RestartOptions {
  readonly plugins: PluginsService;
  readonly window: () => BrowserWindow | undefined;
  readonly recent: RecentWorkspaces;
  /** Воркспейс, с которым приложение запущено сейчас; `undefined` - окно без воркспейса. */
  readonly workspaceFile: string | undefined;
  /** Безопасный режим включён в этом запуске. */
  readonly safeMode: boolean;
  readonly flags?: RestartFlags;
}

export interface Restarts {
  /** «Открыть…» без аргумента спрашивает файл, со строкой берёт воркспейс из «Недавних». */
  openWorkspace(arg: unknown): Promise<void>;
  /** То же, что `openWorkspace`, но текущее окно остаётся: воркспейс открывает новый процесс с тем же `userData`. Уже открытый где-то воркспейс процесс только поднимет. */
  openWorkspaceInNewWindow(arg: unknown): Promise<void>;
  /** Включает или выключает безопасный режим перезапуском. */
  switchSafeMode(on: unknown): Promise<void>;
}

const realOf = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

/** Воркспейс окна и «Недавние» без текущего - то, что `PluginsService.setWorkspace` отдаёт окну. */
export function workspaceInfo(workspaceFile: string | undefined, recent: RecentWorkspaces): WorkspaceInfo {
  const current = workspaceFile === undefined ? null : realOf(workspaceFile);
  return { current: workspaceFile ?? null, recent: recent.list().filter((f) => f !== current) };
}

export function restarts(options: RestartOptions): Restarts {
  const { plugins, recent, workspaceFile } = options;
  const flags = options.flags ?? DEFAULT_RESTART_FLAGS;

  /** Перезапуск завершает живые pty плагинов: без них вопроса нет. */
  async function livePtyAgreed(action: string, question: string): Promise<boolean> {
    const live = plugins.livePty;
    if (live === 0) return true;
    const win = options.window();
    const message = { type: 'question' as const, buttons: [action, 'Отмена'], defaultId: 1, cancelId: 1, message: question, detail: `Живых процессов плагинов: ${String(live)}. Они завершатся при перезапуске.` };
    const answer = win ? await dialog.showMessageBox(win, message) : await dialog.showMessageBox(message);
    return answer.response === 0;
  }

  /** Файл из диалога (`arg` не задан) или из «Недавних»; `undefined` - человек отказался. */
  async function pick(arg: unknown): Promise<string | undefined> {
    if (arg === undefined) {
      const win = options.window();
      const dialogOptions = { title: 'Открыть воркспейс', filters: [{ name: 'Воркспейс Cyborg', extensions: ['json'] }], properties: ['openFile' as const] };
      const picked = win ? await dialog.showOpenDialog(win, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      return picked.canceled ? undefined : picked.filePaths[0];
    }
    if (typeof arg === 'string' && recent.list().includes(arg)) return arg;
    throw new Error('воркспейса нет в «Недавних»');
  }
  const isCurrent = (file: string) => workspaceFile !== undefined && realOf(file) === realOf(workspaceFile);

  return {
    async openWorkspace(arg) {
      const file = await pick(arg);
      if (file === undefined || isCurrent(file)) return;
      if (!(await livePtyAgreed('Открыть', `Открыть ${path.basename(file)}?`))) return;
      const keep = process.argv.slice(1).filter((a) => a !== flags.noWorkspace && !a.startsWith(flags.workspace));
      app.relaunch({ args: [...keep, `${flags.workspace}${file}`] });
      app.quit();
    },
    async openWorkspaceInNewWindow(arg) {
      const file = await pick(arg);
      if (file === undefined || isCurrent(file)) return;
      // Не перезапуск: текущий процесс, его плагины и pty остаются, вопроса про живые процессы нет.
      const child = spawn(process.execPath, newWindowArgs(process.argv.slice(1), file, flags), { detached: true, stdio: 'ignore' });
      // Процесс не запустился (`spawn` отказал) - отказ уходит ответом, окно показывает его рядом с кнопкой. Что новый процесс упал уже после запуска,
      // этот процесс не видит: такой отказ показывает сам новый процесс (диалог в своём окне или сообщение о занятом воркспейсе).
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => resolve());
      });
      child.unref();
    },
    async switchSafeMode(on) {
      if (typeof on !== 'boolean') throw new Error('ожидается true или false');
      if (on === options.safeMode) return;
      if (!(await livePtyAgreed('Перезапустить', on ? 'Перезапустить в безопасном режиме?' : 'Выйти из безопасного режима?'))) return;
      const keep = process.argv.slice(1).filter((a) => a !== flags.safeMode);
      app.relaunch({ args: on ? [...keep, flags.safeMode] : keep });
      app.quit();
    },
  };
}
