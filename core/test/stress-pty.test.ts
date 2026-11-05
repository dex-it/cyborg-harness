import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext, PtyHandle } from '@cyborg/contracts';
import { load } from '../src/loader.ts';
import { PtyTable, type TerminalSink } from '../src/pty.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { fakePty } from './fake-pty.ts';

const spawnOpts = { program: 'sh', args: [] as string[], env: {}, cols: 80, rows: 24, persist: true };

function table(limit = 1000, ttl = 30_000) {
  const backend = fakePty();
  const pushed: { pluginId: string; method: string; params: unknown }[] = [];
  const t = new PtyTable(backend, (pluginId, method, params) => void pushed.push({ pluginId, method, params }), limit, ttl);
  return { t, backend, pushed };
}

const sink = (): TerminalSink => ({ data: () => undefined, exit: () => undefined });

test('stress-pty: 300 pty за цикл (spawn, вывод, выход, release) - таблица пуста, процессы убиты', () => {
  const { t, backend } = table();
  for (let i = 0; i < 300; i++) t.spawn('p', { ...spawnOpts, persist: i % 2 === 0 });
  assert.equal(t.list('p').length, 300);
  for (const [i, proc] of backend.procs.entries()) {
    proc.emit(`out-${String(i)}`);
    if (i % 3 === 0) proc.exit(0);
  }
  t.release('p');
  assert.deepEqual(t.list('p'), []);
  assert.equal(backend.procs.filter((p, i) => i % 3 !== 0 && p.killed === undefined).length, 0, 'живые убиты release');
});

test('stress-pty: кольцевой буфер - 5 МБ мелкими кусками не выходит за предел, хвост точный; граница ровно по размеру', () => {
  const { t, backend } = table(1000);
  const wire = t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  let all = '';
  for (let i = 0; i < 50_000; i++) {
    const chunk = String(i % 10).repeat(100);
    all += chunk.slice(0, 100);
    proc.emit(chunk);
  }
  const attached = t.attach('p', wire.id);
  assert.equal(attached.backlog.length, 1000);
  assert.equal(attached.backlog, all.slice(-1000));
  // Ровно по пределу: ни потерь, ни лишнего.
  const w2 = t.spawn('p', spawnOpts);
  const proc2 = backend.procs[1];
  assert.ok(proc2);
  proc2.emit('a'.repeat(1000));
  assert.equal(t.attach('p', w2.id).backlog, 'a'.repeat(1000));
  proc2.emit('b');
  assert.equal(t.attach('p', w2.id).backlog, 'a'.repeat(999) + 'b');
});

test('stress-pty: вывод идёт мелкими кусками - обработка 5000 кусков по 64 байта при полном хвосте укладываются в четверть секунды', () => {
  // Под нагрузкой TUI шлёт тысячи мелких кусков в секунду; цена одного куска не должна расти с размером хвоста (256 КБ по умолчанию).
  const backend = fakePty();
  const t = new PtyTable(backend, () => undefined);
  t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  proc.emit('f'.repeat(256 * 1024));
  const chunk = 'x'.repeat(64);
  const started = performance.now();
  for (let i = 0; i < 5000; i++) proc.emit(chunk);
  const ms = performance.now() - started;
  assert.ok(ms < 250, `5000 кусков по 64 байта при хвосте 256 КБ: ${ms.toFixed(0)} мс`);
});

test('stress-pty: выход процесса, пока владельца нет (persist) - attach отдаёт код выхода один раз, потом pty нет', () => {
  const { t, backend, pushed } = table();
  const wire = t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  t.detach('p');
  proc.emit('last words');
  proc.exit(7);
  assert.deepEqual(pushed.filter((m) => m.method === 'pty.exit'), [], 'владельца нет - никому не шлём');
  const a = t.attach('p', wire.id);
  assert.equal(a.exit?.code, 7);
  assert.equal(a.backlog, 'last words');
  assert.throws(() => t.attach('p', wire.id), { code: 'NotFound' });
  assert.deepEqual(t.list('p'), []);
});

test('stress-pty: билеты share - просроченные не копятся и не открываются, повторное предъявление отказывает при 500 билетах', async () => {
  const { t } = table(1000, 200);
  const wire = t.spawn('p', spawnOpts);
  const tickets = Array.from({ length: 500 }, () => t.share('p', wire.id));
  assert.equal(new Set(tickets).size, 500);
  const first = tickets[0]!;
  const s = sink();
  const view = t.openTerminal('p', first, s);
  view.close();
  assert.throws(() => t.openTerminal('p', first, s), { code: 'NotFound' });
  await sleep(260);
  assert.throws(() => t.openTerminal('p', tickets[1]!, s), { code: 'NotFound' }, 'просрочен');
});

test('stress-pty: зритель открыт, процесс вышел - зритель получает exit, write после выхода отказывает, pty в таблице чист после release', () => {
  const { t, backend } = table();
  const wire = t.spawn('p', spawnOpts);
  const proc = backend.procs[0];
  assert.ok(proc);
  const exits: unknown[] = [];
  const view = t.openTerminal('p', t.share('p', wire.id), { data: () => undefined, exit: (e) => void exits.push(e) });
  proc.exit(0);
  assert.equal(exits.length, 1);
  assert.throws(() => view.write('x'), { code: 'NotFound' });
  t.release('p');
  assert.deepEqual(t.list('p'), []);
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
    apiVersion: '1.0.0',
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
