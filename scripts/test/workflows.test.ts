import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// P-10: устройство CI и выпуска. YAML без разборщика: проверяются строки и порядок, которые держат защиту выпуска и закрепление действий.
const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(repo, file), 'utf8');
const files = (dir: string): string[] => fs.readdirSync(path.join(repo, dir), { recursive: true, encoding: 'utf8' }).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
const ci = read('.github/workflows/ci.yml');
const release = read('.github/workflows/release.yml');

/** Текст задания: от строки `  <имя>:` до следующего задания (или конца файла). */
function job(text: string, name: string): string {
  const start = text.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  assert.notEqual(start, -1, `нет задания ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {2}[a-z][\w-]*:\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('действия закреплены по SHA', () => {
  const workflows = [...files('.github/workflows'), ...files('.github/actions')];

  it('нашлись workflow и составное действие', () => {
    assert.ok(workflows.includes(path.join('.github', 'workflows', 'ci.yml')));
    assert.ok(workflows.includes(path.join('.github', 'workflows', 'release.yml')));
    assert.ok(workflows.includes(path.join('.github', 'actions', 'install', 'action.yml')));
  });

  it('каждое `uses:` - владелец/репозиторий@40 знаков SHA с номером версии в комментарии, либо локальный путь', () => {
    for (const file of workflows) {
      for (const [, line] of read(file).matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)) {
        const use = (line ?? '').trim();
        if (use.startsWith('./')) continue;
        assert.match(use, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${file}: ${use}`);
      }
    }
  });
});

describe('ci.yml: задания P-10', () => {
  it('check не потерял лимит 15 минут и матрицу macOS и Linux, права токена - только чтение', () => {
    assert.match(job(ci, 'check'), /timeout-minutes: 15/);
    assert.match(ci, /os: \[macos-latest, ubuntu-24\.04\]/);
    assert.match(ci, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(ci, /secrets\./);
  });

  it('кэш node-pty: установка без скриптов, ключ по lock-файлу, сборка только при промахе', () => {
    const action = read('.github/actions/install/action.yml');
    assert.match(action, /npm ci --ignore-scripts/);
    assert.match(action, /path: node_modules\/node-pty\/build/);
    assert.match(action, /key: node-pty-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-\$\{\{ hashFiles\('package-lock\.json'\) \}\}/);
    assert.match(action, /if: steps\.pty\.outputs\.cache-hit != 'true'\n\s+run: npx electron-rebuild -f -w node-pty/);
    for (const name of ['check', 'budgets']) assert.match(job(ci, name), /uses: \.\/\.github\/actions\/install/, name);
    assert.doesNotMatch(ci, /run: npm ci\s*$/m, 'голый `npm ci` вернул бы нативную сборку на каждый запуск');
  });

  it('бюджеты: оба ОС, замеры шлюза и хостов с --json, сверка с файлом порогов, один повтор', () => {
    const budgets = job(ci, 'budgets');
    assert.match(budgets, /os: \[macos-latest, ubuntu-24\.04\]/);
    assert.match(budgets, /spike-gateway\.mjs --json/);
    assert.match(budgets, /spike-hosts\.mjs --json/);
    assert.match(budgets, /check:budgets -- --gateway .* --hosts /);
    assert.match(budgets, /for attempt in 1 2; do/);
    assert.match(budgets, /timeout-minutes: 15/);
    assert.doesNotMatch(budgets, /continue-on-error/, 'превышение бюджета должно краснить задание');
  });

  it('ссылки в docs и npm audit - задания без continue-on-error на блокирующих шагах', () => {
    assert.match(job(ci, 'docs-links'), /scripts\/check-docs-links\.ts docs README\.md/);
    assert.match(job(ci, 'docs-links'), /scripts\/check-docs-trace\.ts\n/);
    const audit = job(ci, 'audit');
    assert.match(audit, /npm audit --omit=dev --audit-level=high --workspace "\$workspace" \|\| failed=1/);
    for (const workspace of ['contracts', 'core', 'electron', 'testing', 'tools/cyborg-plugin']) assert.match(audit, new RegExp(`for workspace in [^\\n]*${workspace.replace('/', '\\/')}`));
    assert.doesNotMatch(audit, /continue-on-error/);
  });
});

describe('release.yml: защита выпуска', () => {
  it('срабатывает на тег v*; права по умолчанию пустые, у заданий - только чтение, id-token не запрашивается', () => {
    assert.match(release, /on:\n {2}push:\n {4}tags: \['v\*'\]/);
    assert.match(release, /^permissions: \{\}$/m);
    assert.doesNotMatch(release, /id-token:|contents: write|packages: write/);
    assert.equal([...release.matchAll(/^ {6}contents: read$/gm)].length, 2);
  });

  it('публикует только задание publish: тег, переменная RELEASE_PUBLISH, окружение npm-publish, проверка master', () => {
    const publish = job(release, 'publish');
    assert.match(publish, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\) && vars\.RELEASE_PUBLISH == 'true'/);
    assert.match(publish, /environment: npm-publish/);
    assert.match(publish, /needs: verify/);
    assert.match(publish, /merge-base --is-ancestor "\$GITHUB_SHA" FETCH_HEAD/);
    assert.match(publish, /release\.ts publish "\$RUNNER_TEMP\/release" --publish/);
  });

  it('токен только в шаге публикации; в проверке настоящей публикации нет', () => {
    assert.equal([...release.matchAll(/secrets\./g)].length, 1);
    assert.equal([...release.matchAll(/NODE_AUTH_TOKEN/g)].length, 1);
    assert.match(job(release, 'publish'), /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    const verify = job(release, 'verify');
    assert.doesNotMatch(verify, /--publish|RELEASE_PUBLISH: 'true'|secrets\./);
    assert.doesNotMatch(release, /^\s*(run:\s*)?npm publish\b/m, 'npm publish зовёт только scripts/release.ts');
  });

  it('репетиция: pull_request по файлам выпуска и workflow_dispatch с тегом, оба идут через plan --rehearsal', () => {
    assert.match(release, /pull_request:\n {4}paths:/);
    for (const file of ['scripts/release.ts', 'core/CHANGELOG.md', 'electron/CHANGELOG.md', 'contracts/CHANGELOG.md']) assert.ok(release.includes(`'${file}'`), file);
    assert.match(release, /workflow_dispatch:\n {4}inputs:\n {6}tag:/);
    assert.match(release, /rehearsal="--rehearsal"/);
  });

  it('verify собирает пакеты, сверяет снимок контрактов, пакует и репетирует публикацию до загрузки архивов', () => {
    const verify = job(release, 'verify');
    const order = ['release -- plan', 'build:packages', 'check:contracts', 'release -- pack', 'release -- publish', 'upload-artifact'].map((s) => verify.indexOf(s));
    assert.ok(order.every((i) => i !== -1), `шаги: ${order.join(',')}`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
});

describe('dependabot и README', () => {
  const dependabot = read('.github/dependabot.yml');

  it('dependabot: npm в корне и в site, GitHub Actions', () => {
    assert.match(dependabot, /package-ecosystem: npm\n\s+directory: \/\n/);
    assert.match(dependabot, /package-ecosystem: npm\n\s+directory: \/site\n/);
    assert.match(dependabot, /package-ecosystem: github-actions\n\s+directory: \/\n/);
    assert.equal([...dependabot.matchAll(/interval: weekly/g)].length, 3);
  });

  it('README: CI проверяет macOS и Linux, Windows не входит до решения вопроса 12 SAD', () => {
    const readme = read('README.md');
    assert.match(readme, /Раннера Windows нет/);
    assert.match(readme, /вопрос 12 SAD|D-00, строка 7/);
  });
});
