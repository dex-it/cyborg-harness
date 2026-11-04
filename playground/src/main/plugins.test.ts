import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineHosts } from '../../../core/src/transports.ts';
import type { PluginModule } from '../../../core/src/plugin.ts';
import { discoverPlugins, PluginsService, readUserConfig, startPlugins } from './plugins.ts';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-plugins-'));
}

function plugin(dir: string, id: string, manifest: Record<string, unknown>, code?: string, file = 'index.mjs'): void {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'manifest.json'), JSON.stringify({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...manifest }));
  if (code) fs.writeFileSync(path.join(dir, id, file), code);
}

test('поиск: встроенные раньше пользовательских, повтор id - второму не достаётся точка входа, битый JSON - в problems', () => {
  const builtin = tmp();
  const user = tmp();
  plugin(builtin, 'files', {}, 'export default {}');
  plugin(user, 'files', {}, 'export default {}', 'index.ts');
  plugin(user, 'notes', {}, 'export default {}', 'index.ts');
  fs.mkdirSync(path.join(user, 'broken'));
  fs.writeFileSync(path.join(user, 'broken', 'manifest.json'), '{ нет');
  const found = discoverPlugins([builtin, user, path.join(user, 'нет-каталога')]);
  assert.equal(found.manifests.length, 3);
  assert.match(found.entries.get('files')!, new RegExp(`${path.basename(builtin)}/files/index\\.mjs$`));
  assert.match(found.entries.get('notes')!, /notes\/index\.ts$/);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0], /broken/);
});

test('cyborg.json: нет файла - пусто без жалобы, битый - пусто с жалобой, мусор в полях отброшен', () => {
  const dir = tmp();
  const file = path.join(dir, 'cyborg.json');
  assert.deepEqual(readUserConfig(file), { config: { enabled: [], hosts: {} } });
  fs.writeFileSync(file, '{');
  assert.match(readUserConfig(file).problem!, /cyborg\.json/);
  fs.writeFileSync(file, JSON.stringify({ plugins: { enabled: ['a', 1], hosts: { ui: ['a', null], bad: 'x' } } }));
  assert.deepEqual(readUserConfig(file).config, { enabled: ['a'], hosts: { ui: ['a'], bad: [] } });
});

test('старт: включённый плагин активен, миграция config пишется в settings, раздел plugins не теряется', async () => {
  const userData = tmp();
  const file = path.join(userData, 'cyborg.json');
  const plugins = { enabled: ['greeter'] };
  fs.writeFileSync(file, JSON.stringify({ plugins, settings: { greeter: { name: 'мир' } } }));
  plugin(path.join(userData, 'plugins'), 'greeter', { config: { version: 2 } }, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'idle', {}, 'export default {}');
  const greeter: PluginModule = {
    config: { migrate: (_, d) => ({ who: d.name }) },
    activate: (ctx) => ctx.log(`привет, ${ctx.config!.get().who}`),
  };
  const lines: string[] = [];
  const kernel = await startPlugins({
    userData,
    builtinDir: path.join(userData, 'нет'),
    spawnHost: inlineHosts(async (entry) => {
      assert.match(entry, /^file:.*greeter\/index\.mjs$/);
      return greeter;
    }),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(kernel.active, ['greeter']);
  assert.ok(lines.includes('[plugins] greeter: привет, мир'));
  assert.ok(lines.some((l) => l.includes('"pluginId":"idle","kind":"disabled"')));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { plugins, settings: { greeter: { $version: 2, who: 'мир' } } });
  await kernel.unload();
});

test('служба окна: снимок с причиной и журналом, «Включить снова» поднимает не поднявшийся плагин', async () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['disk'], hosts: { io: ['disk'] } } }));
  plugin(path.join(userData, 'plugins'), 'disk', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'spare', {}, 'export default {}');
  fs.mkdirSync(path.join(userData, 'plugins', 'broken'));
  let broken = true;
  let changes = 0;
  const alerts: string[] = [];
  const service = new PluginsService({ changed: () => changes++, alert: (title) => alerts.push(title) }, () => 1000);
  assert.equal(service.snapshot().phase, 'starting');
  await service.start({
    userData,
    builtinDir: path.join(userData, 'нет'),
    spawnHost: inlineHosts(async () => ({
      activate() {
        if (broken) throw new Error('нет диска');
      },
    })),
    log: () => {},
  });
  const before = service.snapshot();
  assert.equal(before.phase, 'ready');
  assert.equal(before.problems.length, 1);
  assert.deepEqual(before.plugins, [
    { id: 'spare', state: 'disabled', revivable: false, version: '1.0.0', reason: 'не включён в настройках (plugins.enabled)' },
    { id: 'disk', state: 'stopped', revivable: true, version: '1.0.0', host: 'io', reason: 'не поднялся в хосте io: нет диска' },
  ]);
  assert.deepEqual(before.journal.at(-1), { at: 1000, subject: 'disk', plugins: ['disk'], text: 'не поднялся в хосте io: нет диска', level: 'error' });

  broken = false;
  assert.deepEqual(await service.revive('disk'), {});
  assert.equal(service.snapshot().plugins[1].state, 'active');
  assert.deepEqual(await service.revive('spare'), { error: 'spare не загружается: причина в журнале' });
  assert.deepEqual(await service.revive(42), { error: 'нет id плагина' });
  assert.ok(changes > 3);
  assert.deepEqual(alerts, []);
  await service.unload();
});
