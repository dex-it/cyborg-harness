import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PluginContext } from '@cyborg-harness/contracts';
import { memorySecrets } from '../../testing/src/memory.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { Diagnostics, type DiagnosticsFs, type DiagnosticsOptions } from '../src/diagnostics.ts';
import { decodeRecord } from '../src/diagnostics-record.ts';
import { load, type JournalEntry, type Kernel, type LoadOptions } from '../src/loader.ts';
import type { PluginModule } from '../src/plugin.ts';
import { pluginStatuses } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';
import { trackKernels } from './kernels.ts';
import { waitFor } from './wait-for.ts';

// K-30 (FR-CH-4011…4016, NFR-CH-1005, NFR-CH-4002): хранение диагностики - файл с ротацией, прошлый запуск, отказ диска, выгрузка.

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'dx.base': { 1: { work(arg: string): Promise<void> } };
    'dx.ticker': { 1: { onTick(listener: (n: number) => void): { dispose(): void } } };
  }
}

const track = trackKernels();
const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

/** Файловая система в памяти: отказ записи включается полем `failing`. */
class MemoryFs implements DiagnosticsFs {
  readonly files = new Map<string, string>();
  failing: { code: string } | undefined;
  appends = 0;
  list = () => [...this.files.keys()];
  read = (name: string) => {
    const text = this.files.get(name);
    if (text === undefined) throw Object.assign(new Error(`нет ${name}`), { code: 'ENOENT' });
    return text;
  };
  append = (name: string, text: string) => {
    if (this.failing) throw Object.assign(new Error(`${this.failing.code}: /Users/секретное-имя/Library/diagnostics.log`), this.failing);
    this.appends++;
    this.files.set(name, (this.files.get(name) ?? '') + text);
  };
  size = (name: string) => Buffer.byteLength(this.files.get(name) ?? '');
  rename = (from: string, to: string) => {
    this.files.set(to, this.read(from));
    this.files.delete(from);
  };
  remove = (name: string) => void this.files.delete(name);
  /** Строки файла, разобранные так же, как при чтении запуска. */
  records(name: string) {
    return this.read(name)
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => decodeRecord(l)!.record);
  }
}

let clock = Date.now();
const diag = (fsys: DiagnosticsFs, options: Partial<DiagnosticsOptions> = {}) => new Diagnostics({ fs: fsys, now: () => ++clock, flushMs: 60_000, urgentGapMs: 0, ...options });
const failed = (pluginId: string, error = 'нет диска'): JournalEntry => ({ pluginId, kind: 'failed', hostId: 'h', error });
const names = (fsys: MemoryFs) => [...fsys.files.keys()].sort();

test('запись: ошибка и жизненный цикл уходят в файл сразу, обычная запись - пакетом вне вызова (FR-CH-4012, вопрос 2 SRS)', async () => {
  const fsys = new MemoryFs();
  const d = diag(fsys, { flushMs: 40 });
  assert.deepEqual(fsys.records('diagnostics.log').map((r) => r.src), ['run'], 'начало запуска записано');
  d.sinks.onLog('p', 'обычная строка', 'info');
  d.sinks.onTrace({ kind: 'stream', stream: 'pty-output', pluginId: 'p', at: 5, intervalMs: 1000, messages: 3, bytes: 30 });
  assert.equal(fsys.records('diagnostics.log').length, 1, 'обычные записи ждут пакета: вызов диск не трогает');
  d.sinks.onLog('p', 'строка с ошибкой', 'error');
  assert.deepEqual(
    fsys.records('diagnostics.log').map((r) => r.src),
    ['run', 'log', 'trace', 'log'],
    'ошибка сбросила накопленное и записана сразу, порядок сохранён',
  );
  d.sinks.onJournal(failed('p'));
  assert.equal(fsys.records('diagnostics.log').at(-1)?.src, 'journal', 'жизненный цикл - сразу');
  d.sinks.onJournal({ pluginId: 'p', kind: 'denied', method: 'fs.readText', detail: 'путь' });
  d.sinks.onLog('p', 'тихая строка', 'info');
  const before = fsys.records('diagnostics.log').length;
  await waitFor('пакет ушёл по таймеру', () => fsys.records('diagnostics.log').length === before + 2);
  d.close();
});

test('запись: срочные записи чаще urgentGapMs не превращают каждую ошибку в запись на диск', async () => {
  const fsys = new MemoryFs();
  const d = diag(fsys, { urgentGapMs: 60_000 });
  const first = fsys.appends;
  for (let i = 0; i < 100; i++) d.sinks.onLog('p', `ошибка ${String(i)}`, 'error');
  assert.equal(fsys.appends - first, 0, 'после только что сделанной записи ошибки ждут срока, а не пишут по одной');
  d.flush();
  assert.equal(fsys.appends - first, 1, 'одна запись на пакет');
  assert.equal(fsys.records('diagnostics.log').filter((r) => r.src === 'log').length, 100);
});

test('ротация: файлов не больше предела, каждый не больше предельного размера, оба читаются, самые новые записи на месте (FR-CH-4012)', () => {
  const fsys = new MemoryFs();
  const start = clock;
  const d = diag(fsys, { fileBytes: 2000, files: 3 });
  for (let i = 0; i < 300; i++) d.sinks.onLog('p', `строка номер ${String(i)} ${'x'.repeat(40)}`, 'error');
  d.close();
  assert.deepEqual(names(fsys), ['diagnostics.1.log', 'diagnostics.2.log', 'diagnostics.log']);
  for (const name of names(fsys)) assert.ok(fsys.size(name) <= 2000, `${name}: ${String(fsys.size(name))} Б`);
  assert.ok(names(fsys).reduce((n, name) => n + fsys.size(name), 0) <= 3 * 2000, 'всего на диске не больше files * fileBytes');
  const texts = names(fsys).flatMap((name) => fsys.records(name).flatMap((r) => (r.src === 'log' ? [r.text] : [])));
  assert.ok(texts.some((t) => t.startsWith('строка номер 299 ')), 'самая новая запись есть');
  assert.ok(!texts.some((t) => t.startsWith('строка номер 0 ')), 'самая старая ушла при ротации');
  assert.ok(texts.length > 20, `записей сохранилось ${String(texts.length)}`);
  const info = d.stored();
  assert.deepEqual([info.files, info.bytes], [3, names(fsys).reduce((n, name) => n + fsys.size(name), 0)]);
  assert.ok(info.since !== undefined && info.since > start + 50, 'время самой ранней записи сдвинулось вперёд вместе с ротацией, но не пропало');
});

test('ротация: один файл - при заполнении он начинается заново; запись длиннее предела заменяется меткой и предел размера держится', () => {
  const fsys = new MemoryFs();
  const d = diag(fsys, { fileBytes: 1500, files: 1 });
  for (let i = 0; i < 60; i++) d.sinks.onLog('p', `строка ${String(i)} ${'y'.repeat(60)}`, 'error');
  d.sinks.onLog('p', 'z'.repeat(5000), 'error');
  d.close();
  assert.deepEqual(names(fsys), ['diagnostics.log']);
  assert.ok(fsys.size('diagnostics.log') <= 1500);
  const marks = fsys.records('diagnostics.log').filter((r) => r.src === 'oversize');
  assert.equal(marks.length, 1, 'запись, не влезшая в предел файла, заменена меткой с размером');
  assert.ok(!fsys.read('diagnostics.log').includes('zzzzzzzzzz'));
});

test('ротация: один пакет больше предела делится на файлы, предел размера держится и на нём', () => {
  const fsys = new MemoryFs();
  const d = diag(fsys, { fileBytes: 3000, files: 4, flushMs: 60_000 });
  for (let i = 0; i < 200; i++) d.sinks.onLog('p', `обычная ${String(i)} ${'w'.repeat(50)}`, 'info');
  d.flush();
  for (const name of names(fsys)) assert.ok(fsys.size(name) <= 3000, `${name}: ${String(fsys.size(name))} Б`);
  assert.ok(names(fsys).length <= 4);
});

test('отказ диска: запись не бросает, кольцо остаётся, в нём одна запись об отказе, onProblem сказан один раз; диск вернулся - записи ушли (вопрос 3 SRS)', () => {
  const fsys = new MemoryFs();
  const problems: string[] = [];
  const d = diag(fsys, { onProblem: (t) => problems.push(t) });
  fsys.failing = { code: 'ENOSPC' };
  for (let i = 0; i < 10; i++) {
    assert.doesNotThrow(() => {
      d.sinks.onLog('p', `ошибка ${String(i)}`, 'error');
      d.sinks.onJournal(failed('p'));
      d.flush();
    });
  }
  const own = d.recent().filter((r) => r.src === 'log' && r.pluginId === 'диагностика');
  assert.equal(own.length, 1, 'одна запись об отказе, а не по записи на попытку');
  assert.equal(own[0]?.src === 'log' && own[0].text.includes('ENOSPC'), true);
  assert.ok(!JSON.stringify(own).includes('секретное-имя'), 'путь из сообщения файловой системы в запись не идёт');
  assert.equal(problems.length, 1);
  assert.equal(d.stored().problem, 'ENOSPC');
  assert.equal(d.recent().filter((r) => r.src === 'log' && r.pluginId === 'p').length, 10, 'кольцо держит записи');

  fsys.failing = undefined;
  d.flush();
  assert.equal(d.stored().problem, undefined);
  const saved = fsys.records('diagnostics.log');
  assert.equal(saved.filter((r) => r.src === 'log' && r.pluginId === 'p').length, 10, 'не записанное из-за отказа ушло, когда диск вернулся');
  assert.ok(saved.some((r) => r.src === 'log' && r.pluginId === 'диагностика'));

  fsys.failing = { code: 'EACCES' };
  d.sinks.onLog('p', 'ещё ошибка', 'error');
  assert.equal(d.recent().filter((r) => r.src === 'log' && r.pluginId === 'диагностика').length, 2, 'новый отказ после удачной записи - снова одна запись');
});

test('отказ диска: файл не прочитан при старте - ядро запускается, причина названа один раз', () => {
  const fsys = new MemoryFs();
  fsys.files.set('diagnostics.log', 'x');
  fsys.read = () => {
    throw Object.assign(new Error('EIO: /Users/кто-то/diagnostics.log'), { code: 'EIO' });
  };
  const problems: string[] = [];
  const d = diag(fsys, { onProblem: (t) => problems.push(t) });
  assert.equal(d.previousFailures().size, 0);
  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /не прочитаны \(EIO\)/);
});

/** Ядро с хостами в процессе теста; `fail` - плагины, чья активация бросает. */
async function boot(d: Diagnostics, table: Record<string, PluginModule>, manifests: unknown[], options: Partial<LoadOptions> = {}): Promise<Kernel> {
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: manifests.map((m) => (m as { id: string }).id),
    manifests,
    spawnHost: inlineHosts((entry) => Promise.resolve(table[entry] ?? { activate() {} })),
    ...d.sinks,
    ...options,
  });
  return track(k);
}

test('отказ диска не отказывает операцию: команда, контракт и вызов ctx.os отвечают как без диагностики, запись об отказе одна (критерий приёмки)', async () => {
  const fsys = new MemoryFs();
  fsys.failing = { code: 'EROFS' };
  const d = diag(fsys);
  const k = await boot(d, { echo: { activate: (ctx) => void ctx.commands.register('echo.say', (text) => `эхо ${String(text)}`) } }, [manifest('echo', { commands: { 'echo.say': { args: ['any'] } } })]);
  for (let i = 0; i < 20; i++) assert.equal(await k.run('echo.say', String(i)), `эхо ${String(i)}`);
  assert.deepEqual(k.active, ['echo']);
  const traced = d.recent().filter((r) => r.src === 'trace');
  assert.ok(traced.length >= 20, 'трасса осталась в кольце');
  assert.equal(d.recent().filter((r) => r.src === 'log' && r.pluginId === 'диагностика').length, 1);
  await k.unload();
  d.close();
});

test('прошлый запуск: причина сбоя читается из файла на том же каталоге, состояние плагина в новом запуске выводится только из его журнала (FR-CH-4013, 4014)', async () => {
  const fsys = new MemoryFs();
  const first = diag(fsys);
  first.sinks.onJournal({ pluginId: 'flaky', kind: 'activated', hostId: 'h', ms: 3 });
  first.sinks.onJournal({ pluginId: undefined, kind: 'host-down', hostId: 'h', reason: 'crash', culprits: ['flaky'], plugins: ['flaky', 'mate'], affects: [] });
  first.sinks.onJournal({ pluginId: 'flaky', kind: 'switched-off', strikes: 3, affects: [] });
  first.sinks.onJournal(failed('other', 'нет диска'));
  first.close();

  const second = diag(fsys);
  const prev = second.previousFailures();
  assert.deepEqual([...prev.keys()].sort(), ['flaky', 'mate', 'other']);
  assert.match(prev.get('flaky')?.text ?? '', /выключен, сбоев подряд: 3/, 'последний сбой плагина - не первый');
  assert.match(prev.get('mate')?.text ?? '', /хост h упал/);
  assert.match(prev.get('other')?.text ?? '', /не поднялся в хосте h: нет диска/);
  assert.ok(second.stored().previousRunAt !== undefined);

  // Тот же плагин в этом запуске поднимается: прошлая запись `switched-off` состояния не меняет.
  const k = await boot(second, { flaky: { activate() {} } }, [manifest('flaky')]);
  assert.deepEqual(
    pluginStatuses(k.journal).map((s) => [s.id, s.state]),
    [['flaky', 'active']],
  );
  assert.ok(!k.journal.some((e) => e.kind === 'switched-off' || e.kind === 'host-down'), 'в журнале ядра записей прошлого запуска нет');
  assert.equal(second.previousFailures().get('flaky')?.pluginId, 'flaky', 'причина прошлого сбоя при этом остаётся видимой');
});

test('прошлый запуск: прошлым считается последний запуск, чистый запуск после сбоя причину не оставляет', () => {
  const fsys = new MemoryFs();
  const a = diag(fsys);
  a.sinks.onJournal(failed('p'));
  a.close();
  const b = diag(fsys);
  assert.equal(b.previousFailures().get('p')?.text, 'не поднялся в хосте h: нет диска');
  b.sinks.onLog('p', 'всё хорошо', 'info');
  b.close();
  const c = diag(fsys);
  assert.equal(c.previousFailures().size, 0, 'сбой был два запуска назад - прошлый запуск был чистым');
  assert.ok(c.export({}).includes('нет диска'), 'но в выгрузке он есть: хранятся все файлы');
});

test('прошлый запуск: оборванная и правленая строка файла пропускается, остальное читается; запись с неожиданной формой выгрузку не ломает', () => {
  const fsys = new MemoryFs();
  const a = diag(fsys);
  a.sinks.onJournal(failed('p'));
  a.close();
  const good = fsys.read('diagnostics.log');
  const bad = [
    '{"r":1,"src":"journal","at":2,"entry":{"kind":"failed","pluginId":"x"}}',
    '{"r":1,"src":"journal","at":2,"entry":{"kind":"host-down"}}',
    '{оборвана',
    '{"r":"1","src":"log"}',
    '[]',
    '',
  ].join('\n');
  fsys.files.set('diagnostics.log', `${good}${bad}\n`);
  const b = diag(fsys);
  assert.equal(b.previousFailures().get('p')?.text, 'не поднялся в хосте h: нет диска');
  const text = b.export({});
  assert.match(text, /запись нечитаема/);
  assert.match(text, /Не разобрано строк или файлов: 3\./);
});

test('NFR-CH-1005: запись каждого вида из первого запуска найдена во втором на том же каталоге при штатном закрытии', async () => {
  const fsys = new MemoryFs();
  const first = diag(fsys);
  const entries: JournalEntry[] = [
    failed('a'),
    { pluginId: 'b', kind: 'switched-off', strikes: 3, affects: [] },
    { pluginId: undefined, kind: 'host-down', hostId: 'hh', reason: 'crash', culprits: ['c'], plugins: ['c'], affects: [] },
  ];
  for (const e of entries) first.sinks.onJournal(e);
  first.sinks.onLog('a', 'строка с ошибкой', 'error');
  first.close();
  const text = diag(fsys).export({});
  for (const needle of ['не поднялся в хосте h: нет диска', 'выключен, сбоев подряд: 3', 'хост hh упал, виновник: c', 'строка error a: строка с ошибкой']) assert.ok(text.includes(needle), needle);
});

test('NFR-CH-1005: записи с ошибкой и жизненного цикла в файле и тогда, когда приложение убито без закрытия', () => {
  const fsys = new MemoryFs();
  const d = diag(fsys);
  d.sinks.onLog('p', 'обычная строка до сбоя', 'info');
  d.sinks.onJournal(failed('p'));
  const afterKill = new Diagnostics({ fs: fsys, now: () => 9e12 });
  assert.match(afterKill.previousFailures().get('p')?.text ?? '', /нет диска/);
  const kept = fsys.records('diagnostics.log').flatMap((r) => (r.src === 'log' ? [r.text] : []));
  assert.deepEqual(kept, ['обычная строка до сбоя'], 'сброс ошибки унёс и накопленное перед ней; хвост после неё потерян - это вопрос 2');
});

test('предел числа файлов уменьшили между запусками: лишние старые файлы убираются при старте', () => {
  const fsys = new MemoryFs();
  for (const name of ['diagnostics.log', 'diagnostics.1.log', 'diagnostics.2.log', 'diagnostics.3.log', 'другой.txt']) fsys.files.set(name, '');
  diag(fsys, { files: 2 });
  assert.deepEqual(names(fsys), ['diagnostics.1.log', 'diagnostics.log', 'другой.txt']);
});

/** Выгрузка из настоящего ядра: цепочка с ошибкой, секрет, маркер аргумента, граф. */
async function scenario(options: { diagnostics?: Partial<DiagnosticsOptions> } = {}) {
  const fsys = new MemoryFs();
  const d = diag(fsys, options.diagnostics);
  const marker = `МАРКЕР-${randomUUID()}`;
  const secret = `s3cr3t-${randomUUID()}`;
  const secrets = memorySecrets();
  let ctx: PluginContext | undefined;
  const table: Record<string, PluginModule> = {
    base: {
      activate(c) {
        c.contracts.provide('dx.base', '1.0', { work: () => Promise.reject(new Error(`отказ поставщика ${marker}`)) });
        c.commands.register('base.go', () => 'ok');
      },
    },
    top: {
      activate(c) {
        ctx = c;
        c.commands.register('top.run', () => c.contracts.get('dx.base', 1)?.work(marker));
      },
    },
    broken: {
      activate() {
        throw new Error('нет ключа');
      },
    },
  };
  const k = await boot(
    d,
    table,
    [
      manifest('base', { version: '2.3.4', provides: { 'dx.base': '1.0' }, commands: ['base.go'] }),
      manifest('top', { version: '0.9.1', requires: { 'dx.base': '^1' }, commands: ['top.run'], permissions: { 'secrets.ref': ['vault://x/*'] } }),
      manifest('broken', { version: '1.4.0' }),
    ],
    { os: { dataDir: '/nonexistent/d', tempDir: '/nonexistent/t', secrets }, hosts: { a: ['base'], b: ['top'] } },
  );
  return { fsys, d, k, marker, secret, ctx: ctx!, secrets };
}

test('выгрузка: один текстовый файл с записью об ошибке и её цепочкой, версиями ядра и плагинов, состоянием и графом, самой ранней записью (FR-CH-4015)', async () => {
  const { d, k } = await scenario();
  await assert.rejects(k.run('top.run'), { code: 'Remote' });
  const text = d.export({ app: 'Тест 1.2.3', core: '0.1.0', kernel: k });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Диагностика Cyborg Harness');
  assert.ok(text.includes('Приложение: Тест 1.2.3'));
  assert.ok(text.includes(`Ядро: пакет 0.1.0, API плагинов ${PLUGIN_API_VERSION}`));
  assert.match(text, /\n {2}base 2\.3\.4 - работает, хост a\n/);
  assert.match(text, /\n {2}top 0\.9\.1 - работает, хост b\n/);
  assert.match(text, /\n {2}broken 1\.4\.0 - выключен, хост \w+: не поднялся в хосте \w+: нет ключа\n/);
  assert.match(text, /порядок активации: .*base.*top|порядок активации: .*top/);
  assert.match(text, /top <- dx\.base: base/);
  const errorLine = lines.find((l) => l.includes('отказ Remote'));
  assert.ok(errorLine, 'запись трассы с ошибкой');
  const chain = /цепочка (\d+):/.exec(errorLine)?.[1];
  assert.ok(chain);
  const inChain = lines.filter((l) => l.includes(`цепочка ${chain}:`));
  assert.ok(inChain.length >= 2, `в цепочке ${chain} операций: ${String(inChain.length)}`);
  assert.ok(inChain.some((l) => l.includes('user -> command:top.run')), 'цепочку видно от первой операции');
  assert.match(text, /Записей: \d+; самая ранняя: \d{4}-\d\d-\d\dT/);
  assert.ok(text.includes('не поднялся в хосте'), 'запись журнала о сбое активации');
  // Записи идут в порядке времени.
  const times = lines.filter((l) => /^\d{4}-\d\d-\d\dT/.test(l)).map((l) => l.slice(0, 24));
  assert.deepEqual(times, [...times].sort());
  await k.unload();
});

test('выгрузка: маркера аргумента, значения секрета и текста исключения поставщика нет ни в файле хранилища, ни в выгрузке (FR-CH-4004, NFR-CH-4002)', async () => {
  const { fsys, d, k, marker, secret, ctx, secrets } = await scenario();
  await ctx.os.secrets.set('token', secret);
  assert.equal(await ctx.os.secrets.get('token'), secret);
  await assert.rejects(k.run('top.run'), { code: 'Remote' });
  ctx.log(`токен ${secret} в строке плагина`, 'error');
  await waitFor('строка с секретом дошла до хранилища', () => d.recent().some((r) => r.src === 'log' && r.text.includes('[секрет]')));
  assert.equal(await secrets.get('top/token'), secret, 'секрет в хранилище остался (проверка стенда)');
  d.flush();
  const files = [...fsys.files.values()].join('\n');
  const text = d.export({ kernel: k });
  for (const [where, haystack] of [['файл', files], ['выгрузка', text]] as const) {
    assert.ok(!haystack.includes(marker), `${where}: маркер аргумента`);
    assert.ok(!haystack.includes(secret), `${where}: значение секрета`);
  }
  assert.ok(text.includes('токен [секрет] в строке плагина'), 'вычеркнутая ядром строка плагина в выгрузке есть');
  await k.unload();
});

test('выгрузка: не записанное из-за отказа диска входит в выгрузку, а про отказ сказано в заголовке (FR-CH-4015, вопрос 3)', async () => {
  const { fsys, d, k } = await scenario();
  fsys.failing = { code: 'ENOSPC' };
  await assert.rejects(k.run('top.run'), { code: 'Remote' });
  d.flush();
  const text = d.export({ kernel: k });
  assert.match(text, /Не записано в файл: \d+ \(запись на диск не удаётся: ENOSPC\)/);
  assert.ok(text.includes('отказ Remote'), 'операция с ошибкой в выгрузке, хотя в файл не попала');
  await k.unload();
});

test('выгрузка: сеть не нужна и не трогается - при заблокированных fetch и net выгрузка даёт текст (FR-CH-4016)', async (t) => {
  const { d, k } = await scenario();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('сеть закрыта');
  };
  t.after(() => void (globalThis.fetch = realFetch));
  const text = d.export({ kernel: k });
  assert.ok(text.startsWith('Диагностика Cyborg Harness'));
  assert.ok(text.includes('никуда не отправляет'));
  await k.unload();
});

test('выгрузка: модули хранения и выгрузки не импортируют сеть и не вызывают fetch (FR-CH-4016, осмотр)', () => {
  const src = path.resolve(import.meta.dirname, '..', 'src');
  for (const file of ['diagnostics.ts', 'diagnostics-export.ts', 'diagnostics-record.ts', 'diagnostics-ring.ts']) {
    const code = fs.readFileSync(path.join(src, file), 'utf8');
    assert.ok(!/from 'node:(?:net|http|https|http2|dns|tls|dgram|child_process|fs)/.test(code), `${file}: сетевой или файловый модуль Node`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(code), `${file}: сетевой вызов`);
  }
});

test('кольцо в ядре: шумный плагин выводит в журнал тысячи строк и операций, а запись о сбое соседа и его строка с ошибкой остаются (У-49, критерий приёмки)', () => {
  const fsys = new MemoryFs();
  const d = diag(fsys, { capacity: 500, perPlugin: 100 });
  d.sinks.onLog('quiet', 'ошибка соседа', 'error');
  d.sinks.onJournal(failed('quiet', 'сосед упал'));
  d.sinks.onTrace({ kind: 'operation', id: 1, chain: 1, at: 1, caller: 'plugin:quiet', target: 'os:fs.readText', boundaries: ['host', 'os'], durationMs: 1, argsBytes: 1, resultBytes: 0, outcome: 'error', code: 'PermissionDenied', reason: 'permission denied' });
  for (let i = 0; i < 20_000; i++) {
    d.sinks.onLog('noisy', `строка ${String(i)}`, 'info');
    d.sinks.onTrace({ kind: 'operation', id: i + 10, chain: i + 10, at: 10 + i, caller: 'plugin:noisy', target: 'contract:x@1#event', boundaries: ['host', 'contract'], durationMs: 0, argsBytes: 0, resultBytes: 0, outcome: 'ok' });
  }
  const ring = d.recent();
  assert.ok(ring.length <= 500);
  assert.ok(ring.some((r) => r.src === 'journal' && r.entry.pluginId === 'quiet'), 'запись о сбое соседа');
  assert.ok(ring.some((r) => r.src === 'log' && r.pluginId === 'quiet' && r.text === 'ошибка соседа'), 'строка соседа с ошибкой');
  assert.ok(ring.some((r) => r.src === 'trace' && r.record.kind === 'operation' && r.record.outcome === 'error'), 'операция соседа с ошибкой');
  const noisy = ring.filter((r) => (r.src === 'log' && r.pluginId === 'noisy') || (r.src === 'trace' && r.record.kind === 'operation' && r.record.caller === 'plugin:noisy'));
  assert.ok(noisy.length <= 100, `шумный плагин держит не больше своего предела: ${String(noisy.length)}`);
  d.close();
});

test('кольцо: шумный поставщик событий контракта (остаток K-28) держит в кольце не больше своего предела, запись о сбое соседа остаётся', async () => {
  const d = diag(new MemoryFs(), { capacity: 600, perPlugin: 120 });
  let fire: (n: number) => void = () => undefined;
  const table: Record<string, PluginModule> = {
    ticker: {
      activate(c) {
        const listeners = new Set<(n: number) => void>();
        fire = (n) => listeners.forEach((l) => l(n));
        c.contracts.provide('dx.ticker', '1.0', {
          onTick(listener: (n: number) => void) {
            listeners.add(listener);
            return { dispose: () => void listeners.delete(listener) };
          },
        });
      },
    },
    user: { activate: (c) => void c.contracts.get('dx.ticker', 1)?.onTick(() => undefined) },
  };
  const k = await boot(d, table, [manifest('ticker', { provides: { 'dx.ticker': '1.0' } }), manifest('user', { optional: { 'dx.ticker': '^1' } })], { hosts: { t: ['ticker'], u: ['user'] } });
  d.sinks.onJournal(failed('quiet', 'сосед упал'));
  await waitFor('подписка потребителя дошла до поставщика', () => d.recent().some((r) => r.src === 'trace' && r.record.kind === 'operation' && r.record.target.includes('onTick')));
  for (let i = 0; i < 3000; i++) fire(i);
  await waitFor('события дошли до трассы', () => d.recent().filter((r) => r.src === 'trace').length >= 100);
  const ring = d.recent();
  const events = ring.filter((r) => r.src === 'trace' && r.record.kind === 'operation' && r.record.caller === 'plugin:ticker');
  assert.ok(events.length > 0 && events.length <= 120, `записей событий в кольце: ${String(events.length)}`);
  assert.ok(ring.some((r) => r.src === 'journal' && r.entry.pluginId === 'quiet'), 'запись о сбое соседа в кольце');
  assert.ok(ring.length <= 600);
  await k.unload();
});
