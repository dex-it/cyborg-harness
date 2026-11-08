import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
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
  ]);
});

/** sessions - привилегированный исполнитель; nosy без прав, trusted читает work; lazy спит до первой команды. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-callers-'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const contexts = new Map<string, PluginContext>();
  const ran: string[] = [];
  const handle = (ctx: PluginContext, name: string) => ctx.commands.register(name, (...args) => (ran.push(`${name}:${args.map((a) => JSON.stringify(a)).join(',')}`), `ok:${name}`));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({
      activate: (ctx: PluginContext) => {
        contexts.set(entry, ctx);
        if (entry === 'sessions') for (const name of ['sessions.new', 'sessions.pin', 'sessions.actions', 'sessions.open']) handle(ctx, name);
        if (entry === 'lazy') handle(ctx, 'lazy.go');
      },
    })),
    enabled: ['sessions', 'nosy', 'trusted', 'lazy'],
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
    ],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
  });
  const run = (id: string, name: string, ...args: unknown[]) => contexts.get(id)!.commands.run(name, ...args);
  const denied = () => k.journal.flatMap((e) => (e.kind === 'denied' ? [{ pluginId: e.pluginId, method: e.method, reason: e.reason }] : []));
  const dispose = async () => {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  };
  return { k, work, ran, run, denied, [Symbol.asyncDispose]: dispose };
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
});
