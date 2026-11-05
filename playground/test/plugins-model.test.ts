import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PluginJournalLine, PluginRow, PluginsSnapshot } from '../src/shared/plugins.ts';
import { actionsFor, conflictText, journalFor, keyStatus, mergeFeed, sortedPlugins, summary } from '../src/renderer/plugins-model.ts';

const row = (id: string, state: PluginRow['state'], over: Partial<PluginRow> = {}): PluginRow => ({ id, state, revivable: state === 'stopped', unloaded: false, commands: [], permissions: [], ...over });
const snapshot = (plugins: PluginRow[], over: Partial<PluginsSnapshot> = {}): PluginsSnapshot => ({ phase: 'ready', problems: [], plugins, keys: [], feed: [], journal: [], canHang: true, ...over });

describe('окно «Плагины Cyborg»: модель', () => {
  it('выключенные сверху, затем ждущие перезапуска, работающие и невключённые; внутри - по имени', () => {
    const rows = [row('zeta', 'active'), row('off', 'disabled'), row('beta', 'stopped'), row('alpha', 'active'), row('host', 'restarting'), row('aaa', 'stopped')];
    assert.deepEqual(
      sortedPlugins(rows).map((r) => r.id),
      ['aaa', 'beta', 'host', 'alpha', 'zeta', 'off'],
    );
  });

  it('журнал плагина - его записи и записи хоста, где он назван', () => {
    const line = (subject: string, plugins: string[]): PluginJournalLine => ({ at: 0, subject, plugins, text: subject, level: 'info' });
    const lines = [line('echo', ['echo']), line('хост a', ['echo', 'probe']), line('probe', ['probe'])];
    assert.deepEqual(
      journalFor(lines, 'echo').map((l) => l.subject),
      ['echo', 'хост a'],
    );
    assert.equal(journalFor(lines, null).length, 3);
  });

  it('сводка: запуск, отказ ядра, пусто, счёт по состояниям без невключённых', () => {
    assert.equal(summary(snapshot([], { phase: 'starting' })), 'Ядро плагинов запускается…');
    assert.equal(summary(snapshot([], { phase: 'failed', error: 'нет хоста' })), 'Ядро плагинов не запустилось: нет хоста');
    assert.match(summary(snapshot([row('off', 'disabled')])), /^Включённых плагинов нет/);
    assert.equal(
      summary(snapshot([row('a', 'active'), row('b', 'stopped'), row('c', 'restarting'), row('d', 'disabled')])),
      'работает: 1 из 3, ждут перезапуска: 1, выключено: 1',
    );
  });

  it('кнопки: у работающего - команды, выгрузка и хост; у выгруженного - «Загрузить», у упавшего - «Включить снова»', () => {
    const labels = (r: PluginRow, canHang = true) => actionsFor(r, canHang).map((a) => a.label);
    assert.deepEqual(labels(row('bob', 'active', { commands: ['bob.hello'], pid: 7 })), ['bob.hello', 'Выгрузить', 'Уронить хост', 'Повесить хост', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'active', { pid: 7 }), false), ['Выгрузить', 'Уронить хост', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'active')), ['Выгрузить', 'Журнал'], 'без процесса хоста ронять нечего');
    assert.deepEqual(labels(row('bob', 'stopped', { unloaded: true })), ['Загрузить', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'stopped')), ['Включить снова', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'stopped', { revivable: false })), ['Журнал']);
    assert.deepEqual(labels(row('bob', 'restarting')), ['Журнал']);
  });

  it('клавиши: перехват у работающего владельца, конфликт называет проигравших, лента - по времени', () => {
    const key = { key: 'F2', command: 'bob.status', pluginId: 'bob', live: true, shadowed: [{ pluginId: 'echo', command: 'echo.ping' }] };
    assert.equal(keyStatus(key), 'перехват');
    assert.equal(keyStatus({ ...key, live: false }), 'bob не работает - нажатие уйдёт в окно');
    assert.equal(conflictText(key), 'конфликт: echo.ping (echo) не получает сочетание');
    assert.equal(conflictText({ ...key, shadowed: [] }), undefined);
    const line = (at: number, subject: string) => ({ at, kind: 'log' as const, subject, text: '' });
    assert.deepEqual(
      mergeFeed([line(1, 'a'), line(3, 'c')], [line(2, 'b')]).map((l) => l.subject),
      ['a', 'b', 'c'],
    );
  });
});
