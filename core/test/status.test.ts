import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JournalEntry } from '../src/loader.ts';
import { describeEntry, entryLevel, entryPlugins, isLifecycleEntry, pluginStatuses } from '../src/status.ts';

const view = (journal: JournalEntry[]) => pluginStatuses(journal).map((s) => `${s.id}:${s.state}:${s.cause?.kind}:${s.revivable ? 'R' : '-'}`);

test('состояние по журналу: работает, перезапуск хоста, выключен сторожем, брошенный хост, не включён', () => {
  const journal: JournalEntry[] = [
    { pluginId: 'old', kind: 'disabled' },
    { pluginId: 'bad', kind: 'rejected', reasons: [{ kind: 'missing', contract: 'x', range: '^1' }] },
    { pluginId: 'a', kind: 'activated', hostId: 'h', ms: 3 },
    { pluginId: 'b', kind: 'activated', hostId: 'h', ms: 3 },
    { pluginId: 'c', kind: 'activated', hostId: 'g', ms: 3 },
    { kind: 'host-down', hostId: 'h', reason: 'hang', culprits: ['a'], plugins: ['a', 'b'], affects: ['c'] },
    { pluginId: 'a', kind: 'switched-off', strikes: 3, affects: ['c'] },
    { kind: 'host-restart', hostId: 'h', plugins: ['b'] },
  ];
  assert.deepEqual(view(journal), ['old:disabled:disabled:-', 'bad:stopped:rejected:-', 'a:stopped:switched-off:R', 'b:restarting:host-down:-', 'c:active:activated:-']);

  journal.push({ pluginId: 'b', kind: 'activated', hostId: 'h', ms: 4 }, { kind: 'host-down', hostId: 'g', reason: 'crash', culprits: [], plugins: ['c'], affects: [] });
  journal.push({ kind: 'host-abandoned', hostId: 'g', failures: 3, plugins: ['c'] });
  assert.deepEqual(view(journal).slice(2), ['a:stopped:switched-off:R', 'b:active:activated:-', 'c:stopped:host-abandoned:R']);

  journal.push({ pluginId: 'a', kind: 'revived' });
  assert.equal(view(journal)[2], 'a:restarting:revived:-');
});

test('запись журнала словами и уровень', () => {
  const down: JournalEntry = { kind: 'host-down', hostId: 'ui', reason: 'crash', culprits: ['echo'], plugins: ['echo'], affects: ['probe'] };
  assert.equal(describeEntry(down), 'хост ui упал, виновник: echo; сняты: echo; задеты: probe');
  assert.equal(entryLevel(down), 'warn');
  const off: JournalEntry = { pluginId: 'echo', kind: 'switched-off', strikes: 2, affects: [] };
  assert.equal(describeEntry(off), 'выключен, сбоев подряд: 2');
  assert.equal(entryLevel(off), 'error');
  assert.equal(describeEntry({ pluginId: 'x', kind: 'rejected', reasons: [{ kind: 'cycle', members: ['x', 'y', 'x'] }] }), 'цикл зависимостей: x → y → x');
  const expired: JournalEntry = { pluginId: 'agent', kind: 'pty-expired', id: 'pty-2', program: 'claude', graceMs: 60_000 };
  assert.equal(describeEntry(expired), 'терминал pty-2 (claude) завершён: плагин не подхватил его за 60 с');
  assert.equal(entryLevel(expired), 'warn');
  assert.deepEqual(pluginStatuses([{ pluginId: 'agent', kind: 'activated', hostId: 'h', ms: 1 }, expired]).map((s) => s.state), ['active']);
  assert.equal(
    describeEntry({ pluginId: 'rogue', kind: 'rejected', reasons: [{ kind: 'reserved', what: 'provides', name: 'cyborg.agent', prefix: 'cyborg.' }] }),
    'отдаёт cyborg.agent, а контракты пространства cyborg.* отдают только встроенные плагины',
  );
  assert.equal(
    describeEntry({ pluginId: 'cyborg.x', kind: 'rejected', reasons: [{ kind: 'reserved', what: 'id', name: 'cyborg.x', prefix: 'cyborg.' }] }),
    'id cyborg.x из пространства cyborg.* - только у встроенных плагинов',
  );
});

test('вызов устаревшего члена: словами с вызывающим, поставщиком и повторами, уровень warn, состояние плагинов не меняет, виден обоим', () => {
  const call: JournalEntry = { pluginId: 'tabs', kind: 'deprecated-call', provider: 'sessions', contract: 'cyborg.sessions', member: 'list' };
  assert.equal(describeEntry(call), 'tabs вызывает устаревший cyborg.sessions.list поставщика sessions');
  assert.equal(describeEntry({ ...call, repeats: 41 }), 'tabs вызывает устаревший cyborg.sessions.list поставщика sessions - ещё 41 раз за 5 с');
  assert.equal(entryLevel(call), 'warn');
  assert.deepEqual(entryPlugins(call), ['tabs', 'sessions']);
  const journal: JournalEntry[] = [
    { pluginId: 'tabs', kind: 'activated', hostId: 'h', ms: 1 },
    { pluginId: 'sessions', kind: 'activated', hostId: 'h', ms: 1 },
    call,
  ];
  assert.deepEqual(view(journal), ['tabs:active:activated:-', 'sessions:active:activated:-']);
  assert.deepEqual(view([call]), [], 'запись о вызове сама плагин в списке не заводит');
});

test('isLifecycleEntry: записи о работе плагина - да, отказы, вызовы устаревшего, сроки pty и выбор хоста - нет', () => {
  const lifecycle: JournalEntry[] = [
    { pluginId: 'a', kind: 'activated', hostId: 'h', ms: 1 },
    { pluginId: 'a', kind: 'skipped', reason: 'нет поставщика' },
    { pluginId: 'a', kind: 'unloaded', by: 'b' },
    { pluginId: 'a', kind: 'failed', hostId: 'h', error: 'x' },
    { pluginId: 'a', kind: 'revived' },
    { pluginId: 'a', kind: 'switched-off', strikes: 1, affects: [] },
  ];
  const aside: JournalEntry[] = [
    { pluginId: 'a', kind: 'denied', method: 'fs.readText', detail: '/etc/hostname', repeats: 2 },
    { pluginId: 'a', kind: 'deprecated-call', provider: 'b', contract: 'c.d', member: 'm' },
    { pluginId: 'a', kind: 'pty-expired', id: 'pty-1', program: 'sh', graceMs: 1 },
    { pluginId: 'a', kind: 'key-conflict', key: 'mod+k', command: 'a.go', winner: 'b' },
    { pluginId: 'a', kind: 'unhandled-rejection', error: 'x' },
    { pluginId: 'a', kind: 'host-isolated', group: 'g', hostId: 'h' },
    { pluginId: 'a', kind: 'host-own-grouped', group: 'g', neighbours: ['b'] },
    { pluginId: 'a', kind: 'third-party' },
    { kind: 'key-ignored', key: 'mod+x', command: null, reason: 'нет команды' },
    { kind: 'trace-args', limit: 4096 },
  ];
  assert.deepEqual(lifecycle.filter((e) => !isLifecycleEntry(e)), []);
  assert.deepEqual(aside.filter(isLifecycleEntry), []);
  // Состояние по журналу прежнее: запись не жизненного цикла после unloaded не будит плагин и не меняет причину остановки.
  const stopped = pluginStatuses([lifecycle[0]!, lifecycle[2]!, ...aside]);
  assert.deepEqual(stopped.map((s) => [s.id, s.state, s.cause?.kind]), [['a', 'stopped', 'unloaded']]);
});

test('запись trace-args (K-33): предупреждение словами с пределом, плагинов не касается, жизненным циклом не является', () => {
  const entry: JournalEntry = { kind: 'trace-args', limit: 4096 };
  assert.match(describeEntry(entry), /--trace-args.*4096 Б.*секретов вычеркнуты/);
  assert.equal(entryLevel(entry), 'warn');
  assert.deepEqual(entryPlugins(entry), []);
  assert.equal(isLifecycleEntry(entry), false);
});
