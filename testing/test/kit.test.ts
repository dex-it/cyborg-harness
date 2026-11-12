import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { PluginContext } from '@cyborg-harness/contracts';
import { fakePty, memorySecrets, memoryStore, sandbox, startKernel, type InlinePlugin } from '../src/index.ts';

const ECHO = path.join(import.meta.dirname, 'fixtures', 'echo');
const SCHEMED = path.join(import.meta.dirname, 'fixtures', 'schemed');
const manifest = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...extra });

/** Плагин из кода теста, отдающий свой ctx наружу. */
function probe(id: string, extra: Record<string, unknown> = {}): { plugin: InlinePlugin; ctx: () => PluginContext } {
  let ctx: PluginContext | undefined;
  return {
    plugin: { manifest: manifest(id, extra), module: { activate: (c) => void (ctx = c) } },
    ctx: () => {
      assert.ok(ctx, `${id} не активирован`);
      return ctx;
    },
  };
}

describe('startKernel', () => {
  it('ST-7003/1: плагин из каталога: манифест и точка входа найдены, команда отвечает, активация в журнале', async () => {
    await using k = await startKernel({ plugins: [ECHO] });
    assert.deepEqual(k.active, ['echo']);
    assert.equal((await k.waitForJournal({ kind: 'activated', pluginId: 'echo' })).hostId.length > 0, true);
    assert.equal(await k.run('echo.say', 'привет'), 'echo:привет');
  });

  it('плагин из кода теста и каталог рядом, граф связывает контракты', async () => {
    const consumer = probe('consumer', { requires: { 'test.files': '^1' } });
    const provider: InlinePlugin = {
      manifest: manifest('files', { provides: { 'test.files': '1.0' } }),
      module: {
        activate: (ctx) => {
          (ctx.contracts as unknown as { provide(name: string, version: string, impl: object): void }).provide('test.files', '1.0', { read: async (p: string) => `data:${p}` });
        },
      },
    };
    await using k = await startKernel({ plugins: [provider, consumer.plugin, ECHO] });
    assert.deepEqual(k.active.toSorted(), ['consumer', 'echo', 'files']);
    const files = (consumer.ctx().contracts as unknown as { get(name: string, major: number): { read(p: string): Promise<string> } | undefined }).get('test.files', 1);
    assert.ok(files);
    assert.equal(await files.read('a'), 'data:a');
  });

  it('плагин-каталог со схемами config и state: схемы читаются из каталога без ручного load.schema (#140)', async () => {
    const config = memoryStore({ user: { schemed: { $version: 1, greeting: 'здравствуйте' } } });
    const state = memoryStore({ workspace: { schemed: { $version: 1, counter: 7 } } });
    await using k = await startKernel({ plugins: [SCHEMED], config: config.store, state: state.store });
    await k.waitForJournal({ kind: 'activated', pluginId: 'schemed' });
    assert.equal(await k.run('schemed.greeting'), 'здравствуйте');
    assert.equal(await k.run('schemed.counter'), 7);
  });

  it('плагин-каталог: значение config не по схеме из каталога - плагин не активируется, причина в журнале', async () => {
    const { store } = memoryStore({ user: { schemed: { $version: 1, greeting: 5 } } });
    await using k = await startKernel({ plugins: [SCHEMED], config: store });
    assert.deepEqual(k.journal, [{ pluginId: 'schemed', kind: 'config', result: { status: 'invalid', errors: ['/greeting: ожидается string, получено integer'] } }]);
    assert.deepEqual(k.active, []);
    const bad = memoryStore({ workspace: { schemed: { $version: 1, counter: 'много' } } });
    await using s = await startKernel({ plugins: [SCHEMED], state: bad.store });
    assert.deepEqual(s.journal.map((e) => [e.kind, e.pluginId]), [['state', 'schemed']]);
  });

  it('load.schema теста заменяет чтение из каталога; у плагина из кода теста файлов схем нет - причина в журнале', async () => {
    const seen: string[] = [];
    await using own = await startKernel({
      plugins: [SCHEMED],
      load: { schema: (_m, file) => (seen.push(file), { type: 'object', properties: { greeting: { type: 'integer' } } }) },
      config: memoryStore({ user: { schemed: { $version: 1, greeting: 'строка' } } }).store,
    });
    assert.deepEqual(seen, ['./config.schema.json']);
    assert.deepEqual(own.active, [], 'схема теста главнее');

    const inline: InlinePlugin = { manifest: manifest('inline', { config: { version: 1, schema: './config.schema.json' } }), module: { activate() {} } };
    await using lone = await startKernel({ plugins: [inline], config: memoryStore({ user: { inline: { $version: 1 } } }).store });
    const entry = lone.journal.find((e) => e.kind === 'config');
    assert.ok(entry?.kind === 'config' && entry.result.status === 'invalid');
    assert.match(JSON.stringify(entry.result), /плагин из кода теста/);
  });

  it('enabled сужает набор: невключённый плагин в журнале как disabled', async () => {
    await using k = await startKernel({ plugins: [ECHO, probe('other').plugin], enabled: ['echo'] });
    assert.deepEqual(k.active, ['echo']);
    assert.equal((await k.waitForJournal({ kind: 'disabled', pluginId: 'other' })).kind, 'disabled');
  });

  it('ST-7003/1: среда по умолчанию: песочница после realpath, поддельный pty, секреты в памяти; запуск идёт в fakePty', async () => {
    const p = probe('term', { permissions: { pty: ['/bin/sh'] } });
    await using k = await startKernel({ plugins: [p.plugin] });
    assert.equal(k.sandbox.root, await realpath(k.sandbox.root));
    assert.equal(k.dataDir('term'), path.join(k.sandbox.root, 'data', 'term'));
    await p.ctx().os.pty!.spawn({ program: '/bin/sh', cwd: p.ctx().os.paths.data });
    assert.deepEqual(k.pty.procs.map((x) => x.file), ['/bin/sh']);
    await p.ctx().os.secrets.set('token', 't-1');
    assert.deepEqual([...k.secrets.map], [['term/token', 't-1']]);
  });

  it('os поверх умолчания: своё поле заменяет умолчание, остальные остаются', async () => {
    const mine = fakePty();
    const secrets = memorySecrets(false);
    const p = probe('term', { permissions: { pty: ['/bin/sh'] } });
    await using k = await startKernel({ plugins: [p.plugin], os: { pty: mine, secrets, env: { PATH: '/x' } } });
    await p.ctx().os.pty!.spawn({ program: '/bin/sh' });
    assert.equal(mine.procs.length, 1);
    assert.equal(k.pty.procs.length, 0, 'k.pty - умолчание, а запуск ушёл в подставленный');
    assert.equal(mine.procs[0]!.options.env.PATH, '/x', 'env из os, а не умолчание песочницы');
    await assert.rejects(p.ctx().os.secrets.set('k', 'v'), { code: 'Unavailable' });
  });

  it('config и state: слои читаются из переданного хранилища и пишутся в него', async () => {
    const config = memoryStore({ user: { cfg: { $version: 1, size: 5 } } });
    const state = memoryStore();
    const p = probe('cfg', { config: { version: 1 }, state: { version: 1 } });
    await using k = await startKernel({ plugins: [p.plugin], config: config.store, state: state.store });
    assert.deepEqual(k.active, ['cfg']);
    assert.deepEqual(p.ctx().config!.get(), { size: 5 }, 'слой user из переданного хранилища');
    await p.ctx().config!.set('workspace', { size: 7 });
    await p.ctx().state!.set('workspace', { open: true });
    assert.deepEqual(config.saves, ['workspace']);
    assert.deepEqual(state.saves, ['workspace']);
    assert.deepEqual(p.ctx().config!.get(), { size: 7 }, 'слой workspace перекрывает user');
  });

  it('параметры load() передаются дальше', async () => {
    const seen: string[] = [];
    await using k = await startKernel({ plugins: [ECHO], load: { onJournal: (e) => void seen.push(e.kind) } });
    assert.ok(k.journal.length > 0);
    assert.ok(seen.includes('activated'));
  });

  it('ST-7003/1: waitForJournal: предикат, запись, появившаяся позже, и отказ по сроку с перечнем записей', async () => {
    const late = probe('later', { activation: 'lazy', commands: { 'later.go': {} } });
    late.plugin.module.activate = (ctx) => void ctx.commands.register('later.go', () => 'ok');
    await using k = await startKernel({ plugins: [late.plugin] });
    assert.equal((await k.waitForJournal((e) => e.kind === 'waiting')).pluginId, 'later');
    const pending = k.waitForJournal({ kind: 'activated', pluginId: 'later' });
    await k.run('later.go');
    assert.equal((await pending).pluginId, 'later');
    await assert.rejects(k.waitForJournal({ kind: 'denied' }, { timeout: 60 }), /нет нужной записи за 60 мс; есть: .*later:activated/);
  });

  it('ST-5003/6: тест на тест-ките ждёт запись deprecated-call и видит вызывающего, контракт и член, как окно «Плагины Cyborg»', async () => {
    const consumer = probe('caller', { requires: { 'test.old': '^1' } });
    const provider: InlinePlugin = {
      manifest: manifest('prov', { provides: { 'test.old': { version: '1.0', deprecated: ['list'] } } }),
      module: {
        activate: (ctx) => {
          (ctx.contracts as unknown as { provide(name: string, version: string, impl: object): void }).provide('test.old', '1.0', { list: async () => ['a'], fresh: async () => ['a'] });
        },
      },
    };
    await using k = await startKernel({ plugins: [provider, consumer.plugin] });
    const old = (consumer.ctx().contracts as unknown as { get(name: string, major: number): { list(): Promise<string[]>; fresh(): Promise<string[]> } | undefined }).get('test.old', 1);
    assert.ok(old);
    assert.deepEqual(await old.fresh(), ['a']);
    assert.deepEqual(await old.list(), ['a'], 'вызов устаревшего члена выполняется как раньше');
    const entry = await k.waitForJournal({ kind: 'deprecated-call', pluginId: 'caller' });
    assert.deepEqual([entry.provider, entry.contract, entry.member], ['prov', 'test.old', 'list']);
    assert.equal(k.journal.filter((e) => e.kind === 'deprecated-call').length, 1, 'непомеченный член записи не даёт');
  });

  it('ST-7003/1: unload через Symbol.asyncDispose: плагины сняты, песочница удалена, повторный вызов безвреден', async () => {
    const down: string[] = [];
    const k = await startKernel({ plugins: [{ manifest: manifest('x'), module: { activate: () => ({ dispose: () => void down.push('x') }) } }] });
    const root = k.sandbox.root;
    assert.ok(existsSync(root));
    await k[Symbol.asyncDispose]();
    await k[Symbol.asyncDispose]();
    assert.deepEqual(down, ['x']);
    assert.ok(!existsSync(root));
  });

  it('ошибки входа: пустой каталог, нет точки входа, повтор id, манифест без id', async () => {
    await using box = await sandbox();
    await assert.rejects(startKernel({ plugins: [box.root] }), /нет manifest\.json/);
    await writeFile(box.path('manifest.json'), JSON.stringify(manifest('p')));
    await assert.rejects(startKernel({ plugins: [box.root] }), /нет точки входа/);
    await assert.rejects(startKernel({ plugins: [ECHO, ECHO] }), /echo назван дважды/);
    await assert.rejects(startKernel({ plugins: [{ manifest: { version: '1.0.0' }, module: { activate: () => undefined } }] }), /нет строки id/);
  });

  it('если load отказал, песочница не остаётся', async () => {
    // os.tmpdir() читает TMPDIR при каждом вызове: временный каталог теста-кита попадает в отдельную папку, и видно, остался ли он.
    await using tmp = await sandbox();
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = tmp.root;
    try {
      await assert.rejects(
        startKernel({
          plugins: [ECHO],
          load: {
            onGraph: () => {
              throw new Error('граф не принят');
            },
          },
        }),
        /граф не принят/,
      );
      assert.deepEqual(await readdir(tmp.root), []);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });
});

describe('поддельные среды', () => {
  it('memoryStore копирует документы при записи и чтении, ведёт список записанных слоёв', async () => {
    const m = memoryStore({ user: { a: { n: 1 } } });
    const doc = (await m.store.load('user')) ?? {};
    assert.deepEqual(doc, { a: { n: 1 } });
    Object.assign(doc.a, { n: 2 });
    assert.deepEqual(await m.store.load('user'), { a: { n: 1 } }, 'чтение отдаёт копию');
    const next = { b: { n: 3 } };
    await m.store.save('workspace', next);
    next.b.n = 4;
    assert.deepEqual(m.docs.get('workspace'), { b: { n: 3 } }, 'запись хранит копию');
    assert.deepEqual(m.saves, ['workspace']);
    assert.equal(await memoryStore().store.load('user'), undefined, 'пустой слой - undefined');
  });

  it('memorySecrets: get, set, delete, доступность', async () => {
    const s = memorySecrets();
    await s.set('k', 'v');
    assert.equal(await s.get('k'), 'v');
    await s.delete('k');
    assert.equal(s.map.size, 0);
    assert.equal(s.available(), true);
    assert.equal(memorySecrets(false).available(), false);
  });

  it('fakePty: процесс виден тесту, вывод после запуска, выход и сигнал', async () => {
    const pty = fakePty();
    const proc = pty.spawn('/bin/sh', ['-l'], { name: 'xterm', cwd: '/w', env: {}, cols: 80, rows: 24 });
    const out: string[] = [];
    const codes: number[] = [];
    proc.onData((d) => out.push(d));
    proc.onExit((e) => codes.push(e.exitCode));
    await new Promise((r) => setImmediate(r));
    proc.write('ls');
    proc.resize(100, 30);
    proc.kill();
    pty.procs[0]!.exit(3);
    assert.deepEqual([out, codes, pty.procs[0]!.writes, pty.procs[0]!.resizes, pty.procs[0]!.killed], [['$ '], [3], ['ls'], [[100, 30]], 'SIGHUP']);
    assert.equal(pty.spawn('/bin/sh', [], { name: 'xterm', env: {}, cols: 1, rows: 1 }).pid, 1001);
  });

  it('sandbox: корень после realpath, путь внутри, снятие удаляет каталог', async () => {
    const box = await sandbox('kit-test-');
    assert.equal(box.root, await realpath(box.root));
    assert.equal(box.path('a', 'b'), path.join(box.root, 'a', 'b'));
    await box[Symbol.asyncDispose]();
    assert.ok(!existsSync(box.root));
  });
});
