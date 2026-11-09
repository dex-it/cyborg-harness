import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext, PtyHandle } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { PtyTable, type PtyBackend, type PtyExpiry, type PtyTableOptions } from '../src/pty.ts';
import { inlinePtyHost, type SpawnPtyHost } from '../src/pty-link.ts';
import { isRecord } from '../src/wire.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { fakePty } from './fake-pty.ts';
import { fakeView } from './view-channel.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

const spawnOpts = { program: 'sh', args: [] as string[], env: {}, cols: 80, rows: 24, persist: true };

/** Сообщения между главным процессом и pty-хостом идут через setImmediate; таймеры подменяют не все тесты, поэтому ждём именно ими. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

function table(limit = 1000, ttl = 30_000, extra: PtyTableOptions = {}) {
  const backend = fakePty();
  const pushed: { pluginId: string; method: string; params: unknown }[] = [];
  const t = new PtyTable(inlinePtyHost(backend), (pluginId, method, params) => void pushed.push({ pluginId, method, params }), { backlog: limit, ticketTtl: ttl, ptys: 1000, ...extra });
  return { t, backend, pushed };
}

test('stress-pty: 300 pty за цикл (spawn, вывод, выход, release) - таблица пуста, процессы убиты', async () => {
  const { t, backend } = table();
  for (let i = 0; i < 300; i++) await t.spawn('p', { ...spawnOpts, persist: i % 2 === 0 });
  assert.equal(t.list('p').length, 300);
  for (const [i, proc] of backend.procs.entries()) {
    proc.emit(`out-${String(i)}`);
    if (i % 3 === 0) proc.exit(0);
  }
  await settle();
  t.release('p');
  assert.deepEqual(t.list('p'), []);
  await settle();
  assert.equal(backend.procs.filter((p, i) => i % 3 !== 0 && p.killed === undefined).length, 0, 'живые убиты release');
  await t.releaseAll();
});

test('stress-pty: кольцевой буфер - 5 МБ мелкими кусками не выходит за предел, хвост точный; граница ровно по размеру', async () => {
  const { t, backend } = table(1000);
  const wire = await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  let all = '';
  for (let i = 0; i < 50_000; i++) {
    const chunk = String(i % 10).repeat(100);
    all += chunk.slice(0, 100);
    proc.emit(chunk);
  }
  const attached = await t.attach('p', wire.id);
  assert.equal(attached.backlog.length, 1000);
  assert.equal(attached.backlog, all.slice(-1000));
  // Ровно по пределу: ни потерь, ни лишнего.
  const w2 = await t.spawn('p', spawnOpts);
  const proc2 = backend.procs[1];
  assert.ok(proc2);
  proc2.emit('a'.repeat(1000));
  assert.equal((await t.attach('p', w2.id)).backlog, 'a'.repeat(1000));
  proc2.emit('b');
  assert.equal((await t.attach('p', w2.id)).backlog, 'a'.repeat(999) + 'b');
  await t.releaseAll();
});

test('stress-pty: вывод идёт мелкими кусками - обработка 5000 кусков по 64 байта при полном хвосте укладываются в четверть секунды', async () => {
  // Под нагрузкой TUI шлёт тысячи мелких кусков в секунду; цена одного куска не должна расти с размером хвоста (256 КБ по умолчанию).
  const backend = fakePty();
  const t = new PtyTable(inlinePtyHost(backend), () => undefined);
  await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  proc.emit('f'.repeat(256 * 1024));
  const chunk = 'x'.repeat(64);
  const started = performance.now();
  for (let i = 0; i < 5000; i++) proc.emit(chunk);
  const ms = performance.now() - started;
  assert.ok(ms < 250, `5000 кусков по 64 байта при хвосте 256 КБ: ${ms.toFixed(0)} мс`);
  await t.releaseAll();
});

test('stress-pty: выход процесса, пока владельца нет (persist) - attach отдаёт код выхода один раз, потом pty нет', async () => {
  const { t, backend, pushed } = table();
  const wire = await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  t.detach('p');
  proc.emit('last words');
  proc.exit(7);
  await settle();
  assert.deepEqual(pushed.filter((m) => m.method === 'pty.exit'), [], 'владельца нет - никому не шлём');
  const a = await t.attach('p', wire.id);
  assert.equal(a.exit?.code, 7);
  assert.equal(a.backlog, '$ last words', 'подставной pty печатает приглашение сразу после запуска: оно уже в хвосте');
  await assert.rejects(t.attach('p', wire.id), { code: 'NotFound' });
  assert.deepEqual(t.list('p'), []);
  await t.releaseAll();
});

test('stress-pty: билеты share - просроченные не копятся и не открываются, повторное предъявление отказывает при 500 билетах', async () => {
  const { t } = table(1000, 200);
  const wire = await t.spawn('p', spawnOpts);
  const tickets = Array.from({ length: 500 }, () => t.share('p', wire.id));
  assert.equal(new Set(tickets).size, 500);
  const first = tickets[0]!;
  const view = await t.openTerminal('p', first, fakeView().channel);
  view.close();
  await assert.rejects(t.openTerminal('p', first, fakeView().channel), { code: 'NotFound' });
  await sleep(260);
  await assert.rejects(t.openTerminal('p', tickets[1]!, fakeView().channel), { code: 'NotFound' }, 'просрочен');
  await t.releaseAll();
});

test('stress-pty: зритель открыт, процесс вышел - зритель получает exit, write после выхода отказывает, pty в таблице чист после release', async () => {
  const { t, backend } = table();
  const wire = await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  const v = fakeView();
  await t.openTerminal('p', t.share('p', wire.id), v.channel);
  proc.exit(0);
  await settle();
  assert.equal(v.exit.length, 1);
  assert.equal(v.closed.length, 1, 'главный процесс не узнал, что канал вида не нужен');
  assert.match((await v.write('x')).error ?? '', /закрыт/);
  t.release('p');
  assert.deepEqual(t.list('p'), []);
  await t.releaseAll();
});

async function kernelWithPty(plugins: Record<string, (ctx: PluginContext) => void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-stress-pty-'));
  await mkdir(path.join(root, 'work'));
  const backend = fakePty();
  const handles: HostHandle[] = [];
  const base = inlineHosts(async (entry) => ({
    activate: (ctx: PluginContext) => {
      plugins[entry]?.(ctx);
      return undefined;
    },
  }));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: Object.keys(plugins),
    manifests: Object.keys(plugins).map((id) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, permissions: { pty: [{ program: 'sh', args: [] }] } })),
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: '/usr/bin' }, pty: backend },
    watchdog: { interval: 20, timeout: 300 },
    spawnHost: (id) => {
      const h = base(id);
      handles.push(h);
      return h;
    },
  });
  return { k, backend, handles, [Symbol.asyncDispose]: async () => { await k.unload(); await rm(root, { recursive: true, force: true }); } };
}

test('stress-pty: вывод идёт без остановки, хост падает и возвращается - attach отдаёт хвост без дыр и повторов, поток продолжается', async () => {
  let ctx!: PluginContext;
  await using s = await kernelWithPty({ term: (c) => void (ctx = c) });
  const h0 = await ctx.os.pty!.spawn({ program: 'sh', args: [], cols: 80, rows: 24, persist: true });
  const proc = s.backend.procs[0];
  assert.ok(proc);
  let seq = 0;
  const emit = (n: number) => {
    for (let i = 0; i < n; i++) proc.emit(`[${String(seq++).padStart(6, '0')}]`);
  };
  h0.onData(() => undefined);
  emit(200);
  await sleep(30);
  s.handles[0]?.kill();
  emit(200);
  await s.k.idle();
  await sleep(30);
  const id = (await ctx.os.pty!.list())[0]?.id;
  assert.ok(id, 'pty пережил падение хоста');
  const h1: PtyHandle = await ctx.os.pty!.attach(id);
  let live = '';
  h1.onData((c) => void (live += c));
  const backlog = h1.backlog;
  emit(100);
  await sleep(60);
  const count = seq;
  const text = backlog + live;
  // Хвост в пределах 256 КБ целиком: от первой записи до последней подряд, каждая ровно один раз.
  const parts = text.match(/\[\d{6}\]/g) ?? [];
  const numbers = parts.map((p) => Number(p.slice(1, -1)));
  const start = numbers[0] ?? 0;
  assert.deepEqual(
    numbers,
    Array.from({ length: count - start }, (_, i) => start + i),
    'номера идут подряд до последнего, без дыр и повторов',
  );
});

test('stress-pty: плагин spawn-ит pty и не подписывается на вывод - хост не копит вывод без предела', async () => {
  let ctx!: PluginContext;
  await using s = await kernelWithPty({ term: (c) => void (ctx = c) });
  const h = await ctx.os.pty!.spawn({ program: 'sh', args: [], cols: 80, rows: 24, persist: false });
  const proc = s.backend.procs[0];
  assert.ok(proc);
  const chunk = 'y'.repeat(64 * 1024);
  for (let i = 0; i < 200; i++) {
    proc.emit(chunk);
    if (i % 20 === 0) await sleep(1);
  }
  await sleep(100);
  let got = 0;
  h.onData((c) => void (got += c.length));
  // 12.8 МБ вывода без подписчика; ядро держит хвост 256 КБ (SAD 3.6) - хост не вправе держать больше этого.
  assert.ok(got <= 256 * 1024 + 64 * 1024, `хост накопил ${String(got)} символов до первой подписки`);
});

test('сирота: pty с persist без attach завершается по сроку; attach, release и park срок снимают', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = fakePty();
  const expired: PtyExpiry[] = [];
  const table = new PtyTable(inlinePtyHost(backend), () => undefined, { backlog: 1000, graceMs: 1000, expired: (e) => void expired.push(e) });
  const wires = [];
  for (const p of ['lost', 'back', 'released', 'parked', 'gone']) wires.push(await table.spawn(p, { ...spawnOpts, program: p }));
  const [lost, back] = wires;
  for (const p of ['lost', 'back', 'released', 'parked', 'gone']) table.detach(p);
  await table.attach('back', back!.id);
  table.release('released');
  table.park('parked');
  backend.procs[4]!.exit(0);
  await settle();

  t.mock.timers.tick(999);
  assert.equal(backend.procs[0]!.killed, undefined, 'срок ещё не вышел');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(backend.procs[0]!.killed, 'SIGHUP');
  assert.deepEqual(table.list('lost'), []);
  assert.deepEqual(expired, [{ pluginId: 'lost', id: lost!.id, program: 'lost', graceMs: 1000 }], 'вернувшийся, снятый, оставленный и сам завершившийся не в журнале');
  assert.equal(backend.procs[1]!.killed, undefined);
  assert.equal(table.list('back').length, 1);
  assert.equal(backend.procs[3]!.killed, undefined, 'оставленный человеком ждёт без срока');
  assert.deepEqual(table.list('gone'), [], 'запись завершившегося сироты убрана сроком');
  t.mock.timers.reset();
  await table.releaseAll();
});

test('оставленный: release и detach его не трогают; claim вернувшегося плагина даёт срок на attach; endKept - только оставленным', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = fakePty();
  const expired: PtyExpiry[] = [];
  let changes = 0;
  const table = new PtyTable(inlinePtyHost(backend), () => undefined, {
    backlog: 1000,
    graceMs: 1000,
    expired: (e) => void expired.push(e),
    kept: () => {
      changes++;
    },
  });
  const [taken, done, lost] = [await table.spawn('p', { ...spawnOpts, program: 'taken' }), await table.spawn('p', { ...spawnOpts, program: 'done' }), await table.spawn('p', { ...spawnOpts, program: 'lost' })];
  const other = await table.spawn('other', spawnOpts);
  assert.equal(table.park('p'), 3);
  table.release('p');
  table.detach('p');
  t.mock.timers.tick(10_000);
  await settle();
  assert.deepEqual(backend.procs.map((p) => p.killed), [undefined, undefined, undefined, undefined], 'оставленный завершён без человека');
  assert.deepEqual(table.kept().map((k) => k.id), [taken.id, done.id, lost.id]);

  backend.procs[1]!.exit(0);
  await settle();
  assert.deepEqual(table.kept()[1]?.exit, { code: 0 }, 'завершившийся сам остаётся в списке с выходом');
  assert.throws(() => table.endKept(other.id), { code: 'NotFound' });
  const before = changes;
  table.claim('p');
  assert.deepEqual(table.kept(), []);
  assert.ok(changes > before);
  await table.attach('p', taken.id);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(backend.procs[0]!.killed, undefined, 'взятый после возврата живёт');
  assert.equal(backend.procs[2]!.killed, 'SIGHUP');
  assert.deepEqual(expired, [{ pluginId: 'p', id: lost.id, program: 'lost', graceMs: 1000 }], 'сам завершившийся в журнал не попадает');
  assert.deepEqual(table.list('p').map((p) => p.id), [taken.id]);
  t.mock.timers.reset();
  await table.releaseAll();
});

test('stress-pty: 10 000 мелких кусков - хосту и зрителю уходят десятки пачек, порядок и содержимое целы, накопленное не повторяется в хвосте, exit после последнего data', async () => {
  const backend = fakePty();
  const host = { data: '', messages: 0, order: [] as string[] };
  const t = new PtyTable(
    inlinePtyHost(backend),
    (_, method, params) => {
      host.order.push(method);
      if (method === 'pty.data') {
        host.messages++;
        host.data += (params as { data: string }).data;
      }
    },
    { ptyFlushMs: 4 },
  );
  const wire = await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  await sleep(10);
  const view = fakeView();
  const opened = await t.openTerminal('p', t.share('p', wire.id), view.channel);
  assert.equal(opened.backlog, '$ ');

  proc.emit('a');
  proc.emit('b');
  const late = await t.openTerminal('p', t.share('p', wire.id), fakeView().channel);
  assert.equal(late.backlog, '$ ab', 'накопленное к открытию - в хвосте нового зрителя');
  await settle();
  assert.equal(view.data.join(''), 'ab', 'прежний зритель получил накопленное до открытия нового');

  let all = '';
  for (let i = 0; i < 10_000; i++) {
    const chunk = `[${String(i)}]`;
    all += chunk;
    proc.emit(chunk);
    if (i % 1000 === 999 && i < 9999) await sleep(5);
  }
  proc.exit(0);
  await sleep(50);
  assert.equal(host.data, `$ ab${all}`);
  assert.equal(view.data.join(''), `ab${all}`);
  assert.ok(host.messages < 100, `в хост ушло ${String(host.messages)} сообщений на 10 002 куска`);
  assert.ok(view.data.length < 100, `во фрейм ушло ${String(view.data.length)} сообщений`);
  assert.equal(host.order.at(-1), 'pty.exit');
  assert.equal(host.order.filter((m) => m === 'pty.exit').length, 1);
  assert.deepEqual(view.order.slice(-2), ['data', 'exit'], 'exit зрителю - после последнего data');
  await t.releaseAll();
});

test('stress-pty: ptyFlushMs 0 - каждый кусок уходит сразу, как без склейки', async () => {
  const backend = fakePty();
  const got: string[] = [];
  const t = new PtyTable(
    inlinePtyHost(backend),
    (_, method, params) => {
      if (method === 'pty.data') got.push((params as { data: string }).data);
    },
    { ptyFlushMs: 0 },
  );
  await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  await settle();
  got.length = 0;
  for (const c of ['x', 'y', 'z']) proc.emit(c);
  await settle();
  assert.deepEqual(got, ['x', 'y', 'z']);
  await t.releaseAll();
});

test('stress-pty: пачка уходит по размеру, не дожидаясь интервала', async () => {
  const backend = fakePty();
  const got: string[] = [];
  const t = new PtyTable(
    inlinePtyHost(backend),
    (_, method, params) => {
      if (method === 'pty.data') got.push((params as { data: string }).data);
    },
    { ptyFlushMs: 60_000, ptyFlushChars: 10 },
  );
  await t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  await settle();
  proc.emit('1');
  for (const c of ['2345', '6789', '0abc', 'd']) proc.emit(c);
  await settle();
  assert.deepEqual(got, ['$ ', '1234567890abc'], 'первый после затишья - сразу, затем по накоплении 10 символов');
  await t.releaseAll();
});

test('attach в пути, хост плагина упал: pty остаётся без владельца и истекает по сроку, вывод не уходит мёртвому владельцу (ревью K-01, гонка attach)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = fakePty();
  const pushed: string[] = [];
  const expired: PtyExpiry[] = [];
  const table = new PtyTable(inlinePtyHost(backend), (_p, method) => void pushed.push(method), { backlog: 1000, graceMs: 1000, expired: (e) => void expired.push(e) });
  const wire = await table.spawn('p', spawnOpts);
  table.detach('p');
  await settle();
  table.claim('p');
  const attach = table.attach('p', wire.id);
  attach.catch(() => undefined);
  // Хост плагина упал снова, пока pty-хост отвечал на attach.
  table.detach('p');
  await assert.rejects(attach, { code: 'NotFound' });
  await settle();
  backend.procs[0]!.emit('вывод мёртвому владельцу');
  await settle();
  assert.deepEqual(pushed, [], 'pty.data ушёл владельцу, которого нет');
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(expired.map((e) => e.id), [wire.id], 'срок сироты не вышел: pty остался присоединённым к мёртвому владельцу');
  assert.deepEqual(table.list('p'), []);
  assert.equal(backend.procs[0]!.killed, 'SIGHUP');
  t.mock.timers.reset();
  await table.releaseAll();
});

test('attach в пути и park: оставленный человеком pty не присоединяется к выключенному плагину, срока у него нет (ревью K-01, гонка attach)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = fakePty();
  const pushed: string[] = [];
  const table = new PtyTable(inlinePtyHost(backend), (_p, method) => void pushed.push(method), { backlog: 1000, graceMs: 1000 });
  const wire = await table.spawn('p', spawnOpts);
  table.detach('p');
  await settle();
  table.claim('p');
  const attach = table.attach('p', wire.id);
  attach.catch(() => undefined);
  assert.equal(table.park('p'), 1);
  await assert.rejects(attach, { code: 'NotFound' });
  await settle();
  backend.procs[0]!.emit('x');
  await settle();
  assert.deepEqual(pushed, [], 'оставленный pty присоединён к выключенному плагину');
  assert.equal(table.kept().length, 1, 'оставленный человеком пропал');
  t.mock.timers.tick(5000);
  assert.equal(backend.procs[0]!.killed, undefined, 'оставленный человеком ждёт без срока');
  // Вернувшийся плагин забирает его обычным attach.
  table.claim('p');
  assert.deepEqual((await table.attach('p', wire.id)).backlog.includes('$ '), true);
  t.mock.timers.reset();
  await table.releaseAll();
});

test('spawn в пути и detach: pty-хост узнаёт, что владельца нет, - вывод не идёт уведомлениями в главный процесс (ревью K-01)', async () => {
  const base = fakePty();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const backend: PtyBackend = {
    async spawn(file, args, options) {
      await gate;
      return base.spawn(file, args, options);
    },
  };
  const host = inlinePtyHost(backend);
  let notes = 0;
  const spawnHost: SpawnPtyHost = () => {
    const handle = host();
    return {
      ...handle,
      port: {
        post: (m, t) => handle.port.post(m, t),
        onMessage: (l) =>
          handle.port.onMessage((m, tr) => {
            if (isRecord(m) && m.t === 'note' && m.m === 'data') notes++;
            l(m, tr);
          }),
      },
    };
  };
  const table = new PtyTable(spawnHost, () => undefined, { backlog: 1000, ptyFlushMs: 0 });
  const wire = table.spawn('p', spawnOpts);
  wire.catch(() => undefined);
  await settle();
  table.detach('p');
  await settle();
  release();
  const w = await wire;
  await settle();
  // Приветствие fakePty уходит сразу после запуска и может обогнать `owner`; считаем то, что пришло после.
  const before = notes;
  base.procs[0]!.emit('вывод сироты');
  await settle();
  assert.equal(notes, before, 'pty-хост считает pty присоединённым и шлёт вывод, который главный процесс выбрасывает');
  assert.equal((await table.attach('p', w.id)).backlog.includes('вывод сироты'), true, 'хвост сироты пропал');
  await table.releaseAll();
});

test('attach в пути, pty вышел, хост плагина упал: выход не теряется, следующий attach вернувшегося плагина его отдаёт (ревью K-01)', async () => {
  const { t, backend } = table();
  const wire = await t.spawn('p', spawnOpts);
  t.detach('p');
  await settle();
  backend.procs[0]!.exit(7);
  t.claim('p');
  const attach = t.attach('p', wire.id);
  attach.catch(() => undefined);
  t.detach('p');
  await assert.rejects(attach, { code: 'NotFound' });
  await settle();
  t.claim('p');
  assert.deepEqual((await t.attach('p', wire.id)).exit, { code: 7 });
  assert.deepEqual(t.list('p'), []);
  await t.releaseAll();
});
