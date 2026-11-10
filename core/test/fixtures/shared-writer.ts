import fs from 'node:fs';
import path from 'node:path';
import { RecentWorkspaces } from '../../src/recent.ts';
import { openWorkspace, withFileLock } from '../../src/workspace.ts';

/**
 * Писатель общего файла в отдельном процессе: `node shared-writer.ts <recent|user|counter> <каталог> <номер> <записей>`.
 * Каждый процесс делает `<записей>` записей со своими именами; тест после всех процессов проверяет, что не потерялась ни одна.
 */
const [mode, dir, index, count] = process.argv.slice(2) as [string, string, string, string];
const n = Number(count);
const me = Number(index);

if (mode === 'recent') {
  const recent = new RecentWorkspaces(path.join(dir, 'recent.json'), 10_000);
  for (let i = 0; i < n; i++) recent.add(path.join(dir, `ws-${String(me)}-${String(i)}.cyborg.json`));
} else if (mode === 'user') {
  // Свой воркспейс, общий файл пользователя: как два окна одного userData.
  const opened = await openWorkspace({ file: path.join(dir, `w${String(me)}.cyborg.json`), userFile: path.join(dir, 'user', 'cyborg.json'), stateDir: path.join(dir, 'state') });
  if (!opened.ok) throw new Error('воркспейс занят');
  for (let i = 0; i < n; i++) await opened.workspace.config.write('user', `p${String(me)}-${String(i)}`, 1, { value: i });
  opened.workspace.close();
} else {
  // Счётчик: чтение, пауза и запись под замком - без замка параллельные процессы теряют приращения.
  const file = path.join(dir, 'counter.txt');
  for (let i = 0; i < n; i++) {
    withFileLock(file, () => {
      const now = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      fs.writeFileSync(file, String(now + 1));
    });
  }
}
