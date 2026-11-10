import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Выпуск пакетов по тегу (P-10): `node scripts/release.ts plan|pack|publish ...`. Зовёт `.github/workflows/release.yml`; руками тоже можно, всё, что необратимо,
// включается явно. Ничего не публикует без `--publish` и `RELEASE_PUBLISH=true`: без них `publish` - сухой прогон `npm publish --dry-run`.
//   plan <тег> [--out каталог] [--rehearsal]   проверка тега и состава выпуска, план в <каталог>/plan.json
//   pack <каталог> [--dry-run]                 tarball каждого пакета плана (`npm pack`), имена tarball дописываются в план
//   publish <каталог> [--publish]              `npm publish <tarball> --tag <dist-tag>` по порядку плана

/** Выпускаемые пакеты в порядке публикации: peer-зависимости (контракты, ядро) раньше тех, кто на них опирается. */
export const RELEASE_PACKAGES = [
  { name: '@cyborg-harness/contracts', dir: 'contracts' },
  { name: '@cyborg-harness/core', dir: 'core' },
  { name: '@cyborg-harness/electron', dir: 'electron' },
] as const;

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  publishConfig?: { registry?: string; access?: string };
}

export interface PlannedPackage {
  readonly name: string;
  readonly dir: string;
  readonly version: string;
  /** Метка канала: у предварительных версий (`1.1.0-rc.1`) npm требует не `latest`. */
  readonly distTag: 'latest' | 'next';
  /** Имя tarball в каталоге выпуска, появляется после `pack`. */
  tarball?: string;
}

export interface ReleasePlan {
  readonly tag: string;
  readonly version: string;
  readonly packages: PlannedPackage[];
  /** Пакеты репозитория с другой версией: тегом не выпускаются. */
  readonly skipped: readonly { readonly name: string; readonly version: string }[];
  readonly warnings: readonly string[];
}

/** Отказ плана: все найденные причины сразу, а не по одной за запуск. */
export class ReleaseError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`выпуск не разрешён:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ReleaseError';
    this.problems = problems;
  }
}

function readManifest(root: string, dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8')) as Manifest;
}

/** Запись о выпуске версии в CHANGELOG пакета: заголовок `## <версия> - ГГГГ-ММ-ДД` (формат Keep a Changelog, как в contracts/CHANGELOG.md). */
export function hasChangelogEntry(changelog: string, version: string): boolean {
  const escaped = version.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^## \\[?${escaped}\\]? - \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm').test(changelog);
}

/**
 * План выпуска по тегу `v<версия>`: выпускаются пакеты с этой версией, остальные пропускаются (версии пакетов независимы, contracts/README.md,
 * «Три версии»). `rehearsal` - репетиция без выпуска: отсутствие записи в CHANGELOG становится предупреждением, остальное прежнее.
 */
export function planRelease(root: string, tag: string, { rehearsal = false }: { rehearsal?: boolean } = {}): ReleasePlan {
  const match = TAG.exec(tag);
  if (!match?.[1]) throw new ReleaseError([`тег «${tag}» не вида v<мажор>.<минор>.<патч>[-метка]`]);
  const version = match[1];
  const problems: string[] = [];
  const warnings: string[] = [];
  if (/(^|[.-])dev$/.test(version)) problems.push(`версия ${version} - линия разработки, а не выпуск (contracts/CHANGELOG.md, «1.0.0-dev»)`);
  const packages: PlannedPackage[] = [];
  const skipped: { name: string; version: string }[] = [];
  for (const { name, dir } of RELEASE_PACKAGES) {
    const manifest = readManifest(root, dir);
    if (manifest.name !== name) problems.push(`${dir}/package.json: имя «${manifest.name ?? ''}», ожидалось ${name}`);
    if (manifest.version !== version) {
      skipped.push({ name, version: manifest.version ?? '' });
      continue;
    }
    if (manifest.private === true) problems.push(`${name}: private: true запрещает npm publish`);
    if (manifest.publishConfig?.registry === undefined) problems.push(`${name}: в publishConfig нет registry, канал выпуска не назван`);
    const changelogFile = path.join(root, dir, 'CHANGELOG.md');
    const changelog = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, 'utf8') : undefined;
    if (changelog === undefined || !hasChangelogEntry(changelog, version)) {
      const text = `${name}: в ${dir}/CHANGELOG.md нет заголовка «## ${version} - ГГГГ-ММ-ДД»`;
      if (rehearsal) warnings.push(`${text} (при выпуске это ошибка)`);
      else problems.push(text);
    }
    if (manifest.license === undefined || manifest.license === 'UNLICENSED') warnings.push(`${name}: лицензия не выбрана (license: ${manifest.license ?? 'нет'}), выбор за владельцем`);
    if (manifest.publishConfig?.access !== 'public') warnings.push(`${name}: publishConfig.access = ${manifest.publishConfig?.access ?? 'не задан'}, пакет выйдет закрытым`);
    packages.push({ name, dir, version, distTag: version.includes('-') ? 'next' : 'latest' });
  }
  if (packages.length === 0) problems.push(`ни у одного пакета нет версии ${version} (${skipped.map((s) => `${s.name} ${s.version}`).join(', ')})`);
  if (problems.length > 0) throw new ReleaseError(problems);
  return { tag, version, packages, skipped, warnings };
}

export type Run = (cmd: string, args: readonly string[], cwd: string) => string;

const npm: Run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/** `npm pack` каждого пакета плана в `outDir`; `dryRun` - `npm pack --dry-run` (состав архива без файла). Имена tarball пишутся в план. */
export function packPlan(root: string, plan: ReleasePlan, outDir: string, { dryRun = false, run = npm }: { dryRun?: boolean; run?: Run } = {}): string[] {
  const done: string[] = [];
  for (const pkg of plan.packages) {
    const args = ['pack', path.join(root, pkg.dir), '--json', ...(dryRun ? ['--dry-run'] : ['--pack-destination', outDir])];
    const [packed] = JSON.parse(run('npm', args, root)) as { filename: string }[];
    if (packed === undefined) throw new Error(`${pkg.name}: npm pack не вернул описание архива`);
    pkg.tarball = packed.filename;
    done.push(`${pkg.name}@${pkg.version} -> ${pkg.tarball}`);
  }
  return done;
}

export interface PublishOptions {
  /** Запрошено ли настоящее выпускание (`--publish`). */
  readonly publish?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: Run;
}

/**
 * `npm publish <tarball> --tag <метка>` по порядку плана. Настоящая публикация только при `--publish` и `RELEASE_PUBLISH=true` вместе;
 * иначе каждый вызов получает `--dry-run`. Возвращает команды в том виде, в каком они запущены.
 */
export function publishPlan(plan: ReleasePlan, outDir: string, { publish = false, env = process.env, run = npm }: PublishOptions = {}): { real: boolean; commands: string[] } {
  const real = publish && env.RELEASE_PUBLISH === 'true';
  const commands: string[] = [];
  for (const pkg of plan.packages) {
    if (pkg.tarball === undefined) throw new Error(`${pkg.name}: нет tarball, сначала \`pack\``);
    const file = path.join(outDir, pkg.tarball);
    if (!fs.existsSync(file)) throw new Error(`${pkg.name}: нет файла ${file}`);
    const args = ['publish', file, '--tag', pkg.distTag, ...(real ? [] : ['--dry-run'])];
    commands.push(`npm ${args.join(' ')}`);
    run('npm', args, outDir);
  }
  return { real, commands };
}

function planFile(outDir: string): string {
  return path.join(outDir, 'plan.json');
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} требует значение`);
  return value;
}

function describePlan(plan: ReleasePlan): string {
  const lines = [`тег ${plan.tag}: выпускается ${String(plan.packages.length)} из ${String(RELEASE_PACKAGES.length)}`];
  for (const p of plan.packages) lines.push(`  + ${p.name}@${p.version} (метка ${p.distTag})`);
  for (const s of plan.skipped) lines.push(`  - ${s.name}@${s.version}: версия не совпадает с тегом, пропущен`);
  for (const w of plan.warnings) lines.push(`  ! ${w}`);
  return `${lines.join('\n')}\n`;
}

/** Разбор командной строки; `root` - корень репозитория, `run` и `env` подменяются в тестах. */
export function main(args: readonly string[], root: string, { run = npm, env = process.env }: { run?: Run; env?: NodeJS.ProcessEnv } = {}): { code: number; out: string } {
  const [command, target] = args;
  if (target === undefined || target.startsWith('--')) throw new Error('использование: release.ts plan <тег> | pack <каталог> | publish <каталог>');
  if (command === 'plan') {
    const plan = planRelease(root, target, { rehearsal: args.includes('--rehearsal') });
    const out = path.resolve(root, option(args, 'out') ?? 'release');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(planFile(out), `${JSON.stringify(plan, null, 2)}\n`);
    return { code: 0, out: describePlan(plan) };
  }
  const outDir = path.resolve(root, target);
  const plan = JSON.parse(fs.readFileSync(planFile(outDir), 'utf8')) as ReleasePlan;
  if (command === 'pack') {
    const dryRun = args.includes('--dry-run');
    const done = packPlan(root, plan, outDir, { dryRun, run });
    if (!dryRun) fs.writeFileSync(planFile(outDir), `${JSON.stringify(plan, null, 2)}\n`);
    return { code: 0, out: `${done.join('\n')}\n` };
  }
  if (command === 'publish') {
    const wanted = args.includes('--publish');
    const { real, commands } = publishPlan(plan, outDir, { publish: wanted, env, run });
    const note = real ? 'ПУБЛИКАЦИЯ' : wanted ? 'сухой прогон: нет RELEASE_PUBLISH=true' : 'сухой прогон: нет --publish';
    return { code: 0, out: `${note}\n${commands.join('\n')}\n` };
  }
  throw new Error(`неизвестная команда «${command ?? ''}»: plan, pack или publish`);
}

if (process.argv[1] === import.meta.filename) {
  try {
    const result = main(process.argv.slice(2), process.cwd());
    process.stdout.write(result.out);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
