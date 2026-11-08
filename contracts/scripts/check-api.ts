import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSnapshot, compareWithBase, normalizeDeclarations, parseSnapshot, readSnapshot, renderSnapshot, SNAPSHOT_FILE } from './api.ts';
import { buildDeclarations } from './build.ts';

// `node scripts/check-api.ts [--base <ref>]` - проверка снимка (и версии против снимка в ветке назначения `ref`); `--update` - переписать снимок по собранным декларациям.
const contracts = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const baseRef = args.includes('--base') ? args[args.indexOf('--base') + 1] : undefined;
const pkg = JSON.parse(fs.readFileSync(path.join(contracts, 'package.json'), 'utf8')) as { version: string };

const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-api-'));
try {
  buildDeclarations(out);
  if (args.includes('--update')) {
    fs.writeFileSync(SNAPSHOT_FILE, renderSnapshot(pkg.version, normalizeDeclarations(out)));
    process.stdout.write(`api-snapshot.txt обновлён для версии ${pkg.version}\n`);
  } else {
    const problems = checkSnapshot(out, pkg.version);
    if (args.includes('--base')) {
      if (!baseRef) throw new Error('--base требует ссылку git, например origin/master');
      const run = (...a: string[]): string => execFileSync('git', a, { cwd: contracts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      // Неизвестная ссылка - ошибка настройки CI, а не «снимка нет»: молча пропустить сравнение значило бы отключить проверку.
      run('rev-parse', '--verify', `${baseRef}^{commit}`);
      let base;
      try {
        run('cat-file', '-e', `${baseRef}:contracts/api-snapshot.txt`);
        base = parseSnapshot(run('show', `${baseRef}:contracts/api-snapshot.txt`));
      } catch {
        process.stdout.write(`в ${baseRef} снимка нет: сравнивать не с чем\n`);
      }
      problems.push(...compareWithBase(base, readSnapshot()));
    }
    if (problems.length > 0) {
      process.stderr.write(problems.map((p) => `ошибка: ${p}\n`).join(''));
      process.exitCode = 1;
    } else {
      process.stdout.write(`публичные декларации совпадают со снимком ${pkg.version}${baseRef ? `, версия согласована с ${baseRef}` : ''}\n`);
    }
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
