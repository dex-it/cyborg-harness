// Проба выхода с pty в главном процессе Electron (#185). Запуск: `electron playground/scripts/pty-exit-probe.mjs`, код выхода 0 - чисто, 1 - выходы не доставлены.
// Восемь процессов pty убиваются, и приложение сразу выходит: `node-pty` доставляет выход из своего потока, а недоставленный выход в очистке окружения Node
// роняет главный процесс SIGABRT. Бэкенд адаптера (`nodePtyBackend`) дожидается выходов в `drain()`. Запускает пробу smoke.mjs (шаг «выход с pty»).
// Красный прогон для правки: CYBORG_PROBE_NO_DRAIN=1 выходит сразу после убийства, без `drain()`. Падение SIGABRT (на macOS - Electron-*.ips) - гонка потока выхода с очисткой окружения,
// воспроизводится не в каждом запуске; в smoke переменная не задаётся.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';

const PTYS = 8;
app.dock?.hide();
app.on('window-all-closed', () => undefined);
void app.whenReady().then(async () => {
  const { nodePtyBackend } = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'electron', 'dist', 'src', 'pty-backend.js')).href);
  const backend = nodePtyBackend();
  const options = { name: 'xterm-256color', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, cols: 80, rows: 24 };
  const procs = [];
  for (let i = 0; i < PTYS; i++) procs.push(await backend.spawn('/bin/sh', ['-c', 'sleep 30'], options));
  let exited = 0;
  // Обработчик делает то же, что обработчики ядра, - пишет наружу: в разрушаемом окружении это бросает исключение, а из C++ оно уходит в abort.
  for (const proc of procs) {
    proc.onExit(() => {
      exited++;
      console.log('pty-exit-probe: выход pty доставлен');
    });
  }
  // Поток ожидания выхода каждого pty должен успеть встать на процесс: убитый сразу после запуска pty ведёт себя иначе и не воспроизводит сбой.
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const proc of procs) proc.kill('SIGKILL');
  if (process.env.CYBORG_PROBE_NO_DRAIN !== '1') await backend.drain();
  console.log(`pty-exit-probe: выходов доставлено ${String(exited)} из ${String(procs.length)}`);
  app.exit(exited === procs.length ? 0 : 1);
});
