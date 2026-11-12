import { spawnSync } from 'node:child_process';
import { scanTests } from './check-acceptance.ts';

// `node scripts/test-acceptance.ts` - запуск только тестов с ключом критерия приёмки `ST-NNNN/k` в имени (#230). Файлы берутся из того же
// обхода, что у `check-acceptance`, а в самом `node --test` имя фильтруется шаблоном ключа: остальные тесты файла не идут. Локально не дольше 30 с.
// Сборка пакетов идёт перед запуском (`pretest:acceptance`).

const PATTERN = String.raw`ST-\d+/\d+`;

export function acceptanceFiles(root: string): string[] {
  return [...new Set(scanTests(root).filter((t) => t.kind === 'test' && !t.disabled).map((t) => t.file))].sort();
}

if (process.argv[1] === import.meta.filename) {
  const files = acceptanceFiles(process.cwd());
  if (files.length === 0) {
    process.stderr.write('нет ни одного теста с ключом критерия приёмки\n');
    process.exit(1);
  }
  const run = spawnSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--test', '--test-force-exit', '--test-timeout=120000', `--test-name-pattern=${PATTERN}`, ...files],
    { stdio: 'inherit' },
  );
  process.exitCode = run.status ?? 1;
}
