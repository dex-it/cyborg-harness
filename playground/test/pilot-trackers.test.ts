import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { waitFor } from '../../core/test/wait-for.ts';
import trackers, { MAX_OUTPUT, POOL_SIZE, TIMEOUT_MS } from '../plugins/trackers/index.ts';
import { Pool } from '../plugins/trackers/pool.ts';
import { startPilot, type Pilot } from './pilot-kit.ts';
import { fakeTrackers, sandbox, type FakeTrackers, type Scenario } from './trackers-kit.ts';

// PL-07: срез трекеров (gh, glab, jira) на хосте-процессе над подставными программами (playground/scripts/fake-trackers.mjs). Потребитель - проба `ui`: зовёт команды плагина
// и отменяет их сигналом (К-09) или идентификатором через `trackers.cancel`, как это делал бы вид. Живые процессы считают сами подставные программы, независимо от плагина.

const MIB = 1024 * 1024;
const MANIFEST = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'plugins', 'trackers', 'manifest.json'), 'utf8')) as { permissions: { process: unknown[] } };

const UI = `
const calls = new Map();
export default {
  activate(ctx) {
    ctx.commands.register('ui.start', (id, tracker, target, options) => {
      const abort = new AbortController();
      const done = ctx.commands.run('trackers.list', tracker, target, options ?? {}, abort.signal).then((value) => ({ ok: true, value }), (e) => ({ ok: false, code: e.code, message: e.message }));
      calls.set(id, { abort, done });
      return true;
    });
    ctx.commands.register('ui.abort', (id) => { calls.get(id)?.abort.abort(); return true; });
    ctx.commands.register('ui.result', (id) => calls.get(id).done);
    ctx.commands.register('ui.run', (command, ...args) => ctx.commands.run(command, ...args));
    return undefined;
  },
};
`;

interface Outcome {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly value?: { readonly tracker: string; readonly target: string; readonly items: readonly { id: string; title: string; url: string; state: string }[]; readonly tookMs: number };
}

interface Rig {
  readonly p: Pilot;
  readonly fake: FakeTrackers;
  start(id: string, tracker: string, target: string, options?: Record<string, unknown>): Promise<unknown>;
  result(id: string): Promise<Outcome>;
  stats(): Promise<{ limit: number; running: number; queued: number; peak: number; requests: number; finished: number; failed: number; cancelled: number; superseded: number }>;
}

const uiCommands = { 'ui.start': { args: ['string', 'string', 'string', 'record?'] }, 'ui.abort': { args: ['string'] }, 'ui.result': { args: ['string'] }, 'ui.run': { args: ['string'], rest: 'any' } };

async function rig(box: Awaited<ReturnType<typeof sandbox>>, scenario: Scenario = {}, path0?: string): Promise<Rig & AsyncDisposable> {
  const fake = await fakeTrackers(box);
  await fake.scenario(scenario);
  const repo = box.path('ws');
  await mkdir(repo);
  const p = await startPilot({
    box,
    repo,
    ids: ['trackers'],
    probes: [{ id: 'ui', source: UI, commands: uiCommands }],
    os: { env: { PATH: path0 ?? `${fake.bin}:/usr/bin:/bin`, HOME: box.root } },
  });
  return {
    p,
    fake,
    start: (id, tracker, target, options) => p.k.run('ui.start', id, tracker, target, ...(options ? [options] : [])),
    result: (id) => p.k.run('ui.result', id) as Promise<Outcome>,
    stats: () => p.k.run('trackers.stats') as ReturnType<Rig['stats']>,
    [Symbol.asyncDispose]: async () => {
      try {
        await p[Symbol.asyncDispose]();
      } finally {
        await fake.cleanup();
      }
    },
  };
}

/** Элемент, который обязан быть: `undefined` - провал теста, а не тихий пропуск. */
function must<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

/** Ждёт, пока не останется живых программ и внуков; возвращает, сколько мс это заняло (замер для docs/05-verification/pilot-trackers.md). */
async function gone(r: Rig, what: string): Promise<number> {
  const t0 = Date.now();
  await waitFor(what, async () => (await r.fake.survivors()).length === 0);
  const ms = Date.now() - t0;
  process.stdout.write(`pl07: ${what} - ${String(ms)} мс\n`);
  return ms;
}

const repoOf = (n: number): string => `acme/repo${String(n)}`;

test('trackers: пул из 20 вызовов gh api идёт с конкуренцией не больше 6; пик живых процессов измерен самими программами', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'ok', ms: 250, count: 5 } });
  // Замер для docs/05-verification/pilot-trackers.md: одиночный вызов через плагин и ядро против голого запуска той же подставной программы.
  const median = (xs: number[]): number => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const single: number[] = [];
  const bare: number[] = [];
  for (let i = 0; i < 9; i++) {
    const a = performance.now();
    await r.start(`s${String(i)}`, 'github', repoOf(100 + i));
    await r.result(`s${String(i)}`);
    single.push(performance.now() - a);
    const b = performance.now();
    await promisify(execFile)(path.join(r.fake.bin, 'gh'), ['api']);
    bare.push(performance.now() - b);
  }
  process.stdout.write(`pl07: одиночный вызов через плагин и ядро ${median(single).toFixed(0)} мс, голый запуск подставной программы ${median(bare).toFixed(0)} мс (медиана 9)\n`);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await r.start(`q${String(i)}`, 'github', repoOf(i));
  const done = await Promise.all(Array.from({ length: 20 }, (_, i) => r.result(`q${String(i)}`)));
  const took = Date.now() - t0;
  assert.ok(done.every((d) => d.ok && d.value?.items.length === 5), JSON.stringify(done.find((d) => !d.ok)));
  assert.deepEqual(done[3]?.value?.items[0], { id: '1', title: 'PR 1', url: 'https://github.com/acme/app/pull/1', state: 'open' });
  const calls = await r.fake.calls();
  assert.equal(calls.length, 20 + 18, '20 вызовов пула и 18 замеров одиночного вызова (по 9 через плагин и голых)');
  const peak = await r.fake.peak();
  assert.equal(peak, POOL_SIZE, 'потолок достигнут, но не превышен: пик по журналу программ');
  assert.deepEqual(await r.stats(), { limit: 6, running: 0, queued: 0, peak: 6, requests: 29, finished: 29, failed: 0, cancelled: 0, superseded: 0 });
  assert.deepEqual(await r.fake.survivors(), []);
  // Волны по 6 при 250 мс на программу: не быстрее четырёх волн, иначе пул не ограничивал.
  assert.ok(took >= 4 * 250, `20 вызовов за ${String(took)} мс`);
  process.stdout.write(`pl07: 20 вызовов пулом 6 по 250 мс - ${String(took)} мс, пик ${String(peak)}\n`);
});

test('trackers: аргументы, окружение и cwd gh, glab и jira закреплены; разбор ответа по трекерам', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box);
  await r.start('a', 'github', 'acme/app');
  await r.start('b', 'gitlab', 'group/sub/app');
  await r.start('c', 'jira', 'ACME');
  const [a, b, c] = await Promise.all([r.result('a'), r.result('b'), r.result('c')]);
  assert.deepEqual(a.value?.items[1], { id: '2', title: 'PR 2', url: 'https://github.com/acme/app/pull/2', state: 'open' });
  assert.deepEqual(b.value?.items[0], { id: '1', title: 'MR 1', url: 'https://gitlab.example/acme/app/-/merge_requests/1', state: 'opened' });
  assert.deepEqual(c.value?.items[2], { id: 'ACME-3', title: 'Задача 3', url: '', state: 'To Do' });
  const all = await r.fake.calls();
  const byTool = { gh: must(all.find((c0) => c0.tool === 'gh')), glab: must(all.find((c0) => c0.tool === 'glab')), jira: must(all.find((c0) => c0.tool === 'jira')) };
  assert.deepEqual(byTool.gh.args, ['api', '--method', 'GET', 'repos/acme/app/pulls?state=open&per_page=100']);
  assert.deepEqual(byTool.glab.args, ['api', '--method', 'GET', 'projects/group%2Fsub%2Fapp/merge_requests?state=opened&per_page=100']);
  assert.deepEqual(byTool.jira.args, ['issue', 'list', '--raw', '-p', 'ACME']);
  assert.deepEqual(byTool.gh.env, { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' });
  assert.deepEqual(byTool.glab.env, { GH_PROMPT_DISABLED: null, NO_COLOR: '1' });
  assert.equal(byTool.gh.cwd, await realpath(box.path('temp', 'trackers')), 'cwd - временный каталог плагина, а не репозиторий');
});

test('trackers: тайм-аут завершает программу и внука; ошибка называет срок', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'hang', child: true } });
  await r.start('t', 'github', 'acme/app', { timeoutMs: 500 });
  const out = await r.result('t');
  assert.deepEqual([out.ok, out.code, out.message], [false, 'Remote', 'trackers: gh не ответил за 500 мс и остановлен']);
  await gone(r, 'после тайм-аута программа и внук завершены');
  assert.equal((await r.fake.children()).length, 1, 'внук был запущен, иначе проверка группы ничего не доказывала');
  assert.equal((await r.stats()).running, 0, 'место в пуле освобождено');
});

test('trackers: выгрузка плагина во время работы пула убивает все процессы и не запускает очередь', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'hang', child: true } });
  for (let i = 0; i < POOL_SIZE + 4; i++) await r.start(`h${String(i)}`, 'github', repoOf(i));
  await waitFor('шесть программ в работе', async () => (await r.fake.calls()).length === POOL_SIZE && (await r.fake.children()).length === POOL_SIZE);
  assert.deepEqual(await r.stats(), { limit: 6, running: 6, queued: 4, peak: 6, requests: 6, finished: 0, failed: 0, cancelled: 0, superseded: 0 });
  const before = await r.fake.survivors();
  assert.equal(before.length, 2 * POOL_SIZE, 'шесть программ и шесть внуков живы');
  await r.p.k.disable('trackers');
  await gone(r, 'после выгрузки плагина 6 программ и 6 внуков завершены');
  const settled = await Promise.all(Array.from({ length: POOL_SIZE + 4 }, (_, i) => r.result(`h${String(i)}`)));
  assert.ok(settled.every((s) => !s.ok), 'вызовы кончились отказом, а не повисли');
  assert.equal((await r.fake.calls()).length, POOL_SIZE, 'очередь после выгрузки новых программ не запускала');
});

test('trackers: отмена сигналом вызывающего плагина (К-09) завершает процесс; вызывающий получает Cancelled', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'hang', child: true } });
  await r.start('s', 'github', 'acme/app');
  await waitFor('программа запущена', async () => (await r.fake.calls()).length === 1);
  await r.p.k.run('ui.abort', 's');
  const out = await r.result('s');
  assert.deepEqual([out.ok, out.code], [false, 'Cancelled']);
  await gone(r, 'после отмены сигналом программа и внук завершены');
  await waitFor('плагин освободил место', async () => (await r.stats()).running === 0);
  assert.equal((await r.stats()).cancelled, 1);
});

test('trackers: отмена по идентификатору (вид сигнала не передаёт) завершает процесс; повторная отмена и чужой id - false', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'hang' } });
  await r.start('v', 'gitlab', 'acme/app', { requestId: 'view-1' });
  await waitFor('программа запущена', async () => (await r.fake.calls()).length === 1);
  assert.equal(await r.p.k.run('ui.run', 'trackers.cancel', 'other'), false);
  assert.equal(await r.p.k.run('ui.run', 'trackers.cancel', 'view-1'), true);
  const out = await r.result('v');
  assert.deepEqual([out.ok, out.code], [false, 'Cancelled']);
  await gone(r, 'после отмены по идентификатору программа завершена');
  assert.equal(await r.p.k.run('ui.run', 'trackers.cancel', 'view-1'), false, 'запрос закончен - отменять нечего');
  await r.start('w', 'gitlab', 'acme/app', { requestId: 'view-2' });
  await assert.rejects(r.start('x', 'gitlab', 'acme/other', { requestId: 'view-2' }).then(() => r.result('x')).then((o) => (o.ok ? undefined : Promise.reject(Object.assign(new Error(o.message), { code: o.code })))), /requestId view-2 уже занят/);
  await r.p.k.run('ui.run', 'trackers.cancel', 'view-2');
});

test('trackers: запрос, отменённый в очереди, процесса не запускает и места не занимает', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'hang' } });
  for (let i = 0; i < POOL_SIZE; i++) await r.start(`h${String(i)}`, 'github', repoOf(i));
  await waitFor('пул занят', async () => (await r.fake.calls()).length === POOL_SIZE);
  await r.start('queued', 'github', 'acme/waiting', { requestId: 'late' });
  await waitFor('седьмой ждёт в очереди', async () => (await r.stats()).queued === 1);
  await r.p.k.run('ui.run', 'trackers.cancel', 'late');
  const out = await r.result('queued');
  assert.deepEqual([out.ok, out.code], [false, 'Cancelled']);
  assert.equal((await r.fake.calls()).length, POOL_SIZE, 'для отменённого программа не запускалась');
  assert.equal((await r.stats()).queued, 0);
});

test('trackers: новый запрос к тому же списку отменяет прежний; устаревший ответ не доходит, процесс прежнего завершён', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'hang' } });
  await r.start('old', 'github', 'acme/app');
  await waitFor('прежний запущен', async () => (await r.fake.calls()).length === 1);
  const [first] = await r.fake.calls();
  await r.fake.scenario({ default: { mode: 'ok', count: 2 } });
  await r.start('new', 'github', 'acme/app');
  const [stale, fresh] = [await r.result('old'), await r.result('new')];
  assert.deepEqual([stale.ok, stale.code, stale.value], [false, 'Cancelled', undefined]);
  assert.deepEqual([fresh.ok, fresh.value?.items.length], [true, 2]);
  await waitFor('прежний процесс завершён', async () => !(await r.fake.survivors()).includes(first!.pid));
  assert.equal((await r.stats()).superseded, 1);
});

test('trackers: ответ, который успел прийти до отмены, при сработавшей отмене вызывающему не отдаётся', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box, { default: { mode: 'ok', ms: 150 } });
  await r.start('late', 'github', 'acme/app');
  await waitFor('программа запущена', async () => (await r.fake.calls()).length === 1);
  await r.p.k.run('ui.abort', 'late');
  const out = await r.result('late');
  assert.deepEqual([out.ok, out.code, out.value], [false, 'Cancelled', undefined]);
});

test('trackers: вывод между 16 и 64 МиБ приходит целым JSON, сверх 64 МиБ - ошибка "ответ больше", а не оборванный JSON; процесс остановлен', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box);
  await r.fake.scenario({ default: { mode: 'big', bytes: 20 * MIB } });
  await r.start('mid', 'github', 'acme/app');
  const mid = await r.result('mid');
  assert.deepEqual([mid.ok, mid.value?.items.length, mid.value?.items[0]?.title.length], [true, 1, 20 * MIB], 'больше 16 МиБ, меньше 64: целый ответ, все байты на месте');

  await r.fake.scenario({ default: { mode: 'big', bytes: MAX_OUTPUT + MIB } });
  await r.start('over', 'github', 'acme/app');
  const over = await r.result('over');
  assert.deepEqual([over.ok, over.message], [false, 'trackers: ответ gh больше 64 МиБ, список не прочитан целиком']);
  await waitFor('программа остановлена по пределу', async () => (await r.fake.survivors()).length === 0);
});

test('trackers: вход не выполнен, код выхода, неверный JSON, ответ не списком; программы нет в PATH - NotFound', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box);
  const cases: [string, string, Scenario, RegExp][] = [
    ['github', 'acme/app', { default: { mode: 'login' } }, /^trackers: вход не выполнен \(gh\): gh: To get started/],
    ['gitlab', 'acme/app', { default: { mode: 'login' } }, /^trackers: вход не выполнен \(glab\): glab: 401 Unauthorized/],
    ['jira', 'ACME', { default: { mode: 'login' } }, /^trackers: вход не выполнен \(jira\): jira: authentication failed/],
    ['github', 'acme/app', { default: { mode: 'exit', code: 5, stderr: 'boom\n' } }, /^trackers: gh завершился с кодом 5: boom$/],
    ['github', 'acme/app', { default: { mode: 'badjson' } }, /^trackers: ответ gh - не JSON$/],
  ];
  for (const [i, [tracker, target, scenario, message]] of cases.entries()) {
    await r.fake.scenario(scenario);
    await r.start(`e${String(i)}`, tracker, target);
    const out = await r.result(`e${String(i)}`);
    assert.equal(out.ok, false);
    assert.match(out.message ?? '', message);
  }
  assert.equal((await r.stats()).failed, cases.length);

  await using lone = await sandbox('cyborg-pl07-');
  await using empty = await rig(lone, {}, lone.path('empty-bin'));
  await empty.start('missing', 'github', 'acme/app');
  const missing = await empty.result('missing');
  assert.deepEqual([missing.ok, missing.code], [false, 'NotFound']);
});

test('trackers: цель с флагом или лишними сегментами отвергается плагином до запуска программы', async () => {
  await using box = await sandbox('cyborg-pl07-');
  await using r = await rig(box);
  const bad: [string, string][] = [
    ['github', '--hostname=evil.example/x'],
    ['github', 'acme/app/extra'],
    ['github', 'acme/../etc'],
    ['gitlab', 'group/-x'],
    ['jira', 'acme'],
    ['jira', '-p'],
    ['svn', 'acme/app'],
  ];
  for (const [i, [tracker, target]] of bad.entries()) {
    await r.start(`b${String(i)}`, tracker, target);
    const out = await r.result(`b${String(i)}`);
    assert.equal(out.ok, false, `${tracker} ${target}`);
  }
  await assert.rejects(r.p.k.run('ui.run', 'trackers.list', 'github', 'acme/app', { timeoutMs: TIMEOUT_MS + 1 }), /timeoutMs - от 1 до 120000/);
  assert.deepEqual(await r.fake.calls(), [], 'ни одной программы');
});

// Права process: то, что проверяет ядро. Проба получает те же правила, что манифест trackers, и зовёт ctx.os.process напрямую.
const ROGUE = `
export default {
  activate(ctx) {
    ctx.commands.register('rogue.run', async (program, args, env) => {
      try {
        const r = await ctx.os.process.run(program, args, env ? { env } : {});
        return { ok: true, code: r.code };
      } catch (e) {
        return { ok: false, code: e.code };
      }
    });
    return undefined;
  },
};
`;

test('trackers: чужая программа, другие аргументы, лишняя переменная и запрещённый флаг после закреплённого префикса - PermissionDenied и запись в журнале (K-34)', async () => {
  await using box = await sandbox('cyborg-pl07-');
  const fake = await fakeTrackers(box);
  await fake.scenario({});
  const repo = box.path('ws');
  await mkdir(repo);
  await using p = await startPilot({
    box,
    repo,
    ids: [],
    probes: [{ id: 'rogue', source: ROGUE, commands: { 'rogue.run': { args: ['string', 'strings', 'record?'] } }, permissions: { process: MANIFEST.permissions.process } }],
    os: { env: { PATH: `${fake.bin}:/usr/bin:/bin`, HOME: box.root } },
  });
  try {
    const run = (program: string, args: string[], env?: Record<string, string>) => p.k.run('rogue.run', program, args, ...(env ? [env] : [])) as Promise<{ ok: boolean; code?: string }>;
    const denied = [
      await run('rm', ['-rf', '/']),
      await run('gh', ['auth', 'token']),
      await run('gh', ['api', '--method', 'DELETE', 'repos/acme/app']),
      await run('gh', ['api', '--method', 'GET', 'repos/acme/app'], { GH_TOKEN: 'x' }),
      await run('jira', ['issue', 'delete', 'ACME-1']),
    ];
    assert.deepEqual(denied, Array.from({ length: 5 }, () => ({ ok: false, code: 'PermissionDenied' })));
    // Подряд идущие одинаковые отказы журнал склеивает: два отказа `gh` по аргументам - одна запись.
    const journal = p.k.journal.flatMap((e) => (e.kind === 'denied' && e.pluginId === 'rogue' ? [`${e.method}: ${e.detail}`] : []));
    assert.deepEqual(journal, ['process.run: программа не в process: rm', 'process.run: аргументы не по правилу process: gh', 'process.run: переменные не в правиле process: GH_TOKEN', 'process.run: аргументы не по правилу process: jira']);
    assert.deepEqual(await fake.calls(), [], 'отказанные вызовы не запускали программу');

    // K-34: флаг из `deny` правила после закреплённого префикса (`-X DELETE`, `--hostname`, `--input=`) ядро отклоняет; в журнале имя флага из deny, без значений.
    const tail = [
      await run('gh', ['api', '--method', 'GET', 'repos/acme/app/issues', '-X', 'DELETE', '--hostname', 'evil.example']),
      await run('gh', ['api', '--method', 'GET', 'repos/acme/app/issues', '--hostname=evil.example']),
      await run('glab', ['api', '--method', 'GET', 'projects/1/issues', '--input=/etc/passwd']),
    ];
    assert.deepEqual(tail, Array.from({ length: 3 }, () => ({ ok: false, code: 'PermissionDenied' })));
    const flags = p.k.journal.flatMap((e) => (e.kind === 'denied' && e.pluginId === 'rogue' ? [e.detail] : [])).slice(journal.length);
    assert.deepEqual(flags, ['запрещён флаг -X в правиле process: gh', 'запрещён флаг --hostname в правиле process: gh', 'запрещён флаг --input в правиле process: glab']);
    assert.deepEqual(await fake.calls(), [], 'запрещённые флаги не дошли до программы');
    // Читающий вызов без запрещённых флагов проходит: список флагов не ломает плагин.
    assert.deepEqual(await run('gh', ['api', '--method', 'GET', 'repos/acme/app/issues?state=open']), { ok: true, code: 0 });
    assert.equal((await fake.calls()).length, 1);
  } finally {
    await fake.cleanup();
  }
});

test('trackers: в вызов process.run уходят тайм-аут 120 с, предел 64 МиБ, cwd во временном каталоге и env по правилу', async () => {
  const seen: { program: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ctx = {
    commands: { register: (name: string, handler: (...args: unknown[]) => unknown) => void handlers.set(name, handler) },
    os: {
      paths: { temp: '/tmp/plugin-temp' },
      fs: { mkdir: () => Promise.resolve() },
      process: {
        run: (program: string, args: readonly string[], options: Record<string, unknown>) => {
          seen.push({ program, args, options });
          return Promise.resolve({ code: 0, signal: null, stdout: '[]', stderr: '', truncated: false });
        },
      },
    },
  } as unknown as PluginContext;
  await trackers.activate(ctx);
  await handlers.get('trackers.list')?.('github', 'acme/app');
  assert.equal(seen.length, 1);
  const first = must(seen[0]);
  assert.equal(first.program, 'gh');
  assert.deepEqual({ ...first.options, signal: undefined }, { cwd: '/tmp/plugin-temp', env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeoutMs: 120_000, maxOutputBytes: 64 * MIB, signal: undefined });
  assert.ok(first.options.signal instanceof AbortSignal);
  // Манифест: правила закрепляют префикс и называют только те переменные, что плагин передаёт.
  // K-34: хвост argv закрыт от смены метода, тела запроса, хоста и заголовков (`deny`); `jira` в примерах задачи нет, его список ведёт автор плагина отдельно.
  const apiDeny = ['--method', '-X', '--input', '--field', '-F', '--raw-field', '-f', '--hostname', '--header', '-H'];
  assert.deepEqual(MANIFEST.permissions.process, [
    { program: 'gh', args: ['api', '--method', 'GET'], env: ['GH_PROMPT_DISABLED', 'NO_COLOR'], deny: apiDeny },
    { program: 'glab', args: ['api', '--method', 'GET'], env: ['NO_COLOR'], deny: apiDeny },
    { program: 'jira', args: ['issue', 'list', '--raw'], env: ['NO_COLOR'] },
  ]);
});

test('Pool: не больше limit одновременно, очередь по порядку, отмена в очереди не занимает места', async () => {
  const pool = new Pool(2);
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const task = (name: string, signal: AbortSignal) => () =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(`${name}: отменён до запуска`));
        return;
      }
      order.push(`start ${name}`);
      gates.set(name, () => resolve(name));
    });
  const none = new AbortController();
  const gone = new AbortController();
  const start = (n: string, signal: AbortSignal) => pool.run(signal, task(n, signal));
  const [ra, rb, rc, rd] = [start('a', none.signal), start('b', none.signal), start('c', gone.signal), start('d', none.signal)];
  assert.deepEqual([pool.running, pool.queued, order], [2, 2, ['start a', 'start b']]);
  gone.abort();
  assert.equal(pool.queued, 1);
  await assert.rejects(rc, /c: отменён до запуска/);
  gates.get('a')?.();
  assert.equal(await ra, 'a');
  assert.deepEqual(order, ['start a', 'start b', 'start d'], 'отменённый c пропущен, d идёт следующим');
  gates.get('b')?.();
  gates.get('d')?.();
  assert.deepEqual(await Promise.all([rb, rd]), ['b', 'd']);
  assert.deepEqual([pool.running, pool.queued, pool.peak], [0, 0, 2]);
  const dead = AbortSignal.abort();
  await assert.rejects(pool.run(dead, task('z', dead)), /z: отменён до запуска/);
  assert.equal(pool.running, 0, 'сработавший сигнал места не занимает');
});
