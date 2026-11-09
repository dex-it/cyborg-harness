import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import { describeOpenCommands } from '../src/permissions.ts';
import { describeEntry } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

const base = { version: '1.0.0', engines: { cyborg: '^1' } };

test('манифест: callers у команды - user по умолчанию, plugins открывает чужим главным частям; guard только при plugins', () => {
  const ok = parseManifest({
    ...base,
    id: 'sessions',
    commands: {
      'sessions.new': { args: ['string'] },
      'sessions.mine': { callers: 'user' },
      'sessions.actions': { args: ['string', 'number'], callers: 'plugins' },
      'sessions.open': { args: ['string'], callers: 'plugins', guard: { 'fs.read': 0 } },
      'sessions.cwd': { args: ['record'], callers: 'plugins', guard: { 'fs.read': '0.cwd', 'secrets.ref': '0.ref' } },
      'sessions.any': { args: ['any'], callers: 'plugins', guard: { 'fs.read': 0, 'secrets.ref': '0.ref' } },
      'sessions.many': { args: ['string'], rest: 'string', callers: 'plugins', guard: { 'fs.read': 0, shell: 2 } },
    },
  });
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.join('\n'));
  const { commands } = ok.manifest;
  assert.equal(commands['sessions.new']?.callers, undefined, 'не объявлено - user');
  assert.equal(commands['sessions.mine']?.callers, 'user');
  assert.equal(commands['sessions.actions']?.callers, 'plugins');
  assert.deepEqual(commands['sessions.open']?.guard, [{ right: 'fs.read', arg: 0 }]);
  assert.deepEqual(commands['sessions.cwd']?.guard, [
    { right: 'fs.read', arg: 0, field: 'cwd' },
    { right: 'secrets.ref', arg: 0, field: 'ref' },
  ]);
  const list = parseManifest({ ...base, id: 'plain', commands: ['plain.go'] });
  assert.ok(list.ok);
  assert.equal(list.manifest.commands['plain.go']?.callers, undefined);
});

test('манифест: неизвестное значение callers и guard не у plugins отклоняются, ошибки собираются', () => {
  const bad = parseManifest({
    ...base,
    id: 'bad',
    commands: {
      'bad.a': { callers: 'everyone' },
      'bad.b': { callers: ['plugins'] },
      'bad.c': { guard: { 'fs.read': 0 } },
      'bad.d': { callers: 'user', guard: { 'fs.read': 0 } },
      'bad.e': { callers: 'plugins', guard: { process: 0 } },
      'bad.f': { callers: 'plugins', guard: { 'fs.read': -1 } },
      'bad.g': { callers: 'plugins', guard: {} },
      'bad.h': { callers: 'plugins', guard: [] },
      'bad.i': { args: ['record'], callers: 'plugins', guard: { 'fs.read': 3 } },
      'bad.j': { args: ['number'], callers: 'plugins', guard: { 'fs.read': 0 } },
      'bad.k': { args: ['string'], callers: 'plugins', guard: { 'fs.read': '0.path' } },
      'bad.l': { args: ['record'], callers: 'plugins', guard: { 'fs.read': 0 } },
      'bad.m': { callers: 'plugins', guard: { 'fs.read': 0 } },
      'bad.n': { args: ['string'], rest: 'number', callers: 'plugins', guard: { 'fs.read': 1 } },
    },
  });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors, [
    'commands.bad.a.callers: ожидается "user" или "plugins", получено "everyone"',
    'commands.bad.b.callers: ожидается "user" или "plugins", получено ["plugins"]',
    'commands.bad.c.guard: проверяет аргумент для чужих главных частей - нужен callers: "plugins"',
    'commands.bad.d.guard: проверяет аргумент для чужих главных частей - нужен callers: "plugins"',
    'commands.bad.e.guard.process: право не для аргумента - допустимы fs.read, fs.write, shell, secrets.ref',
    'commands.bad.f.guard.fs.read: ожидается номер аргумента или "номер.поле"',
    'commands.bad.g.guard: ожидается { право: номер аргумента или "номер.поле" }',
    'commands.bad.h.guard: ожидается { право: номер аргумента или "номер.поле" }',
    'commands.bad.i.guard.fs.read: аргумента 3 нет в args и rest',
    'commands.bad.j.guard.fs.read: аргумент 0 - number, а право без поля проверяет строку: нужен string или any',
    'commands.bad.k.guard.fs.read: аргумент 0 - string, а поле path есть только у record: нужен record или any',
    'commands.bad.l.guard.fs.read: аргумент 0 - record, а право без поля проверяет строку: нужен string или any',
    'commands.bad.m.guard.fs.read: аргумента 0 нет в args и rest',
    'commands.bad.n.guard.fs.read: аргумент 1 - number, а право без поля проверяет строку: нужен string или any',
  ]);
});

test('права словами: команды, открытые другим плагинам, названы; закрытых и пустого списка нет', () => {
  const parsed = parseManifest({ ...base, id: 'sessions', commands: { 'sessions.new': {}, 'sessions.actions': { callers: 'plugins' }, 'sessions.open': { args: ['string'], callers: 'plugins', guard: { 'fs.read': 0 } } } });
  assert.ok(parsed.ok);
  assert.deepEqual(describeOpenCommands(parsed.manifest.commands), ['другие плагины могут звать команды: sessions.actions, sessions.open']);
  assert.deepEqual(describeOpenCommands({ 'sessions.new': {} }), []);
});

/** sessions - привилегированный исполнитель; nosy без прав, trusted читает work; lazy спит до первой команды. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-callers-'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const contexts = new Map<string, PluginContext>();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const ran: string[] = [];
  const handle = (ctx: PluginContext, name: string) => ctx.commands.register(name, (...args) => (ran.push(`${name}:${args.map((a) => JSON.stringify(a)).join(',')}`), `ok:${name}`));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({
      activate: async (ctx: PluginContext) => {
        contexts.set(entry, ctx);
        if (entry === 'sessions') for (const name of ['sessions.new', 'sessions.pin', 'sessions.actions', 'sessions.open']) handle(ctx, name);
        if (entry === 'lazy') handle(ctx, 'lazy.go');
        if (entry === 'slow') {
          await gate;
          handle(ctx, 'slow.go');
        }
      },
    })),
    enabled: ['sessions', 'nosy', 'trusted', 'lazy', 'slow'],
    manifests: [
      {
        ...base,
        id: 'sessions',
        permissions: { pty: ['claude'] },
        commands: {
          'sessions.new': { args: ['string'] },
          'sessions.pin': { args: ['string'], callers: 'user' },
          'sessions.actions': { args: ['string', 'number'], callers: 'plugins' },
          'sessions.open': { args: ['record'], callers: 'plugins', guard: { 'fs.read': '0.path' } },
        },
      },
      { ...base, id: 'nosy' },
      { ...base, id: 'trusted', permissions: { 'fs.read': [work] } },
      { ...base, id: 'lazy', activation: 'lazy', commands: ['lazy.go'] },
      { ...base, id: 'slow', activation: 'lazy', commands: ['slow.go'] },
    ],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
  });
  const run = (id: string, name: string, ...args: unknown[]) => contexts.get(id)!.commands.run(name, ...args);
  const denied = () => k.journal.flatMap((e) => (e.kind === 'denied' ? [{ pluginId: e.pluginId, method: e.method, reason: e.reason }] : []));
  const dispose = async () => {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  };
  return { k, work, ran, run, denied, release, [Symbol.asyncDispose]: dispose };
}

test('команда с callers по умолчанию: плагин без прав из главной части получает PermissionDenied и запись denied, обработчик не вызван', async () => {
  await using s = await setup();
  await assert.rejects(s.run('nosy', 'sessions.new', 'claude'), { code: 'PermissionDenied' });
  await assert.rejects(s.run('trusted', 'sessions.pin', 'x'), { code: 'PermissionDenied' }, 'явное user - то же');
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.denied(), [
    { pluginId: 'nosy', method: 'sessions.new', reason: 'command-callers' },
    { pluginId: 'trusted', method: 'sessions.pin', reason: 'command-callers' },
  ]);
  const entry = s.k.journal.find((e) => e.kind === 'denied');
  assert.equal(entry && describeEntry(entry), 'отказ команды: sessions.new - sessions не открыл её другим плагинам (callers: "user")');
});

test('команда с callers по умолчанию открыта пользователю (палитра, клавиши, меню) и своему плагину', async () => {
  await using s = await setup();
  assert.equal(await s.k.run('sessions.new', 'claude'), 'ok:sessions.new');
  assert.equal(await s.run('sessions', 'sessions.new', 'shell'), 'ok:sessions.new', 'главная часть звонит своей команде');
  assert.deepEqual(s.ran, ['sessions.new:"claude"', 'sessions.new:"shell"']);
  assert.deepEqual(s.denied(), []);
  await assert.rejects(s.run('nosy', 'sessions.nope'), { code: 'CommandNotFound' });
});

test('отказ по callers раньше, чем ядро будит спящего исполнителя и сверяет аргументы', async () => {
  await using s = await setup();
  await assert.rejects(s.run('nosy', 'lazy.go'), { code: 'PermissionDenied' });
  assert.equal(s.k.journal.some((e) => e.pluginId === 'lazy' && e.kind === 'activated'), false, 'спящий не разбужен отказанным');
  await assert.rejects(s.run('nosy', 'sessions.new', 42), { code: 'PermissionDenied' }, 'схема не подсказывает чужому форму команды');
  assert.equal(await s.k.run('lazy.go'), 'ok:lazy.go', 'пользователь будит как раньше');
  const user = s.k.run('slow.go');
  setTimeout(s.release, 50);
  await assert.rejects(s.run('nosy', 'slow.go'), { code: 'PermissionDenied' });
  assert.equal(s.k.journal.some((e) => e.pluginId === 'slow' && e.kind === 'activated'), false, 'исполнитель ещё просыпается: отказ не ждёт конца его активации');
  assert.equal(await user, 'ok:slow.go');
});

test('runOwn: чужая команда спящего плагина - отказ раньше пробуждения', async () => {
  await using s = await setup();
  await assert.rejects(s.k.runOwn('nosy', 'lazy.go'), { code: 'PermissionDenied' });
  assert.equal(s.k.journal.some((e) => e.pluginId === 'lazy' && e.kind === 'activated'), false, 'вид чужого плагина не будит спящего');
  assert.equal(await s.k.runOwn('lazy', 'lazy.go'), 'ok:lazy.go', 'свой вид будит как раньше');
});

test('callers: "plugins" - чужая главная часть вызывает, схема аргументов по-прежнему сверяется', async () => {
  await using s = await setup();
  assert.equal(await s.run('nosy', 'sessions.actions', 'ticket', 3), 'ok:sessions.actions');
  await assert.rejects(s.run('nosy', 'sessions.actions', 'ticket', 'x'), { code: 'Invalid' });
  assert.deepEqual(s.ran, ['sessions.actions:"ticket",3']);
  assert.deepEqual(s.denied(), []);
});

test('guard команды: путь вне права вызывающего отклоняется, в границах права проходит, пользователя guard не касается', async () => {
  await using s = await setup();
  const inside = path.join(s.work, 'a.md');
  await writeFile(inside, 'x');
  assert.equal(await s.run('trusted', 'sessions.open', { path: inside }), 'ok:sessions.open');
  await assert.rejects(s.run('trusted', 'sessions.open', { path: '/etc/passwd' }), { code: 'PermissionDenied' }, 'вне области fs.read вызывающего');
  await assert.rejects(s.run('nosy', 'sessions.open', { path: inside }), { code: 'PermissionDenied' }, 'у вызывающего нет fs.read');
  await assert.rejects(s.run('trusted', 'sessions.open', { path: ['/etc'] }), { code: 'Invalid' }, 'не строка - отказ, а не пропуск');
  await assert.rejects(s.run('trusted', 'sessions.open', {}), { code: 'Invalid' });
  assert.deepEqual(s.ran, [`sessions.open:{"path":${JSON.stringify(inside)}}`]);
  assert.deepEqual(s.denied(), [
    { pluginId: 'trusted', method: 'sessions.open', reason: 'via-contract' },
    { pluginId: 'nosy', method: 'sessions.open', reason: 'via-contract' },
  ]);
  assert.equal(await s.k.run('sessions.open', { path: '/etc/passwd' }), 'ok:sessions.open', 'пользователь сам назвал путь: guard о чужих плагинах');
  assert.equal(await s.run('sessions', 'sessions.open', { path: '/etc/passwd' }), 'ok:sessions.open', 'свой плагин себя guard не проверяет');
});

// Ревью K-22: `a` и `a.b` оба проходят проверку пространства имён для `a.b.run`.
test('команда в двух манифестах: сторонний отвергнут, встроенный остаётся владельцем; runOwn не пускает к чужой команде', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-callers-'));
  const contexts = new Map<string, PluginContext>();
  const ran: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({
      activate: (ctx: PluginContext) => {
        contexts.set(entry, ctx);
        const names = entry === 'a' ? ['a.b.run', 'a.own'] : entry === 'a.b' ? ['a.b.run'] : ['other.go'];
        for (const name of names) ctx.commands.register(name, (...args) => void ran.push(`${entry}:${name}:${JSON.stringify(args)}`));
      },
    })),
    enabled: ['a', 'a.b', 'other'],
    bundled: ['a', 'other'],
    reservedPrefixes: ['cyborg.'],
    manifests: [
      { ...base, id: 'a', commands: ['a.b.run', 'a.own'] },
      { ...base, id: 'a.b', commands: ['a.b.run'], keybindings: [{ key: 'F9', command: 'a.b.run' }] },
      { ...base, id: 'other', commands: ['other.go'] },
    ],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
  });
  try {
    const rejected = k.journal.find((e) => e.kind === 'rejected' && e.pluginId === 'a.b');
    assert.ok(rejected, 'a.b отвергнут');
    assert.match(describeEntry(rejected), /команду a\.b\.run объявил и a/);
    assert.equal(contexts.has('a.b'), false, 'отвергнутый не запущен и не покажет уведомление');
    assert.equal(k.keybindings.some((b) => b.pluginId === 'a.b'), false, 'сочетание отвергнутого не действует');
    assert.equal(k.keybinding('F9'), undefined);

    assert.equal(await k.runOwn('a', 'a.b.run'), undefined);
    assert.deepEqual(ran, ['a:a.b.run:[]']);
    await assert.rejects(k.runOwn('a.b', 'a.b.run'), { code: 'PermissionDenied' }, 'вид отвергнутого не запускает команду владельца');
    await assert.rejects(k.runOwn('other', 'a.b.run'), { code: 'PermissionDenied' }, 'чужая команда');
    await assert.rejects(k.runOwn('a', 'a.nothing'), { code: 'CommandNotFound' });
    assert.deepEqual(ran, ['a:a.b.run:[]'], 'чужие вызовы обработчик не достали');
  } finally {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  }
});

test('команда в двух манифестах: встроенный остаётся владельцем и без reservedPrefixes - поставку задаёт bundled', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-callers-'));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
    enabled: ['a', 'a.b'],
    bundled: ['a'],
    manifests: [
      { ...base, id: 'a', commands: ['a.b.run'] },
      { ...base, id: 'a.b', commands: ['a.b.run'] },
    ],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
  });
  try {
    assert.deepEqual(k.journal.filter((e) => e.kind === 'rejected').map((e) => e.pluginId), ['a.b']);
  } finally {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  }
});
