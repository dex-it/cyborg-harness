import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveViewRequest, type PluginUi } from '../src/view-files.ts';

async function plugin() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-view-'));
  const dir = path.join(root, 'alice');
  const outside = path.join(root, 'outside');
  await mkdir(path.join(dir, 'ui'), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.js'), 'секрет пользователя');
  const ui: PluginUi = { dir, views: { main: './ui/ui.js' } };
  return { dir, outside, uiOf: (id: string) => (id === 'alice' ? ui : undefined), [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

test('безопасность вида: файл внутри каталога плагина отдаётся (контроль)', async () => {
  await using p = await plugin();
  await writeFile(path.join(p.dir, 'ui', 'ui.js'), 'export {}');
  assert.deepEqual(resolveViewRequest('cyborg-plugin://alice/ui/ui.js', p.uiOf), { kind: 'file', file: path.join(await realpath(p.dir), 'ui', 'ui.js'), type: 'text/javascript; charset=utf-8' });
});

test('безопасность вида: симлинк в каталоге плагина на файл вне него не отдаётся', async () => {
  await using p = await plugin();
  await symlink(path.join(p.outside, 'private.js'), path.join(p.dir, 'ui', 'leak.js'));
  assert.equal(resolveViewRequest('cyborg-plugin://alice/ui/leak.js', p.uiOf), undefined);
});

test('безопасность вида: симлинк на каталог вне плагина не открывает файлы за ним', async () => {
  await using p = await plugin();
  await symlink(p.outside, path.join(p.dir, 'ui', 'out'));
  assert.equal(resolveViewRequest('cyborg-plugin://alice/ui/out/private.js', p.uiOf), undefined);
});
