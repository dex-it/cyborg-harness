import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

// #153: `eslint .` держал программы TypeScript всех пакетов в одной куче и упирался в 2 ГиБ на macOS. Линт идёт по процессу на пакет:
// пик - наибольший пакет, а не сумма. Тест держит, чтобы новый пакет с кодом не вернулся в общую кучу молча.
const root = path.resolve(import.meta.dirname, '..', '..');
const plan = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts', 'lint.mjs'), '--plan'], { cwd: root, encoding: 'utf8' })) as unknown;

test('линт: процесс на пакет, затем остаток репозитория без этих пакетов', () => {
  assert.ok(Array.isArray(plan));
  const runs = plan as readonly (readonly string[])[];
  const groups = runs.slice(0, -1).map((args) => args.filter((a) => !a.startsWith('-')));
  assert.ok(groups.length >= 8, `пакетов в плане ${groups.length}`);
  for (const g of groups) assert.equal(g.length, 1, `в одном процессе один пакет: ${g.join(' ')}`);
  const rest = runs.at(-1);
  assert.ok(rest, 'остаток репозитория');
  assert.ok(rest.includes('.'), 'остаток идёт по корню');
  for (const [dir] of groups) assert.ok(rest.includes(`--ignore-pattern=${dir}/`), `остаток не повторяет ${dir}`);
});

test('линт: каждый пакет с кодом TypeScript идёт в своём процессе', () => {
  const runs = plan as readonly (readonly string[])[];
  const packages = new Set(runs.slice(0, -1).map((args) => args.find((a) => !a.startsWith('-'))));
  const tracked = execFileSync('git', ['ls-files', '*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  // site/ линтер не читает (eslint.config.mjs, ignores); остальные верхние каталоги с .ts - пакеты.
  const dirs = new Set(tracked.map((f) => f.split('/')[0]).filter((d): d is string => d !== undefined && d !== 'site'));
  for (const d of dirs) assert.ok(packages.has(d), `каталог ${d} с .ts не в плане линта: его программы попали бы в общую кучу`);
});
