import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { RELEASE_PACKAGES, ReleaseError, hasChangelogEntry, main, packPlan, planRelease, publishPlan } from '../release.ts';
import type { ReleasePlan, Run } from '../release.ts';

// P-10: релиз по тегу. Деревья пакетов собираются во временном каталоге; настоящих npm pack и npm publish тесты не зовут (кроме сухого `pack --dry-run` на репозитории).
const repo = path.resolve(import.meta.dirname, '..', '..');
const roots: string[] = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

interface Spec {
  version: string;
  private?: boolean;
  registry?: boolean;
  license?: string;
  changelog?: string | null;
}

function tree(specs: Partial<Record<(typeof RELEASE_PACKAGES)[number]['dir'], Spec>>): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-release-'));
  roots.push(root);
  for (const { name, dir } of RELEASE_PACKAGES) {
    const spec = specs[dir] ?? { version: '0.0.0' };
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const manifest = {
      name,
      version: spec.version,
      ...(spec.private === true && { private: true }),
      ...(spec.license !== undefined && { license: spec.license }),
      ...(spec.registry !== false && { publishConfig: { registry: 'https://registry.npmjs.org/', access: 'restricted' } }),
    };
    fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify(manifest));
    if (spec.changelog !== null) fs.writeFileSync(path.join(root, dir, 'CHANGELOG.md'), spec.changelog ?? `# Журнал\n\n## Unreleased\n\n## ${spec.version} - 2026-12-01\n`);
  }
  return root;
}

const problemsOf = (fn: () => unknown): readonly string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ReleaseError) return error.problems;
    throw error;
  }
  return [];
};

describe('hasChangelogEntry', () => {
  it('заголовок «## версия - дата» принимается, «Unreleased», другая версия и недатированный - нет', () => {
    assert.equal(hasChangelogEntry('## 1.2.3 - 2026-12-01\n', '1.2.3'), true);
    assert.equal(hasChangelogEntry('## [1.2.3] - 2026-12-01\n', '1.2.3'), true);
    assert.equal(hasChangelogEntry('## 1.2.3-rc.1 - 2026-12-01\n', '1.2.3-rc.1'), true);
    assert.equal(hasChangelogEntry('## Unreleased\n', '1.2.3'), false);
    assert.equal(hasChangelogEntry('## 1.2.30 - 2026-12-01\n', '1.2.3'), false);
    assert.equal(hasChangelogEntry('## 1.2.3 - не выпущена\n', '1.2.3'), false);
    assert.equal(hasChangelogEntry('## 1x2y3 - 2026-12-01\n', '1.2.3'), false);
  });
});

describe('planRelease: тег и версия пакета', () => {
  it('ST-5002/7: версия в теге совпадает с версией пакета и записью CHANGELOG - пакет в плане, остальные пропущены', () => {
    const root = tree({ contracts: { version: '1.0.0' }, core: { version: '0.1.0' }, electron: { version: '0.1.0' } });
    const plan = planRelease(root, 'v0.1.0');
    assert.deepEqual(plan.packages.map((p) => [p.name, p.version, p.distTag]), [['@cyborg-harness/core', '0.1.0', 'latest'], ['@cyborg-harness/electron', '0.1.0', 'latest']]);
    assert.deepEqual(plan.skipped, [{ name: '@cyborg-harness/contracts', version: '1.0.0' }]);
  });

  it('порядок публикации: контракты, ядро, адаптер', () => {
    const root = tree({ contracts: { version: '1.0.0' }, core: { version: '1.0.0' }, electron: { version: '1.0.0' } });
    assert.deepEqual(planRelease(root, 'v1.0.0').packages.map((p) => p.dir), ['contracts', 'core', 'electron']);
  });

  it('версия тега не совпадает ни с одним пакетом - отказ с перечнем версий', () => {
    const root = tree({ contracts: { version: '1.0.0' }, core: { version: '0.1.0' }, electron: { version: '0.1.0' } });
    const problems = problemsOf(() => planRelease(root, 'v2.0.0'));
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /ни у одного пакета нет версии 2\.0\.0 \(@cyborg-harness\/contracts 1\.0\.0, /);
  });

  it('тег не вида v<semver> - отказ', () => {
    const root = tree({ core: { version: '0.1.0' } });
    for (const tag of ['0.1.0', 'v1.0', 'release-1', 'v1.0.0.0', 'core-v0.1.0']) assert.match(problemsOf(() => planRelease(root, tag))[0] ?? '', /не вида v/, tag);
  });

  it('версия -dev - линия разработки, выпуск запрещён', () => {
    const root = tree({ contracts: { version: '1.0.0-dev' } });
    assert.match(problemsOf(() => planRelease(root, 'v1.0.0-dev'))[0] ?? '', /линия разработки/);
  });

  it('предварительная версия выходит с меткой next, а не latest', () => {
    const root = tree({ core: { version: '0.2.0-rc.1' } });
    assert.equal(planRelease(root, 'v0.2.0-rc.1').packages[0]?.distTag, 'next');
  });
});

describe('planRelease: CHANGELOG, канал, закрытость', () => {
  it('ST-5002/7: нет записи о версии в CHANGELOG - отказ; в репетиции предупреждение', () => {
    const root = tree({ core: { version: '0.1.0', changelog: '# Журнал\n\n## Unreleased\n' } });
    assert.match(problemsOf(() => planRelease(root, 'v0.1.0'))[0] ?? '', /core\/CHANGELOG\.md нет заголовка «## 0\.1\.0 - ГГГГ-ММ-ДД»/);
    const rehearsal = planRelease(root, 'v0.1.0', { rehearsal: true });
    assert.equal(rehearsal.packages.length, 1);
    assert.match(rehearsal.warnings.join('\n'), /нет заголовка «## 0\.1\.0.*при выпуске это ошибка/);
  });

  it('нет файла CHANGELOG - тоже отказ', () => {
    const root = tree({ core: { version: '0.1.0', changelog: null } });
    assert.match(problemsOf(() => planRelease(root, 'v0.1.0'))[0] ?? '', /CHANGELOG/);
  });

  it('private: true запрещает выпуск даже в репетиции', () => {
    const root = tree({ core: { version: '0.1.0', private: true } });
    assert.match(problemsOf(() => planRelease(root, 'v0.1.0', { rehearsal: true }))[0] ?? '', /private: true запрещает npm publish/);
  });

  it('нет registry в publishConfig - отказ: канал не назван', () => {
    const root = tree({ core: { version: '0.1.0', registry: false } });
    assert.match(problemsOf(() => planRelease(root, 'v0.1.0'))[0] ?? '', /нет registry/);
  });

  it('все причины сразу, а не по одной', () => {
    const root = tree({ core: { version: '0.1.0', private: true, registry: false, changelog: null } });
    assert.equal(problemsOf(() => planRelease(root, 'v0.1.0')).length, 3);
  });

  it('лицензия не выбрана и закрытая публикация - предупреждения, не отказ (выбор за владельцем)', () => {
    const root = tree({ contracts: { version: '1.0.0' }, core: { version: '1.0.0', license: 'UNLICENSED' } });
    const text = planRelease(root, 'v1.0.0').warnings.join('\n');
    assert.match(text, /contracts: лицензия не выбрана \(license: нет\)/);
    assert.match(text, /core: лицензия не выбрана \(license: UNLICENSED\)/);
    assert.match(text, /publishConfig\.access = restricted, пакет выйдет закрытым/);
  });
});

describe('packPlan и publishPlan', () => {
  function planned(): { root: string; out: string; plan: ReleasePlan } {
    const root = tree({ contracts: { version: '1.0.0' }, core: { version: '1.0.0-rc.1' }, electron: { version: '1.0.0-rc.1' } });
    const out = path.join(root, 'out');
    fs.mkdirSync(out);
    return { root, out, plan: planRelease(root, 'v1.0.0-rc.1') };
  }
  const fakePack: Run = (_cmd, args) => JSON.stringify([{ filename: `${path.basename(args[1] ?? '')}.tgz` }]);

  it('pack: npm pack каждого пакета в каталог выпуска, имена tarball попадают в план', () => {
    const { root, out, plan } = planned();
    const calls: string[][] = [];
    packPlan(root, plan, out, { run: (cmd, args) => (calls.push([cmd, ...args]), fakePack(cmd, args, root)) });
    assert.deepEqual(plan.packages.map((p) => p.tarball), ['core.tgz', 'electron.tgz']);
    assert.deepEqual(calls[0]?.slice(0, 2), ['npm', 'pack']);
    assert.ok(calls[0].includes('--pack-destination'));
    assert.ok(!calls[0].includes('--dry-run'));
  });

  it('pack --dry-run: без каталога назначения, с флагом сухого прогона', () => {
    const { root, out, plan } = planned();
    const calls: string[][] = [];
    packPlan(root, plan, out, { dryRun: true, run: (cmd, args) => (calls.push([...args]), fakePack(cmd, args, root)) });
    assert.ok(calls.every((a) => a.includes('--dry-run') && !a.includes('--pack-destination')));
  });

  function packed(): { out: string; plan: ReleasePlan } {
    const { root, out, plan } = planned();
    packPlan(root, plan, out, { run: fakePack });
    for (const p of plan.packages) fs.writeFileSync(path.join(out, p.tarball ?? ''), 'x');
    return { out, plan };
  }

  it('publish по умолчанию - сухой прогон: каждая команда с --dry-run, метка next у rc', () => {
    const { out, plan } = packed();
    const calls: string[][] = [];
    const result = publishPlan(plan, out, { env: {}, run: (_c, args) => (calls.push([...args]), '') });
    assert.equal(result.real, false);
    assert.equal(calls.length, 2);
    for (const args of calls) {
      assert.ok(args.includes('--dry-run'));
      assert.deepEqual(args.slice(2, 4), ['--tag', 'next']);
    }
  });

  it('--publish без RELEASE_PUBLISH=true остаётся сухим прогоном; RELEASE_PUBLISH без --publish тоже', () => {
    const { out, plan } = packed();
    assert.equal(publishPlan(plan, out, { publish: true, env: {}, run: () => '' }).real, false);
    assert.equal(publishPlan(plan, out, { publish: true, env: { RELEASE_PUBLISH: 'yes' }, run: () => '' }).real, false);
    assert.equal(publishPlan(plan, out, { publish: false, env: { RELEASE_PUBLISH: 'true' }, run: () => '' }).real, false);
  });

  it('настоящая публикация только при обоих условиях: без --dry-run и по порядку плана', () => {
    const { out, plan } = packed();
    const calls: string[][] = [];
    const result = publishPlan(plan, out, { publish: true, env: { RELEASE_PUBLISH: 'true' }, run: (_c, args) => (calls.push([...args]), '') });
    assert.equal(result.real, true);
    assert.ok(calls.every((a) => !a.includes('--dry-run')));
    assert.deepEqual(calls.map((a) => path.basename(a[1] ?? '')), ['core.tgz', 'electron.tgz']);
  });

  it('нет tarball или файла - отказ до первой публикации', () => {
    const { root, out, plan } = planned();
    assert.throws(() => publishPlan(plan, out, { run: () => '' }), /сначала `pack`/);
    packPlan(root, plan, out, { run: fakePack });
    let called = 0;
    assert.throws(() => publishPlan(plan, out, { run: () => (called++, '') }), /нет файла/);
    assert.equal(called, 0);
  });
});

describe('main', () => {
  it('plan пишет plan.json, pack --dry-run и publish без флагов ничего не выпускают', () => {
    const root = tree({ core: { version: '1.0.0' } });
    const calls: string[] = [];
    const run: Run = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return args[0] === 'pack' ? JSON.stringify([{ filename: 'cyborg-harness-core-1.0.0.tgz' }]) : '';
    };
    assert.match(main(['plan', 'v1.0.0', '--out', 'rel'], root, { run }).out, /\+ @cyborg-harness\/core@1\.0\.0 \(метка latest\)/);
    assert.ok(fs.existsSync(path.join(root, 'rel', 'plan.json')));
    main(['pack', 'rel'], root, { run });
    fs.writeFileSync(path.join(root, 'rel', 'cyborg-harness-core-1.0.0.tgz'), 'x');
    const out = main(['publish', 'rel'], root, { run, env: { RELEASE_PUBLISH: 'true' } }).out;
    assert.match(out, /сухой прогон: нет --publish/);
    assert.ok(calls.filter((c) => c.startsWith('npm publish')).every((c) => c.endsWith('--dry-run')));
  });

  it('неизвестная команда и нехватка аргументов - исключение', () => {
    const root = tree({ core: { version: '1.0.0' } });
    assert.throws(() => main(['plan'], root), /использование/);
    assert.throws(() => main(['ship', 'x'], root), /ENOENT|неизвестная команда/);
  });
});

describe('репозиторий', () => {
  it('core и electron готовы к выпуску: не private, канал и закрытый доступ записаны, CHANGELOG в составе архива', () => {
    for (const dir of ['core', 'electron', 'contracts']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(repo, dir, 'package.json'), 'utf8')) as { private?: boolean; publishConfig?: { registry?: string; access?: string }; files?: string[] };
      assert.notEqual(pkg.private, true, dir);
      assert.deepEqual(pkg.publishConfig, { registry: 'https://registry.npmjs.org/', access: 'restricted' }, dir);
      assert.ok(pkg.files?.includes('CHANGELOG.md'), dir);
      assert.ok(fs.existsSync(path.join(repo, dir, 'CHANGELOG.md')), dir);
    }
  });

  it('репетиция тега v0.1.0 на настоящих пакетах: ядро и адаптер в плане, контракты пропущены, до выпуска нужны записи CHANGELOG', () => {
    const plan = planRelease(repo, 'v0.1.0', { rehearsal: true });
    assert.deepEqual(plan.packages.map((p) => p.name), ['@cyborg-harness/core', '@cyborg-harness/electron']);
    assert.deepEqual(plan.skipped.map((s) => s.name), ['@cyborg-harness/contracts']);
    assert.equal(plan.warnings.filter((w) => w.includes('при выпуске это ошибка')).length, 2);
    assert.match(problemsOf(() => planRelease(repo, 'v0.1.0'))[0] ?? '', /CHANGELOG/);
  });

  it('сухой pack --dry-run на настоящих пакетах: состав архива без файла и без публикации', () => {
    const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-release-pack-'));
    roots.push(out);
    const plan = planRelease(repo, 'v0.1.0', { rehearsal: true });
    const done = packPlan(repo, plan, out, { dryRun: true });
    assert.deepEqual(done, ['@cyborg-harness/core@0.1.0 -> cyborg-harness-core-0.1.0.tgz', '@cyborg-harness/electron@0.1.0 -> cyborg-harness-electron-0.1.0.tgz']);
    assert.deepEqual(fs.readdirSync(out), []);
  });
});
