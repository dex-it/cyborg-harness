import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineHosts } from '@cyborg-harness/core';
import type { PluginModule } from '@cyborg-harness/core';
import { WINDOW_OWNER } from '@cyborg-harness/core';
import type { KeyRow } from '../src/snapshot.ts';
import { discoverPlugins, PluginsService, readSchemaFile, startPlugins } from '../src/plugins.ts';

// Контракт для плагинов-подделок теста: карту контрактов приложения (playground/plugins/contracts.ts) пакет не знает.
declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'demo.echo': { 1: { say(text: string): Promise<string> } };
  }
}

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
  assert.equal(found.manifests.length, 2, 'манифест второго files не передаётся ядру: иначе граф откажет обоим');
  assert.match(found.entries.get('files') ?? '', new RegExp(`${path.basename(builtin)}/files/index\\.mjs$`));
  assert.match(found.entries.get('notes') ?? '', /notes\/index\.ts$/);
  assert.equal(found.problems.length, 2);
  assert.ok(found.problems.some((p) => p.includes('broken')));
  assert.ok(found.problems.some((p) => p.includes(`повтор id files в ${path.join(user, 'files')}: действует ${path.join(builtin, 'files')}`)));
  assert.deepEqual([...found.origins], [['files', builtin], ['notes', user]]);
});

test('поиск: повтор id внутри одного каталога называет оба каталога плагина, действует первый по имени', () => {
  const user = tmp();
  fs.mkdirSync(path.join(user, 'b'));
  fs.writeFileSync(path.join(user, 'b', 'manifest.json'), JSON.stringify({ id: 'z' }));
  fs.mkdirSync(path.join(user, 'a'));
  fs.writeFileSync(path.join(user, 'a', 'manifest.json'), JSON.stringify({ id: 'z' }));
  const found = discoverPlugins([user]);
  assert.deepEqual(found.problems, [`повтор id z в ${path.join(user, 'b')}: действует ${path.join(user, 'a')}`]);
});

test('старт с флагом: встроенный плагин активен при одноимённом пользовательском, второй пропущен с записью в problems', async (t) => {
  const userData = tmp();
  const builtinDir = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['pin-lock', 'echo'] } }));
  plugin(builtinDir, 'pin-lock', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'pin-lock', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'echo', {}, 'export default {}');
  const problems: string[] = [];
  const kernel = await startPlugins({ userData, builtinDir, userPlugins: true, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {}, onProblem: (p) => problems.push(p) });
  t.after(() => kernel.unload());
  assert.deepEqual([...kernel.active].sort(), ['echo', 'pin-lock']);
  assert.ok(!kernel.journal.some((e) => e.pluginId === 'pin-lock' && e.kind === 'rejected'), 'встроенный не отвергнут');
  assert.ok(problems.some((p) => p.includes('повтор id pin-lock')));
});

test('окно: повтор id пользовательского плагина виден в «Не дошло до ядра», строка встроенного - bundled и active', async (t) => {
  const userData = tmp();
  const builtinDir = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['pin-lock'] } }));
  plugin(builtinDir, 'pin-lock', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'pin-lock', {}, 'export default {}');
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => 1000);
  await service.start({ userData, builtinDir, userPlugins: true, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  t.after(() => service.unload());
  const snapshot = service.snapshot();
  assert.ok(snapshot.problems.some((p) => p.includes('повтор id pin-lock')), 'причина пропуска не дошла до окна');
  assert.deepEqual(snapshot.plugins.map((r) => [r.id, r.origin, r.state]), [['pin-lock', 'bundled', 'active']]);
});

test('старт: плагин из каталога пользователя - сторонний и не попадает в общую группу хоста', async () => {
  const userData = tmp();
  const builtinDir = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['files', 'notes'], hosts: { ui: ['files', 'notes'] } } }));
  plugin(builtinDir, 'files', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'notes', {}, 'export default {}');
  const kernel = await startPlugins({ userData, builtinDir, userPlugins: true, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  assert.deepEqual([kernel.hostOf('files'), kernel.hostOf('notes')], ['ui', 'notes']);
  assert.ok(kernel.journal.some((e) => e.kind === 'host-isolated' && e.pluginId === 'notes'));
  await kernel.unload();
});

test('политика по умолчанию: каталог пользователя не читается, плагин оттуда не загружен, в журнале причина - его нет среди найденных; в лог идёт подсказка про флаг', async () => {
  const userData = tmp();
  const builtinDir = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['files', 'notes'] } }));
  plugin(builtinDir, 'files', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'notes', {}, 'export default {}');
  const lines: string[] = [];
  const found: string[][] = [];
  const kernel = await startPlugins({ userData, builtinDir, spawnHost: inlineHosts(async () => ({ activate() {} })), log: (l) => lines.push(l), onDiscovered: (d) => found.push([...d.origins.keys()]) });
  assert.deepEqual(found, [['files']], 'каталог пользователя в поиск не попал');
  assert.deepEqual(kernel.active, ['files']);
  assert.ok(kernel.journal.some((e) => e.kind === 'not-found' && e.pluginId === 'notes'));
  assert.ok(!kernel.journal.some((e) => e.kind === 'third-party'));
  assert.ok(lines.some((l) => l.includes('--user-plugins') && l.includes(path.join(userData, 'plugins'))), 'нет подсказки про флаг');
  await kernel.unload();

  // Пустой или отсутствующий каталог подсказки не заслуживает.
  const quiet: string[] = [];
  const clean = tmp();
  const again = await startPlugins({ userData: clean, builtinDir, spawnHost: inlineHosts(async () => ({ activate() {} })), log: (l) => quiet.push(l) });
  assert.ok(!quiet.some((l) => l.includes('--user-plugins')));
  await again.unload();
});

test('политика с флагом: плагин из каталога пользователя загружен, в журнале third-party, строка окна помечена origin user и показывает права словами', async () => {
  const userData = tmp();
  const builtinDir = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['files', 'notes', 'idle'] } }));
  plugin(builtinDir, 'files', {}, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'notes', { permissions: { shell: ['any'] } }, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'idle', {}, 'export default {}');
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => 1000);
  await service.start({ userData, builtinDir, userPlugins: true, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  const snapshot = service.snapshot();
  const row = (id: string) => snapshot.plugins.find((r) => r.id === id);
  assert.equal(row('files')?.origin, 'bundled');
  assert.equal(row('notes')?.origin, 'user');
  assert.equal(row('idle')?.origin, 'user');
  assert.ok((row('notes')?.permissions.length ?? 0) > 0, 'права словами у стороннего видны');
  assert.equal(snapshot.userPlugins, true);
  const line = snapshot.journal.find((l) => l.subject === 'notes' && l.level === 'warn' && l.text.includes('сторонний плагин'));
  assert.ok(line, 'в журнале окна нет записи о стороннем плагине');
  assert.deepEqual(line.plugins, ['notes']);
  assert.ok(!snapshot.journal.some((l) => l.subject === 'files' && l.text.includes('сторонний')), 'встроенный не помечен');
  await service.unload();

  const off = new PluginsService({ changed: () => {}, alert: () => {} });
  await off.start({ userData: tmp(), builtinDir, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  assert.equal(off.snapshot().userPlugins, false);
  assert.ok(off.snapshot().plugins.every((r) => r.origin === 'bundled'));
  await off.unload();
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
    userPlugins: true,
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

test('служба окна: снимок с причиной и журналом, «Включить снова» поднимает не поднявшийся плагин', async (t) => {
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
    userPlugins: true,
    spawnHost: inlineHosts(async () => ({
      activate() {
        if (broken) throw new Error('нет диска');
      },
    })),
    log: () => {},
  });
  // Без выгрузки упавшая проверка держит слежение, и процесс файла не выходит.
  t.after(() => service.unload());
  const before = service.snapshot();
  assert.equal(before.phase, 'ready');
  assert.equal(before.problems.length, 1);
  assert.deepEqual(before.plugins, [
    { id: 'spare', origin: 'user', state: 'disabled', revivable: false, unloaded: false, commands: [], permissions: [], version: '1.0.0', reason: 'не включён в настройках (plugins.enabled)' },
    { id: 'disk', origin: 'user', state: 'stopped', revivable: true, unloaded: false, commands: [], permissions: [], version: '1.0.0', host: 'io', reason: 'не поднялся в хосте io: нет диска' },
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
    userPlugins: true,
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

test('служба окна: динамическое сочетание кнопки идёт с аргументами и условиями, автоповтор и поле ввода его не запускают, видимость сообщает окно', async (t) => {
  const userData = tmp();
  const dir = path.join(userData, 'plugins');
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['buttons'] } }));
  plugin(dir, 'buttons', { commands: { 'buttons.run': { args: ['string'] } }, ui: { views: { main: './ui.js' } } }, 'export default {}');
  const ran: unknown[][] = [];
  const modules: Record<string, PluginModule> = {
    buttons: {
      async activate(ctx) {
        ctx.commands.register('buttons.run', (name) => void ran.push([name]));
        await ctx.keys.register({ key: 'F2', command: 'buttons.run', args: ['build'], when: { visible: true } });
        await ctx.keys.register({ key: 'F3', command: 'buttons.run', args: ['again'], when: { repeat: true, input: 'any' } });
      },
    },
  };
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => 5);
  await service.start({
    userData,
    builtinDir: path.join(userData, 'нет'),
    userPlugins: true,
    spawnHost: inlineHosts(async (entry) => modules[/\/(\w+)\/index\.mjs$/.exec(entry)?.[1] ?? ''] ?? { activate() {} }),
    platform: 'linux',
    log: () => {},
  });
  t.after(() => service.unload());
  const f = (key: string) => ({ key, code: key, control: false, alt: false, shift: false, meta: false });

  assert.equal(service.press(f('F2')), false, 'вид не показан - сочетание молчит');
  service.setViewVisible('buttons', true);
  service.setViewVisible('ghost', true);
  service.setInputFocus('text');
  assert.equal(service.press(f('F2')), false, 'фокус в поле ввода');
  service.setInputFocus('terminal');
  assert.equal(service.press(f('F2'), true), false, 'автоповтор');
  assert.equal(service.press(f('F2')), true, 'терминал - не поле ввода');
  service.setInputFocus('nonsense');
  service.setInputFocus('text');
  assert.equal(service.press(f('F3'), true), true, 'repeat и input: any');
  for (let i = 0; i < 150 && ran.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ran, [['build'], ['again']]);
  assert.deepEqual(
    service.snapshot().keys.filter((k) => k.pluginId === 'buttons').map((k) => [k.key, k.live]),
    [
      ['F2', true],
      ['F3', true],
    ],
  );
});

test('виды: адрес у плагина с ui в манифесте и у снятого, лента вида - только свои строки, команда и контракт из вида - только свои', async () => {
  const userData = tmp();
  const dir = path.join(userData, 'plugins');
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['face', 'voice'] } }));
  plugin(dir, 'face', { commands: { 'face.hi': {}, 'face.sum': { args: ['number', 'number'] } }, optional: { 'demo.echo': '^1' }, ui: { views: { main: './ui/ui.js' } } }, 'export default {}');
  plugin(dir, 'voice', { commands: { 'voice.ping': { callers: 'plugins' } }, provides: { 'demo.echo': '1.0' } }, 'export default {}');
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
  const pushed: [string, string, string | undefined][] = [];
  const service = new PluginsService({ changed: () => {}, alert: () => {}, log: (id, line, group) => pushed.push([id, line.text, group]) }, () => 7);
  await service.start({
    userData,
    builtinDir: path.join(userData, 'нет'),
    userPlugins: true,
    spawnHost: inlineHosts(async (entry) => modules[/\/(\w+)\/index\.mjs$/.exec(entry)?.[1] ?? ''] ?? { activate() {} }),
    log: () => {},
  });

  assert.deepEqual(service.snapshot().layout, [{ pluginId: 'face', kind: 'view', name: 'main', area: 'sidebar', order: 1000, url: 'cyborg-plugin://face/face/?view=main' }]);
  assert.deepEqual(service.uiOf('face'), { dir: path.join(dir, 'face'), group: 'face', views: { main: './ui/ui.js' } });
  assert.equal(service.uiOf('voice'), undefined);
  assert.deepEqual(service.snapshot().plugins.find((p) => p.id === 'voice')?.permissions, ['другие плагины могут звать команды: voice.ping'], 'открытые чужим команды - в правах словами');
  assert.deepEqual(service.snapshot().plugins.find((p) => p.id === 'face')?.permissions, []);
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
    ['face', 'привет', 'face'],
    ['voice', 'pong', undefined],
  ], 'лог идёт с группой рендера плагина: у плагина без видов её нет');

  assert.deepEqual(await service.disable('voice'), {});
  assert.deepEqual(service.contractFor('face', 'demo.echo', 1), { value: false });
  assert.deepEqual(await service.callFor('face', 'demo.echo', 1, 'say', ['x']), { error: 'demo.echo: поставщика сейчас нет' });
  assert.deepEqual(await service.disable('face'), {});
  const face = service.snapshot().plugins.find((p) => p.id === 'face');
  assert.equal(face?.state, 'stopped');
  assert.deepEqual(service.snapshot().layout, [{ pluginId: 'face', kind: 'view', name: 'main', area: 'sidebar', order: 1000, mark: 'disabled', url: 'cyborg-plugin://face/face/?view=main' }], 'снятому плагину окно рисует заглушку на месте вида');
  await service.unload();
});

test('группы рендера: виды плагинов поставки в одной группе делят origin, адрес несёт плагина; сторонний - по воле владельца, с предупреждением в строке плагина', async () => {
  const userData = tmp();
  const builtinDir = tmp();
  // cyborg.json в userData - слой пользователя: owner посадил guest в duo. mine просит duo только манифестом, no-way - только воркспейсом.
  fs.writeFileSync(
    path.join(userData, 'cyborg.json'),
    JSON.stringify({ plugins: { enabled: ['alice', 'bob', 'echo', 'guest', 'mine'], uiGroups: { duo: ['alice', 'bob', 'guest'], 'bad name': ['echo'] } } }),
  );
  const view = { ui: { views: { main: './ui/ui.js' } } };
  for (const id of ['alice', 'bob', 'echo']) plugin(builtinDir, id, view, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'guest', { ui: { views: { main: './ui/ui.js', side: './ui/side.js' } } }, 'export default {}');
  plugin(path.join(userData, 'plugins'), 'mine', { ui: { views: { main: './ui/ui.js' }, group: 'duo' } }, 'export default {}');
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => 1);
  await service.start({ userData, builtinDir, userPlugins: true, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  try {
    const snapshot = service.snapshot();
    const urls = snapshot.layout.map((e) => [e.pluginId, e.name, e.url]);
    assert.deepEqual(urls, [
      ['alice', 'main', 'cyborg-plugin://duo/alice/?view=main'],
      ['bob', 'main', 'cyborg-plugin://duo/bob/?view=main'],
      ['echo', 'main', 'cyborg-plugin://echo/echo/?view=main'],
      ['guest', 'main', 'cyborg-plugin://duo/guest/?view=main'],
      ['guest', 'side', 'cyborg-plugin://duo/guest/?view=side'],
      ['mine', 'main', 'cyborg-plugin://mine/mine/?view=main'],
    ]);
    assert.deepEqual(snapshot.plugins.map((p) => [p.id, p.group]), [['alice', 'duo'], ['bob', 'duo'], ['echo', 'echo'], ['guest', 'duo'], ['mine', 'mine']]);
    // Предупреждение о группе - у стороннего: посаженного владельцем в общую и не получившего её; у плагина поставки его нет.
    const warning = (id: string) => snapshot.plugins.find((p) => p.id === id)?.groupWarning;
    assert.match(warning('guest') ?? '', /сторонний плагин по воле владельца в общей группе рендера duo: он видит DOM и хранилище origin плагинов alice, bob/);
    assert.match(warning('mine') ?? '', /сторонний плагин не делит группу рендера: группа duo не действует, работает в своей mine/);
    assert.equal(warning('alice'), undefined);
    assert.equal(warning('echo'), undefined);
    assert.ok(snapshot.problems.some((p) => p.includes('plugins.uiGroups.bad name')), 'ошибка поля plugins.uiGroups - в «Не дошло до ядра»');
    assert.equal(snapshot.journal.filter((l) => l.plugins.includes('guest') && l.text.includes('в общей группе рендера')).length, 1);
    // Протокол: плагин обслуживается только под хостом своей группы.
    assert.deepEqual([service.groupOf('alice'), service.groupOf('bob'), service.groupOf('guest'), service.groupOf('nobody')], ['duo', 'duo', 'duo', undefined]);
    assert.equal(service.uiOf('alice')?.group, 'duo');
    assert.equal(service.uiOf('mine')?.group, 'mine');
  } finally {
    await service.unload();
  }
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
    userPlugins: true,
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
    userPlugins: true,
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

test('несколько видов: оба адреса в раскладке по порядку манифеста; у плагина без ui видов нет, невключённый помечен', async () => {
  const userData = tmp();
  const dir = path.join(userData, 'plugins');
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled: ['duo', 'solo', 'bare'] } }));
  plugin(dir, 'duo', { ui: { views: { main: './ui/main.js', 'side-tree': './ui/tree.js' } } }, 'export default {}');
  plugin(dir, 'solo', { ui: { views: { main: './ui/main.js' } } }, 'export default {}');
  plugin(dir, 'bare', {}, 'export default {}');
  plugin(dir, 'spare', { ui: { views: { main: './ui/main.js' } } }, 'export default {}');
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => 1);
  await service.start({ userData, builtinDir: path.join(userData, 'нет'), userPlugins: true, spawnHost: inlineHosts(async () => ({ activate() {} })), log: () => {} });
  try {
    const layout = service.snapshot().layout;
    const of = (id: string) => layout.filter((e) => e.pluginId === id).map((e) => [e.name, e.url, e.mark]);
    assert.deepEqual(of('duo'), [
      ['main', 'cyborg-plugin://duo/duo/?view=main', undefined],
      ['side-tree', 'cyborg-plugin://duo/duo/?view=side-tree', undefined],
    ]);
    assert.deepEqual(of('solo'), [['main', 'cyborg-plugin://solo/solo/?view=main', undefined]]);
    assert.deepEqual(of('bare'), []);
    assert.deepEqual(of('spare'), [['main', undefined, 'not-enabled']], 'невключённому окно вид не рисует');
    assert.deepEqual(await service.disable('duo'), {});
    assert.equal(service.snapshot().layout.filter((e) => e.pluginId === 'duo' && e.mark === 'disabled').length, 2, 'снятому окно рисует заглушку на месте видов');
  } finally {
    await service.unload();
  }
});

test('заголовок окна: имя приложения задаёт приложение, адаптер без имени подписывает окно «Cyborg»', async () => {
  const titles: string[] = [];
  for (const appName of [undefined, 'Мой редактор']) {
    const userData = tmp();
    const kernel = await startPlugins({
      userData,
      builtinDir: path.join(userData, 'нет'),
      spawnHost: inlineHosts(async () => ({ activate() {} })),
      log: () => {},
      ...(appName !== undefined && { appName }),
    });
    titles.push(kernel.window.title);
    await kernel.unload();
  }
  assert.deepEqual(titles, ['workspace.cyborg.json - Cyborg', 'workspace.cyborg.json - Мой редактор']);
});
