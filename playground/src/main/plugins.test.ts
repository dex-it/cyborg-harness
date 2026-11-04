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
  assert.match(found.entries.get('files') ?? '', new RegExp(`${path.basename(builtin)}/files/index\\.mjs$`));
  assert.match(found.entries.get('notes') ?? '', /notes\/index\.ts$/);
  assert.equal(found.problems.length, 1);
  assert.match(found.problems[0] ?? '', /broken/);
  assert.deepEqual([...found.origins], [['files', builtin], ['notes', user]]);
});

test('старт: плагин из каталога пользователя - сторонний и не попадает в общую группу хоста', async () => {
  const userData = tmp();
  const builtinDir = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['files', 'notes'], hosts: { ui: ['files', 'notes'] } } }));
  plugin(builtinDir, 'files', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'notes', {}, 'export default {}');
  const kernel = await startPlugins({ userData, builtinDir, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  assert.deepEqual([kernel.hostOf('files'), kernel.hostOf('notes')], ['ui', 'notes']);
  assert.ok(kernel.journal.some((e) => e.kind === 'host-isolated' && e.pluginId === 'notes'));
  await kernel.unload();
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
    activate(ctx) {
      ctx.log(`привет, ${String(ctx.config?.get().who)}`);
    },
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
    { id: 'spare', state: 'disabled', revivable: false, unloaded: false, commands: [], version: '1.0.0', reason: 'не включён в настройках (plugins.enabled)' },
    { id: 'disk', state: 'stopped', revivable: true, unloaded: false, commands: [], version: '1.0.0', host: 'io', reason: 'не поднялся в хосте io: нет диска' },
  ]);
  assert.deepEqual(before.journal.at(-1), { at: 1000, subject: 'disk', plugins: ['disk'], text: 'не поднялся в хосте io: нет диска', level: 'error' });

  broken = false;
  assert.deepEqual(await service.enable('disk'), {});
  assert.equal(service.snapshot().plugins[1]?.state, 'active');
  assert.deepEqual(await service.enable('spare'), { error: 'spare не загружается: причина в журнале' });
  assert.deepEqual(await service.enable(42), { error: 'нет id плагина' });
  assert.deepEqual(await service.crash('disk'), { error: 'у disk нет живого процесса хоста' });
  assert.equal(service.snapshot().canHang, false);
  assert.ok(changes > 3);
  assert.deepEqual(alerts, []);
  await service.unload();
});

test('служба окна: сочетания с конфликтом, перехват нажатия, лента, выгрузка с зависимым и загрузка обратно', async () => {
  const userData = tmp();
  const dir = path.join(userData, 'plugins');
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['voice', 'ear'] } }));
  plugin(dir, 'voice', { provides: { 'demo.echo': '1.0' }, commands: ['voice.ping'], keybindings: [{ key: 'CmdOrCtrl+Shift+E', command: 'voice.ping' }] }, 'export default {}');
  plugin(dir, 'ear', { requires: { 'demo.echo': '^1' }, commands: ['ear.hi', 'ear.fail'], keybindings: [{ key: 'CmdOrCtrl+Shift+E', command: 'ear.hi' }] }, 'export default {}');
  const modules: Record<string, PluginModule> = {
    voice: {
      activate(ctx) {
        ctx.contracts.provide('demo.echo', '1.0', { say: async (text: string) => `эхо: ${text}` });
        ctx.commands.register('voice.ping', () => ctx.log('pong'));
      },
    },
    ear: {
      activate(ctx) {
        ctx.commands.register('ear.hi', async () => ctx.log((await ctx.contracts.get('demo.echo', 1)?.say('привет')) ?? 'тишина'));
        ctx.commands.register('ear.fail', () => {
          throw new Error('не вышло');
        });
      },
    },
  };
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => 5);
  await service.start({
    userData,
    builtinDir: path.join(userData, 'нет'),
    spawnHost: inlineHosts(async (entry) => modules[/\/(\w+)\/index\.mjs$/.exec(entry)?.[1] ?? ''] ?? { activate() {} }),
    platform: 'linux',
    log: () => {},
  });
  const ctrlShiftE = { key: 'E', code: 'KeyE', control: true, alt: false, shift: true, meta: false };

  assert.deepEqual(service.snapshot().keys, [
    { key: 'Ctrl+Shift+E', command: 'ear.hi', pluginId: 'ear', live: true, shadowed: [{ pluginId: 'voice', command: 'voice.ping' }] },
  ]);
  assert.equal(service.press({ ...ctrlShiftE, shift: false }), false, 'свободное сочетание ядро не забирает');
  assert.equal(service.press(ctrlShiftE), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    service.snapshot().feed.map((l) => [l.kind, l.subject, l.text]),
    [
      ['key', 'Ctrl+Shift+E', '→ ear.hi (ear)'],
      ['log', 'ear', 'эхо: привет'],
    ],
  );
  assert.deepEqual(await service.run('ear.fail'), { error: 'не вышло' });
  assert.deepEqual(service.snapshot().feed.at(-1), { at: 5, kind: 'error', subject: 'ear.fail', text: 'не вышло' });

  assert.deepEqual(await service.disable('voice'), {});
  const off = service.snapshot();
  assert.deepEqual(
    off.plugins.map((p) => [p.id, p.state, p.unloaded, p.revivable]),
    [
      ['voice', 'stopped', true, true],
      ['ear', 'stopped', false, false],
    ],
  );
  assert.equal(off.keys[0]?.live, false);
  assert.equal(service.press(ctrlShiftE), false, 'владелец выгружен - нажатие уходит в окно');

  assert.deepEqual(await service.enable('voice'), {});
  assert.deepEqual(
    service.snapshot().plugins.map((p) => [p.id, p.state]),
    [
      ['voice', 'active'],
      ['ear', 'active'],
    ],
  );
  await service.unload();
});
