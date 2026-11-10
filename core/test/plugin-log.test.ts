import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext } from '@cyborg-harness/contracts';
import { memorySecrets } from '../../testing/src/memory.ts';
import { sandbox } from '../../testing/src/sandbox.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load, type JournalEntry, type Kernel, type LoadOptions } from '../src/loader.ts';
import { describeEntry, entryLevel, pluginStatuses } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';
import { waitFor } from './wait-for.ts';

// K-29 (FR-CH-4009, 4010, 4018): уровень строки ctx.log, вывод хоста по плагину, предел длины и частоты, вычёркивание секретов.

type Line = readonly [pluginId: string, message: string, level: string];

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

interface Rig {
  readonly k: Kernel;
  /** Контексты плагинов: тест пишет в `ctx.log` от их имени. */
  readonly ctx: Record<string, PluginContext>;
  readonly lines: Line[];
  readonly journal: JournalEntry[];
}

/** Ядро с хостами в процессе теста: плагин берёт свой `ctx` при активации, строки собираются из `onLog`. */
async function rig(ids: readonly string[], options: Partial<LoadOptions> = {}): Promise<Rig> {
  const ctx: Record<string, PluginContext> = {};
  const lines: Line[] = [];
  const journal: JournalEntry[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ids,
    manifests: ids.map((id) => manifest(id)),
    spawnHost: inlineHosts(async (entry) => ({
      activate: (c: PluginContext) => {
        ctx[entry] = c;
      },
    })),
    onLog: (pluginId, message, level) => void lines.push([pluginId, message, level]),
    onJournal: (e) => void journal.push(e),
    ...options,
  });
  return { k, ctx, lines, journal };
}

/** Ждёт, пока условие станет истинным: хост доставляет сообщения через очередь, а не синхронно. */
async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`не дождались: ${what}`);
    await sleep(5);
  }
}

test('ctx.log: без уровня - info, с уровнем - он; в записи id плагина', async () => {
  const { k, ctx, lines } = await rig(['a', 'b']);
  try {
    ctx.a?.log('x');
    ctx.a?.log('y', 'error');
    ctx.b?.log('z', 'warn');
    await until('три строки', () => lines.length === 3);
    assert.deepEqual(lines, [['a', 'x', 'info'], ['a', 'y', 'error'], ['b', 'z', 'warn']]);
  } finally {
    await k.unload();
  }
});

test('ctx.log: неизвестный уровень - Invalid в плагине, строка не пишется', async () => {
  const { k, ctx, lines } = await rig(['a']);
  try {
    assert.throws(() => ctx.a?.log('x', 'debug' as never), { code: 'Invalid' });
    ctx.a?.log('после');
    await until('строка после отказа', () => lines.length === 1);
    assert.deepEqual(lines, [['a', 'после', 'info']]);
  } finally {
    await k.unload();
  }
});

test('ctx.log хоста: слушатель fs.watch, который бросил, и слушатель события окна пишутся строкой error с id плагина', async () => {
  await using box = await sandbox();
  const work = box.path('work');
  await mkdir(work);
  const { k, ctx, lines } = await rig(['a'], { manifests: [manifest('a', { permissions: { 'fs.read': [work] } })], os: { dataDir: box.path('data'), tempDir: box.path('temp') } });
  try {
    await ctx.a!.os.fs.watch(work, () => {
      throw new Error('сломан в watch');
    });
    ctx.a!.window.onFocusChange(() => {
      throw new Error('сломан в окне');
    });
    await writeFile(path.join(work, 'x.txt'), '1');
    k.emit({ kind: 'focus', focused: false });
    await until('обе строки об упавших слушателях', () => lines.length >= 2);
    assert.deepEqual(lines.toSorted(), [['a', 'слушатель fs.watch упал: сломан в watch', 'error'], ['a', 'слушатель focus упал: сломан в окне', 'error']].toSorted());
  } finally {
    await k.unload();
  }
});

const summaries = (journal: readonly JournalEntry[], pluginId?: string) =>
  journal.filter((e): e is Extract<JournalEntry, { kind: 'log-summary' }> => e.kind === 'log-summary' && (pluginId === undefined || e.pluginId === pluginId));

test('длина: строка длиннее предела обрезается по границе символа и помечается, короткая идёт как есть', async () => {
  const { k, ctx, lines } = await rig(['a'], { limits: { logLineBytes: 64 } });
  try {
    ctx.a?.log('коротко');
    ctx.a?.log('я'.repeat(100));
    ctx.a?.log('x'.repeat(65), 'warn');
    await until('три строки', () => lines.length === 3);
    assert.equal(lines[0]?.[1], 'коротко');
    for (const [, message] of lines.slice(1)) {
      const [head, mark] = message.split(' [обрезано');
      assert.ok(Buffer.byteLength(head ?? '') <= 64, `голова ${String(Buffer.byteLength(head ?? ''))} Б`);
      assert.ok(mark !== undefined && /^: всего \d+ Б\]$/.test(mark), `пометка: ${message}`);
      assert.ok(!message.includes('�'), 'разрезан символ');
    }
    assert.equal(lines[1]?.[1], `${'я'.repeat(32)} [обрезано: всего 200 Б]`);
    assert.deepEqual(lines[2], ['a', `${'x'.repeat(64)} [обрезано: всего 65 Б]`, 'warn']);
  } finally {
    await k.unload();
  }
});

test('длина: предел по умолчанию - 8 КиБ', async () => {
  const { k, ctx, lines } = await rig(['a']);
  try {
    ctx.a?.log('x'.repeat(8192));
    ctx.a?.log('x'.repeat(8193));
    await until('две строки', () => lines.length === 2);
    assert.equal(lines[0]?.[1].length, 8192, 'ровно предел - без пометки');
    assert.match(lines[1]?.[1] ?? '', /\[обрезано: всего 8193 Б\]$/);
  } finally {
    await k.unload();
  }
});

test('частота: строк сверх предела за интервал в журнал по одной не идёт, в конце интервала - одна сводная с последней error; сосед и состояние целы', async () => {
  const { k, ctx, lines, journal } = await rig(['a', 'b'], { limits: { logRate: 5, logWindowMs: 100 } });
  try {
    for (let i = 0; i < 12; i++) ctx.a?.log(`info ${String(i)}`);
    ctx.a?.log('первая беда', 'error');
    ctx.a?.log('последняя беда', 'error');
    ctx.a?.log('снова info');
    ctx.b?.log('сосед');
    await until('сводная запись', () => summaries(journal, 'a').length === 1);
    assert.deepEqual(lines.filter(([id]) => id === 'a').map(([, m]) => m), ['info 0', 'info 1', 'info 2', 'info 3', 'info 4']);
    assert.deepEqual(lines.filter(([id]) => id === 'b').map(([, m]) => m), ['сосед']);
    // 15 строк, пять прошли; пропущено 10 (7 info + 2 error + 1 info).
    assert.deepEqual(summaries(journal, 'a').map(({ skipped, errors, lastError }) => ({ skipped, errors, lastError })), [{ skipped: 10, errors: 2, lastError: 'последняя беда' }]);
    assert.deepEqual(summaries(journal, 'b'), []);
    assert.equal(k.journal.filter((e) => e.kind === 'log-summary').length, 1, 'сводная в журнале ядра');
  } finally {
    await k.unload();
  }
});

test('частота: сводная запись не меняет состояние плагина; после интервала строки идут снова', async () => {
  const { k, ctx, lines, journal } = await rig(['a'], { limits: { logRate: 2, logWindowMs: 60 } });
  try {
    for (let i = 0; i < 6; i++) ctx.a?.log(`s${String(i)}`);
    await until('сводная', () => summaries(journal).length === 1);
    assert.deepEqual(pluginStatuses(k.journal).map((s) => [s.id, s.state]), [['a', 'active']]);
    assert.equal(entryLevel(summaries(journal)[0]!), 'warn');
    assert.match(describeEntry(summaries(journal)[0]!), /4/);
    ctx.a?.log('позже');
    await until('строка после интервала', () => lines.some(([, m]) => m === 'позже'));
    assert.deepEqual(lines.map(([, m]) => m), ['s0', 's1', 'позже']);
  } finally {
    await k.unload();
  }
});

test('частота: сводная записывается и тогда, когда плагин замолчал; без превышения сводной нет', async () => {
  const { k, ctx, lines, journal } = await rig(['a', 'b'], { limits: { logRate: 3, logWindowMs: 50 } });
  try {
    for (let i = 0; i < 3; i++) ctx.b?.log(`b${String(i)}`);
    for (let i = 0; i < 5; i++) ctx.a?.log(`a${String(i)}`);
    await until('сводная a', () => summaries(journal, 'a').length === 1);
    await sleep(120);
    assert.equal(summaries(journal).length, 1, 'ровно предел - не превышение');
    assert.equal(lines.filter(([id]) => id === 'b').length, 3);
  } finally {
    await k.unload();
  }
});

test('частота: выгрузка ядра пишет сводную запись, которую не дожидался интервал', async () => {
  const { k, ctx, journal } = await rig(['a'], { limits: { logRate: 1, logWindowMs: 60_000 } });
  ctx.a?.log('раз');
  ctx.a?.log('два');
  ctx.a?.log('три', 'error');
  await sleep(50);
  assert.deepEqual(summaries(journal), [], 'окно ещё не закрыто');
  await k.unload();
  assert.deepEqual(summaries(journal).map(({ skipped, errors, lastError }) => ({ skipped, errors, lastError })), [{ skipped: 2, errors: 1, lastError: 'три' }]);
});

const switchedOff = (journal: readonly JournalEntry[], pluginId: string) =>
  journal.filter((e): e is Extract<JournalEntry, { kind: 'switched-off' }> => e.kind === 'switched-off' && e.pluginId === pluginId);

/** Плагин пишет строки пачками раз в `every` мс, пока тест не остановит; `stop()` снимает таймер. */
function pour(write: (i: number) => void, perTick: number, every: number): () => void {
  let i = 0;
  const timer = setInterval(() => {
    for (let n = 0; n < perTick; n++) write(i++);
  }, every);
  return () => clearInterval(timer);
}

test('поток: плагин выше предела частоты дольше срока выключается (switched-off, log-flood), строки после этого не идут, сосед пишет как прежде', async () => {
  const { k, ctx, lines, journal } = await rig(['a', 'b'], { limits: { logRate: 2, logWindowMs: 100, logFloodMs: 400 } });
  const stopA = pour((i) => ctx.a?.log(`поток ${String(i)}`), 10, 5);
  const stopB = pour((i) => ctx.b?.log(`сосед ${String(i)}`), 1, 60);
  try {
    await until('выключение a', () => switchedOff(journal, 'a').length === 1, 5000);
    const [off] = switchedOff(journal, 'a');
    assert.deepEqual({ strikes: off?.strikes, reason: off?.reason }, { strikes: 0, reason: 'log-flood' });
    assert.match(describeEntry(off!), /поток строк/);
    assert.deepEqual(pluginStatuses(k.journal).map((s) => [s.id, s.state, s.revivable]), [['a', 'stopped', true], ['b', 'active', false]]);
    await k.idle();
    assert.deepEqual(k.active, ['b']);
    const seen = lines.filter(([id]) => id === 'a').length;
    await sleep(150);
    assert.equal(lines.filter(([id]) => id === 'a').length, seen, 'после switched-off строки плагина идут в журнал');
    assert.ok(lines.filter(([id]) => id === 'b').length >= 3, 'строки соседа в том же хосте потеряны');
    assert.equal(switchedOff(journal, 'b').length, 0);
    assert.equal(switchedOff(journal, 'a').length, 1, 'выключен дважды');
  } finally {
    stopA();
    stopB();
    await k.unload();
  }
});

test('поток: всплески выше предела с паузами дольше интервала плагин не выключают', async () => {
  const { k, ctx, journal } = await rig(['a'], { limits: { logRate: 2, logWindowMs: 40, logFloodMs: 160 } });
  try {
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 6; i++) ctx.a?.log(`всплеск ${String(round)}.${String(i)}`);
      await sleep(100);
    }
    assert.ok(summaries(journal, 'a').length >= 5, 'всплески должны были дать сводные записи');
    assert.deepEqual(switchedOff(journal, 'a'), []);
    assert.deepEqual(k.active, ['a']);
  } finally {
    await k.unload();
  }
});

test('поток: после «Включить снова» плагин пишет в журнал, счёт потока начат заново', async () => {
  const { k, ctx, lines, journal } = await rig(['a'], { limits: { logRate: 2, logWindowMs: 100, logFloodMs: 300 } });
  const stop = pour((i) => ctx.a?.log(`поток ${String(i)}`), 10, 5);
  try {
    await until('выключение', () => switchedOff(journal, 'a').length === 1, 5000);
    stop();
    await k.idle();
    await k.enable('a');
    ctx.a?.log('вернулся');
    await until('строка после enable', () => lines.some(([, m]) => m === 'вернулся'));
    await sleep(60);
    assert.equal(switchedOff(journal, 'a').length, 1, 'после enable выключен снова без нового потока');
    assert.deepEqual(k.active, ['a']);
  } finally {
    stop();
    await k.unload();
  }
});

/** Всплеск из `n` строк в момент `at` на подставных часах (`Date`); хост доставляет строки через очередь, поэтому после всплеска короткая пауза. */
async function burst(t: { mock: { timers: { setTime(ms: number): void } } }, ctx: () => PluginContext | undefined, at: number, n: number): Promise<void> {
  t.mock.timers.setTime(at);
  for (let i = 0; i < n; i++) ctx()?.log(`всплеск ${String(at)}.${String(i)}`);
  await sleep(25);
}

test('поток: всплески через паузу короче окна, но с частотой в среднем ниже предела, потоком не считаются (FR-CH-4018: «подряд» - без паузы)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  // Предел 2 строки за 1 с, всплеск в 3 строки раз в 1990 мс: в среднем 1,5 строки/с. За 14 с набегает больше срока в 5 с, если паузу меньше окна считать продолжением.
  const { k, ctx, journal } = await rig(['a'], { limits: { logRate: 2, logWindowMs: 1000, logFloodMs: 5000 } });
  try {
    for (let i = 0; i < 8; i++) await burst(t, () => ctx.a, 1_000_000 + i * 1990, 3);
    await burst(t, () => ctx.a, 1_000_000 + 8 * 1990, 1);
    assert.equal(summaries(journal, 'a').length, 8, 'каждый всплеск дал сводную запись');
    assert.deepEqual(switchedOff(journal, 'a'), []);
    assert.deepEqual(k.active, ['a']);
  } finally {
    await k.unload();
  }
});

test('поток: плагин снят до срока - счёт потока начат заново, switched-off не пишется ни при снятии, ни после «Включить»', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { k, ctx, journal } = await rig(['a'], { limits: { logRate: 2, logWindowMs: 1000, logFloodMs: 5000 } });
  try {
    // Пять интервалов подряд сверх предела: поток идёт 4 с из 5.
    for (let i = 0; i < 5; i++) await burst(t, () => ctx.a, 1_000_000 + i * 1000, 3);
    // Снятие дописывает последний интервал (поток стал бы 5 с), но решения о потоке не принимает.
    await k.disable('a');
    assert.deepEqual(switchedOff(journal, 'a'), [], 'выключен при снятии');
    await k.enable('a');
    // Прежний счёт, доживи он до этих строк, дал бы 5 с и выключение; новый - 1 с.
    await burst(t, () => ctx.a, 1_000_000 + 5000, 3);
    await burst(t, () => ctx.a, 1_000_000 + 6000, 3);
    await burst(t, () => ctx.a, 1_000_000 + 7000, 1);
    assert.deepEqual(switchedOff(journal, 'a'), []);
    assert.deepEqual(k.active, ['a']);
  } finally {
    await k.unload();
  }
});

test('поток: интервал закрывается строкой, пришедшей раньше таймера, - выключенный им плагин эту строку уже не пишет', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { k, ctx, lines, journal } = await rig(['a'], { limits: { logRate: 1, logWindowMs: 1000, logFloodMs: 1000 } });
  try {
    ctx.a?.log('первая');
    ctx.a?.log('сверх предела');
    await sleep(30);
    t.mock.timers.setTime(1_005_000);
    ctx.a?.log('после интервала');
    await until('выключение', () => switchedOff(journal, 'a').length === 1);
    await sleep(30);
    assert.deepEqual(lines.map(([, m]) => m), ['первая']);
    assert.deepEqual(summaries(journal, 'a').map((e) => e.skipped), [1]);
  } finally {
    await k.unload();
  }
});

// FR-CH-4018, вопрос 7 SRS фичи 04: ядро вычёркивает из строк значения, лежащие в хранилище секретов.
/** Среда ядра с хранилищем секретов в памяти из тест-кита; `map` - то, что в хранилище лежит. */
function withSecrets(): { store: Map<string, string>; os: NonNullable<LoadOptions['os']> } {
  const secrets = memorySecrets();
  return { store: secrets.map, os: { dataDir: tmpdir(), tempDir: tmpdir(), secrets } };
}

test('секреты: значение из хранилища (set, get, resolve) вычёркивается из строки ctx.log; чужому плагину оно не принадлежит', async () => {
  const { os } = withSecrets();
  const { k, ctx, lines } = await rig(['a', 'b'], { os });
  try {
    const secret = `s3cr3t-${randomUUID()}`;
    const other = `tok-${randomUUID()}`;
    ctx.a?.log(`до записи ${secret}`);
    await ctx.a!.os.secrets.set('token', secret);
    await ctx.a!.os.secrets.set('other', other);
    ctx.a?.log(`токен ${secret}, ещё ${other}`, 'warn');
    ctx.b?.log(`чужой плагин пишет ${secret}`);
    await until('три строки', () => lines.length === 3);
    assert.deepEqual(lines[0], ['a', `до записи ${secret}`, 'info']);
    assert.deepEqual(lines[1], ['a', 'токен [секрет], ещё [секрет]', 'warn']);
    assert.deepEqual(lines[2], ['b', `чужой плагин пишет ${secret}`, 'info']);

    // Значение, прочитанное в этом запуске, плагин мог унести в строку: get и resolve запоминают его так же, как set.
    const read = `read-${randomUUID()}`;
    await ctx.b!.os.secrets.set('k', read);
    await ctx.b!.os.secrets.delete('k');
    const rotated = `rot-${randomUUID()}`;
    await ctx.b!.os.secrets.set('t', read);
    await ctx.b!.os.secrets.set('t', rotated);
    ctx.b?.log(`после delete ${read} и ротации ${rotated}`);
    await until('четвёртая строка', () => lines.length === 4);
    // Плагин ещё держит значение в памяти, а на сервере старый токен может действовать: забывать его после delete и перезаписи нельзя.
    assert.equal(lines[3]?.[1], 'после delete [секрет] и ротации [секрет]');
  } finally {
    await k.unload();
  }
});

test('секреты: прочитанное через get и resolve вычёркивается, в том числе из сводной записи', async () => {
  const { store, os } = withSecrets();
  const secret = `s3cr3t-${randomUUID()}`;
  store.set('a/via-get', secret);
  store.set('a/via-resolve', `${secret}-2`);
  const { k, ctx, lines, journal } = await rig(['a'], { os, limits: { logRate: 1, logWindowMs: 60 } });
  try {
    ctx.a?.log('нулевая');
    assert.equal(await ctx.a!.os.secrets.get('via-get'), secret);
    assert.deepEqual(await ctx.a!.secrets.resolve('via-resolve'), { value: `${secret}-2` });
    ctx.a?.log(`с get: ${secret}`);
    ctx.a?.log(`с resolve: ${secret}-2`);
    ctx.a?.log(`беда ${secret}-2 и ${secret}`, 'error');
    await until('сводная', () => summaries(journal, 'a').length === 1);
    assert.equal(lines.length, 1, 'сверх предела по одной не идёт');
    const [summary] = summaries(journal, 'a');
    assert.equal(summary?.lastError, 'беда [секрет] и [секрет]');
    assert.ok(!JSON.stringify(k.journal).includes(secret));
  } finally {
    await k.unload();
  }
});

test('секреты: значение, разрезанное границей обрезки, не остаётся началом строки; вычёркивание удлиняет короткую строку - обрезка после него', async () => {
  const { os } = withSecrets();
  const { k, ctx, lines } = await rig(['a'], { os, limits: { logLineBytes: 32 } });
  try {
    const secret = `s3cr3t-${randomUUID()}`;
    await ctx.a!.os.secrets.set('token', secret);
    await ctx.a!.os.secrets.set('short', 'qqqq');
    ctx.a?.log(`${'x'.repeat(28)}${secret}`);
    ctx.a?.log('q'.repeat(20));
    await until('две строки', () => lines.length === 2);
    // 28 Б чистого текста и 14 Б метки: на границе в 32 Б от секрета не осталось ни символа, кроме начала самой метки.
    assert.equal(lines[0]?.[1], `${'x'.repeat(28)}[с [обрезано: всего 42 Б]`);
    // Пять замен по 14 Б - 70 Б; в 32 Б помещаются две и начало третьей.
    assert.equal(lines[1]?.[1], '[секрет][секрет][с [обрезано: всего 70 Б]');
  } finally {
    await k.unload();
  }
});

test('секреты: значение короче 4 символов не вычёркивается - замена испортила бы строку, а скрыть такое значение нельзя', async () => {
  const { os } = withSecrets();
  const { k, ctx, lines } = await rig(['a'], { os });
  try {
    await ctx.a!.os.secrets.set('pin', '123');
    await ctx.a!.os.secrets.set('flag', 'e');
    await ctx.a!.os.secrets.set('edge', '1234');
    ctx.a?.log('Error: heap exhausted, пин 123, 1234');
    await until('строка', () => lines.length === 1);
    assert.equal(lines[0]?.[1], 'Error: heap exhausted, пин 123, [секрет]');
  } finally {
    await k.unload();
  }
});

// Хвост ревью K-29 (#149): строки самого ядра о плагине идут теми же пределами FR-CH-4018, что строки плагина, но не отбрасываются, если плагин уже выключен.

/**
 * Ядро с плагином `bell`: команда `bell.open` падает с текстом `fail`; клик по уведомлению (`clicks[0].click()`) запускает её через ядро.
 * Вторая активация плагина `slow` (после `disable` и `enable`) держит очередь операций ядра, пока не открыт `gate`: снятие `bell` ждёт за ней.
 */
async function clickRig(fail: () => Error, options: Partial<LoadOptions> = {}, gate?: Promise<void>) {
  const clicks: { click(): void }[] = [];
  const ctx: Record<string, PluginContext> = {};
  let slowRuns = 0;
  const { k, lines, journal } = await rig(['bell', 'slow'], {
    manifests: [manifest('bell', { commands: { 'bell.open': { args: [] } }, permissions: { notify: true } }), manifest('slow')],
    spawnHost: inlineHosts(async (entry) => ({
      activate: async (c: PluginContext) => {
        ctx[entry] = c;
        if (entry === 'slow') {
          if (++slowRuns > 1) await gate;
        }
        else {
          c.commands.register('bell.open', () => {
            throw fail();
          });
        }
      },
    })),
    os: { dataDir: tmpdir(), tempDir: tmpdir(), notify: (_title, _body, events) => (clicks.push(events), { close: () => undefined }), secrets: memorySecrets() },
    ...options,
  });
  return { k, ctx, lines, journal, clicks };
}

test('клик по уведомлению: текст ошибки команды в строке ядра обрезан по пределу и без значений секретов (FR-CH-4018)', async () => {
  const secret = `s3cr3t-${randomUUID()}`;
  const { k, ctx, lines, clicks } = await clickRig(() => new Error(`${secret} ${'я'.repeat(300)}`), { limits: { logLineBytes: 64 } });
  try {
    await ctx.bell!.os.secrets.set('token', secret);
    await ctx.bell!.os.notify!.show('Сессия ждёт', undefined, { onClick: { command: 'bell.open' } });
    clicks[0]!.click();
    await waitFor('строка о клике', () => lines.some(([id, m]) => id === 'bell' && m.startsWith('клик по уведомлению')));
    const line = lines.find(([id]) => id === 'bell')!;
    assert.equal(line[2], 'warn');
    assert.ok(!line[1].includes(secret), `секрет в строке: ${line[1]}`);
    assert.match(line[1], /\[обрезано: всего \d+ Б\]$/);
    assert.ok(Buffer.byteLength(line[1].split(' [обрезано')[0] ?? '') <= 64);
  } finally {
    await k.unload();
  }
});

test('клик по уведомлению: плагин выключен потоком строк, но ещё не снят, - строка ядра о нём идёт (сторож отбрасывает только строки самого плагина)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { k, ctx, lines, journal, clicks } = await clickRig(() => new Error('команда упала'), { limits: { logRate: 2, logWindowMs: 100, logFloodMs: 300 } }, gate);
  await k.disable('slow');
  const held = k.enable('slow');
  const stop = pour((i) => ctx.bell?.log(`поток ${String(i)}`), 10, 5);
  try {
    await ctx.bell!.os.notify!.show('Сессия ждёт', undefined, { onClick: { command: 'bell.open' } });
    await waitFor('выключение bell', () => switchedOff(journal, 'bell').length === 1, { timeout: 5000 });
    stop();
    // Снятие bell стоит в очереди за активацией slow: плагин выключен, а команда и уведомление ещё живы.
    assert.deepEqual(k.active, ['bell']);
    clicks[0]!.click();
    await waitFor('строка ядра о клике после выключения', () => lines.some(([id, m]) => id === 'bell' && m === 'клик по уведомлению: команда упала'));
  } finally {
    stop();
    release();
    await held;
    await k.unload();
  }
});

test('строки ядра о плагине идут через PluginLog: прямых options.onLog вне plugin-log.ts нет', () => {
  const dir = path.resolve(import.meta.dirname, '..', 'src');
  const direct = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'plugin-log.ts')
    .filter((f) => /\bonLog\?\.\(/.test(readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(direct, []);
});
