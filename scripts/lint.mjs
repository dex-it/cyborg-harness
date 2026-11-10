// `npm run lint`: ESLint по процессу на пакет, затем остаток репозитория (#153).
// Один `eslint .` держит программы TypeScript всех пакетов в одной куче: пик рос суммой пакетов и на macOS упирался в 2 ГиБ.
// Процесс на пакет ограничивает пик самым большим пакетом (playground, около 1 ГиБ), а не суммой. Остаток репозитория (скрипты .mjs и прочее)
// идёт последним процессом без этих пакетов: каталог, которого нет в списке, всё равно проверяется, только вместе с остатком.
// Лишние аргументы (`npm run lint -- --fix`) уходят в каждый процесс. `--plan` печатает команды и ничего не запускает.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const PACKAGES = ['contracts', 'core', 'testing', 'electron', 'tools', 'templates', 'playground', 'scripts'];
const base = ['--max-warnings=0'];

const args = process.argv.slice(2);
const plan = args.includes('--plan');
const extra = args.filter((a) => a !== '--plan');
const runs = [
  ...PACKAGES.map((dir) => [...base, ...extra, dir]),
  [...base, ...extra, ...PACKAGES.map((dir) => `--ignore-pattern=${dir}/`), '.'],
];

if (plan) {
  console.log(JSON.stringify(runs));
} else {
  const eslint = join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  let failed = false;
  for (const run of runs) {
    const { status } = spawnSync(process.execPath, [eslint, ...run], { cwd: root, stdio: 'inherit' });
    if (status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
