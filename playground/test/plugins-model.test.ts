import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PluginJournalLine, PluginRow, PluginsSnapshot } from '../src/shared/plugins.ts';
import { journalFor, sortedPlugins, summary } from '../src/renderer/plugins-model.ts';

const row = (id: string, state: PluginRow['state']): PluginRow => ({ id, state, revivable: state === 'stopped' });
const snapshot = (plugins: PluginRow[], over: Partial<PluginsSnapshot> = {}): PluginsSnapshot => ({ phase: 'ready', problems: [], plugins, journal: [], ...over });

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
});
