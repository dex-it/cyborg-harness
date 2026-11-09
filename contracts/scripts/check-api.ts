import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSnapshot, compareWithBase, normalizeDeclarations, parseSnapshot, readSnapshot, renderSnapshot, SNAPSHOT_FILE } from './api.ts';
import type { Snapshot } from './api.ts';
import { buildDeclarations } from './build.ts';

// `node scripts/check-api.ts [--base <ref>]` - проверка снимка (и версии против снимка в ветке назначения `ref`); `--update` - переписать снимок по собранным декларациям.
const contracts = path.resolve(import.meta.dirname, '..');

export interface CheckOptions {
  /** Файл снимка; по умолчанию снимок пакета. */
  readonly snapshotFile?: string;
  /** Каталог внутри репозитория, откуда читается снимок ветки назначения. */
  readonly gitDir?: string;
}

export interface CheckResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Разбор `args` и проверка; ошибка настройки (нет ссылки, неизвестная ссылка) - исключение, а не «замечание»: молча пропустить сравнение значило бы отключить проверку. */
export function main(args: readonly string[], options: CheckOptions = {}): CheckResult {
  const snapshotFile = options.snapshotFile ?? SNAPSHOT_FILE;
  const gitDir = options.gitDir ?? contracts;
  const pkg = JSON.parse(fs.readFileSync(path.join(contracts, 'package.json'), 'utf8')) as { version: string };
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-api-'));
  try {
    buildDeclarations(out);
    if (args.includes('--update')) {
      fs.writeFileSync(snapshotFile, renderSnapshot(pkg.version, normalizeDeclarations(out)));
      return { code: 0, out: `api-snapshot.txt обновлён для версии ${pkg.version}\n`, err: '' };
    }
    const problems = checkSnapshot(out, pkg.version, snapshotFile);
    let said = '';
    const baseRef = args.includes('--base') ? args[args.indexOf('--base') + 1] : undefined;
    if (args.includes('--base')) {
      if (!baseRef) throw new Error('--base требует ссылку git, например origin/master');
      const run = (...a: string[]): string => execFileSync('git', a, { cwd: gitDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      run('rev-parse', '--verify', `${baseRef}^{commit}`);
      const file = `${baseRef}:contracts/api-snapshot.txt`;
      let base: Snapshot | undefined;
      try {
        run('cat-file', '-e', file);
      } catch {
        said = `в ${baseRef} снимка нет: сравнивать не с чем\n`;
      }
      // Снимок в базе есть, но не разбирается - ошибка, а не «сравнивать не с чем»: иначе проверка молча отключается.
      if (!said) base = parseSnapshot(run('show', file));
      problems.push(...compareWithBase(base, readSnapshot(snapshotFile)));
    }
    if (problems.length > 0) return { code: 1, out: said, err: problems.map((p) => `ошибка: ${p}\n`).join('') };
    return { code: 0, out: `${said}публичные декларации совпадают со снимком ${pkg.version}${baseRef ? `, версия согласована с ${baseRef}` : ''}\n`, err: '' };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
