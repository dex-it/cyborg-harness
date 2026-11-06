import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { inlineHosts } from '../src/transports.ts';

interface Dirs {
  readonly data: string;
  readonly temp: string;
  readonly work: string;
  readonly outside: string;
}

const manifest = (id: string, permissions?: unknown) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...(permissions !== undefined && { permissions }) });

async function box(plugins: Record<string, unknown>) {
  // На macOS tmpdir - симлинк /var -> /private/var: области шлюза считаются по настоящему пути.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-sec-')));
  const dirs: Dirs = { data: path.join(root, 'data'), temp: path.join(root, 'temp'), work: path.join(root, 'work'), outside: path.join(root, 'outside') };
  for (const d of [dirs.work, dirs.outside]) await mkdir(d, { recursive: true });
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
    enabled: Object.keys(plugins),
    manifests: Object.entries(plugins).map(([id, p]) => manifest(id, typeof p === 'function' ? (p as (d: Dirs) => unknown)(dirs) : p)),
    os: { dataDir: dirs.data, tempDir: dirs.temp },
  });
  return { k, root, ...dirs, ctx: (id: string) => contexts.get(id)!, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

const workRw = (d: Dirs) => ({ 'fs.read': [d.work], 'fs.write': [d.work] });

test('безопасность: пустой, относительный, ~ и NUL-путь отбиты', async () => {
  await using b = await box({ p: (d: Dirs) => ({ 'fs.read': [d.work] }) });
  const fs = b.ctx('p').os.fs;
  for (const bad of ['', 'work/a', '~/a', `${b.work}/a\0b`, '.', '..']) {
    await assert.rejects(fs.readText(bad), { code: 'PermissionDenied' }, JSON.stringify(bad));
  }
});

test('безопасность: .. и симлинк наружу области не дают ни чтения, ни записи', async () => {
  await using b = await box({ p: workRw });
  await writeFile(path.join(b.outside, 'secret.txt'), 'секрет');
  await symlink(b.outside, path.join(b.work, 'link'));
  await symlink(path.join(b.outside, 'secret.txt'), path.join(b.work, 'file-link'));
  const fs = b.ctx('p').os.fs;
  await assert.rejects(fs.readText(path.join(b.work, '..', 'outside', 'secret.txt')), { code: 'PermissionDenied' });
  await assert.rejects(fs.readText(path.join(b.work, 'link', 'secret.txt')), { code: 'PermissionDenied' });
  await assert.rejects(fs.readText(path.join(b.work, 'file-link')), { code: 'PermissionDenied' });
  await assert.rejects(fs.writeText(path.join(b.work, 'link', 'new.txt'), 'x'), { code: 'PermissionDenied' });
  await assert.rejects(fs.writeText(path.join(b.work, 'file-link'), 'x'), { code: 'PermissionDenied' });
});

test('безопасность: каталог данных чужого плагина закрыт, даже с правом на родителя', async () => {
  await using b = await box({ a: undefined, b: (d: Dirs) => ({ 'fs.read': [d.data] }) });
  const own = path.join(b.ctx('a').os.paths.data, 'n.txt');
  await b.ctx('a').os.fs.writeText(own, 'a-secret');
  await assert.rejects(b.ctx('b').os.fs.readText(own), { code: 'PermissionDenied' });
});

test('безопасность: запись в .git без workspace.git отбита', async () => {
  await using b = await box({ p: workRw });
  await mkdir(path.join(b.work, '.git'), { recursive: true });
  const fs = b.ctx('p').os.fs;
  await assert.rejects(fs.writeText(path.join(b.work, '.git', 'config'), 'x'), { code: 'PermissionDenied' });
  await assert.rejects(fs.writeText(path.join(b.work, '.git', 'hooks', 'pre-commit'), 'x'), { code: 'PermissionDenied' });
});

test('безопасность: ссылка secrets.ref не обходит маску через ..', async () => {
  await using b = await box({ jira: { 'secrets.ref': ['vault://kv/data/jira*'] } });
  const { secrets } = b.ctx('jira');
  const resolve = (ref: string) => secrets.resolve(ref);
  await assert.rejects(resolve('vault://kv/data/jira/prod#token'), { code: 'Unavailable' }, 'контроль: своя ссылка проходит маску');
  await assert.rejects(resolve('vault://kv/data/gitlab#token'), { code: 'PermissionDenied' }, 'контроль: чужая ссылка');
  await assert.rejects(resolve('vault://kv/data/jira/../gitlab#token'), { code: 'PermissionDenied' }, 'обход маски сегментом ..');
  await assert.rejects(resolve('vault://kv/data/jira/%2e%2e/gitlab#token'), { code: 'PermissionDenied' }, 'обход маски закодированным ..');
});

test('безопасность: отказ process.run не кладёт аргументы программы (в них бывают токены) в журнал', async () => {
  await using b = await box({ p: { process: ['git'] } });
  await assert.rejects(b.ctx('p').os.process!.run('curl', ['--header', 'Authorization: Bearer TOPSECRET']), { code: 'PermissionDenied' });
  const text = JSON.stringify(b.k.journal.filter((e) => e.kind === 'denied'));
  assert.ok(text.includes('curl'), 'отказ записан');
  assert.ok(!text.includes('TOPSECRET'), `секрет аргумента попал в журнал: ${text}`);
});
