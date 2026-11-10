import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessResult } from '@cyborg-harness/contracts';
import { filterOverrides, type FilterHost } from '../plugins/git/filters.ts';

const result = (stdout: string, extra: Partial<ProcessResult> = {}): ProcessResult => ({ code: 0, signal: null, stdout, stderr: '', truncated: false, ...extra });
const z = (...fields: string[]): string => fields.join('\0') + '\0';
const gitlink = (rel: string): string => `160000 ${'a'.repeat(40)} 0\t${rel}`;
const file = (rel: string): string => `100644 ${'b'.repeat(40)} 0\t${rel}`;

interface Repo {
  readonly config?: ProcessResult | string[];
  readonly index?: ProcessResult | string[];
}

/** Подставной git: ответы по каталогу; каталог без записи - не репозиторий. */
function fake(repos: Record<string, Repo>, populated: readonly string[] = Object.keys(repos)) {
  const calls: string[] = [];
  const host: FilterHost = {
    git(args, cwd) {
      const kind = args.includes('config') ? 'config' : 'ls-files';
      calls.push(`${kind} ${cwd}`);
      const repo = repos[cwd];
      if (repo === undefined) return Promise.resolve(result('', { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }));
      const answer = kind === 'config' ? repo.config : repo.index;
      if (answer === undefined) return Promise.resolve(kind === 'config' ? result('', { code: 1 }) : result(''));
      return Promise.resolve(Array.isArray(answer) ? result(z(...answer)) : answer);
    },
    populated: (dir) => Promise.resolve(populated.includes(dir)),
  };
  return { host, calls };
}

test('filterOverrides: ключи репозитория перекрыты, required - значением false, доверенные слои пропущены', async () => {
  const { host } = fake({ '/r': { config: ['system', 'filter.s.clean', 'global', 'filter.g.process', 'local', 'filter.x.clean', 'worktree', 'filter.Y z.process', 'local', 'filter.x.required'] } });
  assert.deepEqual(await filterOverrides(host, '/r'), {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'filter.x.clean',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'filter.Y z.process',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'filter.x.required',
    GIT_CONFIG_VALUE_2: 'false',
  });
});

test('filterOverrides: нет ключей - счёт 0; код 1 у config значит «нет совпадений»', async () => {
  const { host } = fake({ '/r': {} });
  assert.deepEqual(await filterOverrides(host, '/r'), { GIT_CONFIG_COUNT: '0' });
});

test('filterOverrides: не репозиторий - null, а не ошибка', async () => {
  const { host } = fake({});
  assert.equal(await filterOverrides(host, '/none'), null);
});

test('filterOverrides: вложенные репозитории (подмодули) обходятся рекурсивно, незаполненные и вне каталога пропускаются, ключи без повторов', async () => {
  const { host, calls } = fake(
    {
      '/r': { config: ['local', 'filter.x.clean'], index: [file('a.txt'), gitlink('sub'), gitlink('empty'), gitlink('../out'), gitlink('/abs'), gitlink('a//b')] },
      '/r/sub': { config: ['local', 'filter.x.clean', 'local', 'filter.in.process'], index: [gitlink('deep')] },
      '/r/sub/deep': { config: ['worktree', 'filter.d.required'] },
      '/r/empty': {},
    },
    ['/r', '/r/sub', '/r/sub/deep'],
  );
  const env = await filterOverrides(host, '/r');
  assert.ok(env);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_KEY_2], ['filter.x.clean', 'filter.in.process', 'filter.d.required']);
  assert.equal(env.GIT_CONFIG_VALUE_2, 'false');
  assert.deepEqual(calls.filter((c) => c.startsWith('config')).toSorted(), ['config /r', 'config /r/sub', 'config /r/sub/deep']);
});

test('filterOverrides: сбой сбора ключей - ошибка, а не неполный набор', async () => {
  const bad = async (repo: Repo, message: RegExp) => {
    const { host } = fake({ '/r': repo }, ['/r', '/r/s\uFFFD']);
    await assert.rejects(filterOverrides(host, '/r'), message);
  };
  await bad({ config: result('', { code: 128, stderr: 'fatal: bad config' }) }, /git config: код 128: fatal: bad config/);
  await bad({ config: result('x', { code: 1, truncated: true }) }, /git config: вывод длиннее предела/);
  await bad({ index: result('', { code: null, signal: 'SIGTERM' }) }, /git ls-files: код SIGTERM/);
  await bad({ index: result('', { truncated: true }) }, /git ls-files: вывод длиннее предела/);
  await bad({ config: ['local', 'filter.�x.clean'] }, /ключ фильтра не в UTF-8/);
  await bad({ index: [gitlink('s�')] }, /путь вложенного репозитория не в UTF-8/);
});

test('filterOverrides: вложенность глубже предела - ошибка; не репозиторий внутри - ошибка, а не null', async () => {
  const chain: Record<string, Repo> = {};
  let dir = '/r';
  for (let i = 0; i <= 9; i++) {
    chain[dir] = { index: [gitlink('s')] };
    dir += '/s';
  }
  const deep = fake(chain);
  await assert.rejects(filterOverrides(deep.host, '/r'), /глубже предела/);
  const broken = fake({ '/r': { index: [gitlink('sub')] }, '/r/sub': { index: result('', { code: 128, stderr: 'fatal: not a git repository' }) } });
  await assert.rejects(filterOverrides(broken.host, '/r'), /git ls-files: код 128/);
});
