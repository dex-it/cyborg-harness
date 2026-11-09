import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineHosts } from '../../../core/src/transports.ts';
import type { PluginModule } from '../../../core/src/plugin.ts';
import { WINDOW_OWNER } from '../../../core/src/window-layer.ts';
import type { KeyRow } from '../shared/plugins.ts';
import { discoverPlugins, PluginsService, readSchemaFile, startPlugins } from './plugins.ts';

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

test('воркспейс: битый cyborg.json - жалоба, а не отказ; второй старт на том же воркспейсе получает отказ замка', async () => {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), '{');
  const problems: string[] = [];
  const kernel = await startPlugins({ userData, builtinDir: path.join(userData, 'нет'), spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {}, onProblem: (p) => problems.push(p) });
  assert.ok(problems.some((p) => p.includes('cyborg.json')));
  assert.equal(kernel.workspace, path.join(userData, 'workspace.cyborg.json'));
  assert.equal(fs.readFileSync(path.join(userData, 'cyborg.json'), 'utf8'), '{');
  await kernel.unload();
  assert.ok(!fs.existsSync(`${kernel.workspace}.lock`), 'замок не снят');
  // Живой чужой процесс держит замок: родитель тестового процесса.
  fs.writeFileSync(`${kernel.workspace}.lock`, JSON.stringify({ pid: process.ppid }));
  await assert.rejects(startPlugins({ userData, builtinDir: userData, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} }), /уже открыт процессом/);
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
  plugin(path.join(userData, 'plugins'), 'spare', { ui: { views: { main: './ui/ui.js' } } }, 'export default {}');
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
    { id: 'spare', state: 'disabled', revivable: false, unloaded: false, commands: [], permissions: [], version: '1.0.0', reason: 'не включён в настройках (plugins.enabled)' },
    { id: 'disk', state: 'stopped', revivable: true, unloaded: false, commands: [], permissions: [], version: '1.0.0', host: 'io', reason: 'не поднялся в хосте io: нет диска' },
  ]);
  // Не включённому в настройках плагину фрейма нет, метка раскладки не склеена с «выключен».
  assert.deepEqual(before.layout, [{ pluginId: 'spare', kind: 'view', name: 'main', area: 'sidebar', order: 1000, mark: 'not-enabled' }]);
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

test('служба окна: сочетания с конфликтом, перехват нажатия, лента, выгрузка с зависимым и загрузка обратно', async (t) => {
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
  // Упавшая проверка не должна оставлять слежение за файлом воркспейса: с ним процесс теста не завершается и CI висит до лимита задачи.
  t.after(() => service.unload());
  const ctrlShiftE = { key: 'E', code: 'KeyE', control: true, alt: false, shift: true, meta: false };

  const own = (keys: readonly KeyRow[]) => keys.filter((k) => k.pluginId !== WINDOW_OWNER);
  assert.deepEqual(own(service.snapshot().keys), [
    { key: 'Ctrl+Shift+E', command: 'ear.hi', pluginId: 'ear', live: true, shadowed: [{ pluginId: 'voice', command: 'voice.ping' }] },
  ]);
  assert.equal(service.press({ ...ctrlShiftE, shift: false }), false, 'свободное сочетание ядро не забирает');
  assert.equal(service.press(ctrlShiftE), true);
  // Запись ear.hi идёт после асинхронного вызова контракта; под нагрузкой фиксированной паузы в 20 мс не хватало.
  for (let i = 0; i < 150 && service.snapshot().feed.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
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
  assert.equal(own(off.keys)[0]?.live, false);
  assert.equal(service.press(ctrlShiftE), false, 'владелец выгружен - нажатие уходит в окно');

  assert.deepEqual(await service.enable('voice'), {});
  assert.deepEqual(
    service.snapshot().plugins.map((p) => [p.id, p.state]),
    [
      ['voice', 'active'],
      ['ear', 'active'],
    ],
  );
});

test('виды: адрес у плагина с ui в манифесте и у снятого, лента вида - только свои строки, команда и контракт из вида - только свои', async () => {
  const userData = tmp();
  const dir = path.join(userData, 'plugins');
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['face', 'voice'] } }));
  plugin(dir, 'face', { commands: { 'face.hi': {}, 'face.sum': { args: ['number', 'number'] } }, optional: { 'demo.echo': '^1' }, ui: { views: { main: './ui/ui.js' } } }, 'export default {}');
  plugin(dir, 'voice', { commands: ['voice.ping'], provides: { 'demo.echo': '1.0' } }, 'export default {}');
  const modules: Record<string, PluginModule> = {
    face: {
      activate(ctx) {
        ctx.commands.register('face.hi', () => ctx.log('привет'));
        ctx.commands.register('face.sum', (a, b) => Number(a) + Number(b));
      },
    },
    voice: {
      activate(ctx) {
        ctx.commands.register('voice.ping', () => ctx.log('pong'));
        ctx.contracts.provide('demo.echo', '1.0', { say: async (text: string) => `эхо: ${text}`, onMessage: () => ({ dispose() {} }) } as never);
      },
    },
  };
  const pushed: [string, string][] = [];
  const service = new PluginsService({ changed: () => {}, alert: () => {}, log: (id, line) => pushed.push([id, line.text]) }, () => 7);
  await service.start({
    userData,
    builtinDir: path.join(userData, 'нет'),
    spawnHost: inlineHosts(async (entry) => modules[/\/(\w+)\/index\.mjs$/.exec(entry)?.[1] ?? ''] ?? { activate() {} }),
    log: () => {},
  });

  assert.deepEqual(service.snapshot().layout, [{ pluginId: 'face', kind: 'view', name: 'main', area: 'sidebar', order: 1000, url: 'cyborg-plugin://face/?view=main' }]);
  assert.deepEqual(service.uiOf('face'), { dir: path.join(dir, 'face'), views: { main: './ui/ui.js' } });
  assert.equal(service.uiOf('voice'), undefined);
  assert.deepEqual(await service.runFor('face', 'face.hi'), {});
  assert.deepEqual(await service.runFor('face', 'face.sum', [2, 3]), { value: 5 });
  assert.deepEqual(await service.runFor('face', 'face.sum', 'x'), { error: 'face.sum: аргументы - не массив' });
  assert.deepEqual(await service.runFor('face', 'constructor'), { error: 'constructor: не команда плагина face' });

  assert.deepEqual(service.contractFor('face', 'demo.echo', 1), { value: true });
  assert.deepEqual(await service.callFor('face', 'demo.echo', 1, 'say', ['вид']), { value: 'эхо: вид' });
  assert.match((await service.callFor('voice', 'demo.echo', 1, 'say', ['x'])).error ?? '', /NotDeclared|нет в requires/, 'вид вызвал контракт, которого нет в манифесте его плагина');
  assert.match(service.contractFor('face', 'demo.chat', 1).error ?? '', /нет в requires/);
  assert.deepEqual(await service.callFor('face', 'demo.echo', 1, 'constructor', []), { error: 'demo.echo.constructor: не метод контракта' });
  assert.match((await service.callFor('face', 'demo.echo', 1, 'onMessage', [])).error ?? '', /structuredClone/, 'подписка из вида - отказ границы хоста');
  assert.deepEqual(await service.callFor('face', 'demo.echo', '1', 'say', []), { error: 'вызов контракта: ожидаются имя, мажорная версия, метод и аргументы' });
  assert.deepEqual(await service.run('voice.ping'), {});
  assert.deepEqual(await service.runFor('face', 'voice.ping'), { error: 'voice.ping: не команда плагина face' });
  assert.deepEqual(await service.runFor('face', 42), { error: 'нет имени команды' });
  assert.deepEqual(service.logsOf('face'), [{ at: 7, kind: 'log', subject: 'face', text: 'привет' }]);
  assert.deepEqual(pushed, [
    ['face', 'привет'],
    ['voice', 'pong'],
  ]);

  assert.deepEqual(await service.disable('voice'), {});
  assert.deepEqual(service.contractFor('face', 'demo.echo', 1), { value: false });
  assert.deepEqual(await service.callFor('face', 'demo.echo', 1, 'say', ['x']), { error: 'demo.echo: поставщика сейчас нет' });
  assert.deepEqual(await service.disable('face'), {});
  const face = service.snapshot().plugins.find((p) => p.id === 'face');
  assert.equal(face?.state, 'stopped');
  assert.deepEqual(service.snapshot().layout, [{ pluginId: 'face', kind: 'view', name: 'main', area: 'sidebar', order: 1000, mark: 'disabled', url: 'cyborg-plugin://face/?view=main' }], 'снятому плагину окно рисует заглушку на месте вида');
  await service.unload();
});

test('схема раздела: файл из каталога плагина проверяет config до активации, ссылка наружу - отказ', async () => {
  const userData = tmp();
  const file = path.join(userData, 'cyborg.json');
  fs.writeFileSync(file, JSON.stringify({ plugins: { enabled: ['timer', 'thief'] }, settings: { timer: { minutes: 0 } } }));
  const dir = path.join(userData, 'plugins');
  plugin(dir, 'timer', { config: { version: 1, schema: './config.schema.json' } }, 'export default {}');
  fs.writeFileSync(path.join(dir, 'timer', 'config.schema.json'), JSON.stringify({ type: 'object', properties: { minutes: { type: 'integer', minimum: 1 } } }));
  plugin(dir, 'thief', { config: { version: 1, schema: './s.json' } }, 'export default {}');
  fs.symlinkSync(file, path.join(dir, 'thief', 's.json'));
  assert.throws(() => readSchemaFile(path.join(dir, 'thief'), './s.json'), /вне каталога плагина/);
  const kernel = await startPlugins({
    userData,
    builtinDir: path.join(userData, 'нет'),
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    log: () => undefined,
  });
  assert.deepEqual(kernel.active, []);
  assert.deepEqual(
    kernel.journal.filter((e) => e.kind === 'config'),
    [
      { pluginId: 'thief', kind: 'config', result: { status: 'invalid', errors: ['./s.json: файл вне каталога плагина'] } },
      { pluginId: 'timer', kind: 'config', result: { status: 'invalid', errors: ['/minutes: ожидается >= 1'] } },
    ],
  );
  await kernel.unload();
});

test('plugins.enabled из файла воркспейса без перезапуска: убранный выключается, вернувшийся включается, новый ждёт перезапуска', async (t) => {
  const userData = tmp();
  const ws = path.join(userData, 'w.cyborg.json');
  const write = (enabled: string[]) => fs.writeFileSync(ws, JSON.stringify({ cyborg: 2, plugins: { enabled }, settings: {} }));
  write(['a', 'b']);
  const dir = path.join(userData, 'plugins');
  for (const id of ['a', 'b', 'c']) plugin(dir, id, {}, 'export default {}');
  const problems: string[] = [];
  let applied = 0;
  const kernel = await startPlugins({
    userData,
    workspace: ws,
    builtinDir: path.join(userData, 'нет'),
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    log: () => undefined,
    onProblem: (p) => problems.push(p),
    onEnabled: () => applied++,
  });
  // Без выгрузки упавший тест держит слежение, и процесс файла не выходит.
  t.after(() => kernel.unload());
  const until = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok(), what);
  };
  assert.deepEqual(kernel.active, ['a', 'b']);
  write(['a']);
  await until('b выключен', () => applied === 1);
  assert.deepEqual(kernel.active, ['a']);
  write(['a', 'b', 'c']);
  await until('b включён', () => applied === 2);
  assert.deepEqual(kernel.active, ['a', 'b']);
  assert.deepEqual(problems, ['plugins.enabled: c - включатся после перезапуска']);
});
