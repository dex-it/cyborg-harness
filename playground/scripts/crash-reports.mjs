// Падение процесса Electron при выходе: сигнал завершения и отчёты macOS (~/Library/Logs/DiagnosticReports/Electron-*.ips).
// #185: SIGABRT из pty.node при очистке окружения Node не виден в CI, а у человека на macOS это окно «Electron неожиданно завершил работу».
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Сигналы, которыми процесс завершается при падении (а не по просьбе: SIGTERM и SIGKILL шлёт сам тест). */
export const CRASH_SIGNALS = new Set(['SIGABRT', 'SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGTRAP', 'SIGFPE']);

const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Отчёты о падении запущенного процесса Electron, появившиеся не раньше `since` (мс с эпохи). Запуск идёт через `node_modules/.bin/electron`, обёртку: pid в отчёте
 * у самого Electron, а у обёртки `pid` дочернего - `parentPid`. Чужие падения (другие процессы Electron на машине) не считаются. Не macOS - пусто.
 */
export function crashReportsOf(pid, since) {
  if (process.platform !== 'darwin' || !existsSync(REPORTS)) return [];
  const found = [];
  for (const name of readdirSync(REPORTS)) {
    if (!/^Electron.*\.ips$/.test(name)) continue;
    const file = join(REPORTS, name);
    try {
      if (statSync(file).mtimeMs < since) continue;
      // Первая строка - заголовок, дальше JSON отчёта.
      const report = JSON.parse(readFileSync(file, 'utf8').split('\n').slice(1).join('\n'));
      if (report.pid === pid || report.parentPid === pid) found.push(file);
    } catch {
      // Отчёт ещё пишется или чужой формат: к этому процессу он не относится
    }
  }
  return found;
}

/** Отчёт появляется через секунды после падения: ждём до `timeout` мс. Чистый выход стоит всего ожидания, поэтому на нём ждать мало. */
export async function waitCrashReports(pid, since, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = crashReportsOf(pid, since);
    if (found.length > 0 || Date.now() >= deadline) return found;
    await sleep(250);
  }
}

/** Падение запущенного процесса, если оно было: описание причины или `undefined`. */
export async function crashOf(child, since) {
  if (child.signalCode !== null && CRASH_SIGNALS.has(child.signalCode)) return `процесс завершился сигналом ${child.signalCode}`;
  const reports = await waitCrashReports(child.pid, since);
  return reports.length > 0 ? `macOS записала отчёт о падении: ${reports.join(', ')}` : undefined;
}
