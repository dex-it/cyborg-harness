import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import type { ProtectedFileRule } from '../src/os-gateway.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// TR-25: механизм защиты файлов по имени в любом месте дерева (`OsEnvironment.protectedFiles`). Ядро не знает, что в файлах лежит: правила - данные приложения.
// Здесь правила выдуманные; перечень настроек агента и его поведение - electron/test/agent-files.test.ts.

const RULES: readonly ProtectedFileRule[] = [
  { path: ['secret.json'], closed: 'all', label: 'ключи' },
  { path: ['notes.md'], closed: 'write' },
  { path: ['.cfg', 'main*.json'], closed: 'all' },
  { path: ['.home-only'], under: 'home', closed: 'all' },
  { path: ['.cfg', 'scripts'], tree: true, closed: 'write' },
];

const manifest = (id: string, permissions: unknown) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, permissions });

async function box(protectedFiles: readonly ProtectedFileRule[] | 'none' = RULES) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-protfiles-')));
  const dirs = { data: path.join(root, 'data'), temp: path.join(root, 'temp'), work: path.join(root, 'work'), home: path.join(root, 'home') };
  for (const d of [dirs.work, dirs.home]) await mkdir(d, { recursive: true });
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({ activate: (ctx: PluginContext) => void contexts.set(entry, ctx) })),
    enabled: ['rw'],
    manifests: [manifest('rw', { 'fs.read': [dirs.work, dirs.home], 'fs.write': [dirs.work, dirs.home] })],
    os: { dataDir: dirs.data, tempDir: dirs.temp, home: dirs.home, ...(protectedFiles !== 'none' && { protectedFiles }) },
  });
  const denied = () => k.journal.filter((e) => e.kind === 'denied').map((e) => e.detail);
  return { k, ...dirs, fs: contexts.get('rw')!.os.fs, denied, [Symbol.asyncDispose]: () => rm(dirs.data, { recursive: true, force: true }).then(() => rm(root, { recursive: true, force: true })) };
}

test('ST-3001/12: правила по имени: запись закрыта везде, где совпал хвост пути; чтение - только у closed: all; метка идёт в слова отказа', async () => {
  await using b = await box();
  for (const target of [path.join(b.work, 'secret.json'), path.join(b.work, 'deep', 'er', 'SECRET.json'), path.join(b.work, 'notes.md'), path.join(b.work, '.cfg', 'main.json'), path.join(b.work, '.cfg', 'main.local.json'), path.join(b.work, '.cfg', 'scripts', 'a', 'b.sh'), path.join(b.work, 'secret.json.bak')]) {
    await assert.rejects(b.fs.writeText(target, 'x'), { code: 'PermissionDenied' }, target);
  }
  assert.ok(b.denied().some((d) => d.includes('защищённый путь (ключи)')), `слова отказа с меткой: ${JSON.stringify(b.denied())}`);
  await writeFile(path.join(b.work, 'secret.json'), '{}');
  await writeFile(path.join(b.work, 'notes.md'), 'текст');
  await assert.rejects(b.fs.readText(path.join(b.work, 'secret.json')), { code: 'PermissionDenied' });
  assert.equal(await b.fs.readText(path.join(b.work, 'notes.md')), 'текст', 'closed: write - читать можно');
  await assert.rejects(b.fs.remove(path.join(b.work, 'notes.md')), { code: 'PermissionDenied' });
});

test('ST-3001/12: правила не задевают чужие имена и глубину: хвост пути, а не подстрока; под home - только прямо в нём', async () => {
  await using b = await box();
  for (const ok of ['my-secret.json', 'secret.jsonx', 'notes.md.d/x.txt', 'cfg/main.json', '.cfg/other.json', '.cfg/scripts-extra/a.sh', '.cfg/x/main.json']) {
    const file = path.join(b.work, ok);
    await mkdir(path.dirname(file), { recursive: true });
    await b.fs.writeText(file, 'можно');
    assert.equal(await readFile(file, 'utf8'), 'можно', ok);
  }
  await assert.rejects(b.fs.writeText(path.join(b.home, '.home-only'), 'x'), { code: 'PermissionDenied' }, 'под home - закрыто');
  await b.fs.writeText(path.join(b.work, '.home-only'), 'вне home - не то правило');
  await mkdir(path.join(b.home, 'sub'), { recursive: true });
  await b.fs.writeText(path.join(b.home, 'sub', '.home-only'), 'глубже home - не то правило');
  assert.deepEqual(b.denied().length, 1);
});

test('ST-3001/12: ссылка не обходит правило: ни по имени ссылки, ни по настоящему пути', async () => {
  await using b = await box();
  const plain = path.join(b.work, 'plain.txt');
  await writeFile(plain, 'обычный');
  await symlink(plain, path.join(b.work, 'notes.md'));
  await assert.rejects(b.fs.writeText(path.join(b.work, 'notes.md'), 'x'), { code: 'PermissionDenied' }, 'по имени ссылки');
  assert.equal(await readFile(plain, 'utf8'), 'обычный');
  await writeFile(path.join(b.work, 'secret.json'), '{}');
  await symlink(path.join(b.work, 'secret.json'), path.join(b.work, 'alias.txt'));
  await assert.rejects(b.fs.readText(path.join(b.work, 'alias.txt')), { code: 'PermissionDenied' }, 'по настоящему пути');
});

test('ST-3001/12: без правил (protectedFiles не задан или пуст) ядро ничего сверх protectedPaths не закрывает', async () => {
  for (const rules of ['none', []] as const) {
    await using b = await box(rules);
    await b.fs.writeText(path.join(b.work, 'secret.json'), '{}');
    assert.equal(await b.fs.readText(path.join(b.work, 'secret.json')), '{}');
  }
});
