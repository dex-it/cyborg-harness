import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { LayoutRow, PluginJournalLine, PluginRow, PluginsSnapshot } from '@cyborg-harness/electron/window';
import { actionsFor, conflictText, diagnosticsLine, exportMessage, groupLabel, groupNote, journalFor, keyStatus, mergeFeed, originNote, previousNote, sortedPlugins, summary, userPluginsNotice, viewMode, viewSlots, workspaceActionError } from '../src/renderer/plugins-model.ts';

const row = (id: string, state: PluginRow['state'], over: Partial<PluginRow> = {}): PluginRow => ({ id, state, revivable: state === 'stopped', unloaded: false, commands: [], permissions: [], ...over });
const snapshot = (plugins: PluginRow[], over: Partial<PluginsSnapshot> = {}): PluginsSnapshot => ({ phase: 'ready', safeMode: false, userPlugins: false, problems: [], plugins, layout: [], keys: [], feed: [], journal: [], canHang: true, window: { title: '', queued: 0, locks: [] }, documents: [], workspace: { current: '/w.cyborg.json', recent: [] }, ...over });

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
      summary(snapshot([row('a', 'active'), row('b', 'stopped'), row('c', 'restarting'), row('d', 'disabled'), row('e', 'waiting')])),
      'работает: 1 из 4, ждут вызова: 1, ждут перезапуска: 1, выключено: 1',
    );
    assert.equal(summary(snapshot([row('a', 'stopped'), row('b', 'stopped'), row('d', 'disabled')], { safeMode: true })), 'Безопасный режим: включённых плагинов 2, их код не запускается.');
  });

  it('ST-2003/5: кнопки: у работающего - команды, выгрузка и хост; у выгруженного - «Загрузить», у упавшего - «Включить снова»', () => {
    const labels = (r: PluginRow, canHang = true) => actionsFor(r, canHang).map((a) => a.label);
    assert.deepEqual(labels(row('bob', 'active', { commands: ['bob.hello'], pid: 7 })), ['bob.hello', 'Выгрузить', 'Уронить хост', 'Повесить хост', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'active', { pid: 7 }), false), ['Выгрузить', 'Уронить хост', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'active')), ['Выгрузить', 'Журнал'], 'без процесса хоста ронять нечего');
    assert.deepEqual(labels(row('bob', 'stopped', { unloaded: true })), ['Загрузить', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'stopped')), ['Включить снова', 'Журнал']);
    assert.deepEqual(labels(row('bob', 'stopped', { revivable: false })), ['Журнал']);
    assert.deepEqual(labels(row('bob', 'restarting')), ['Журнал']);
    assert.deepEqual(labels(row('later', 'waiting', { commands: ['later.hello'] })), ['later.hello', 'Выгрузить', 'Журнал']);
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

  it('ST-1001/7: происхождение: сторонний помечен словами с предупреждением, встроенный и не найденный - нет; плашка каталога пользователя только с флагом', () => {
    assert.match(originNote(row('notes', 'active', { origin: 'user' })) ?? '', /^сторонний плагин из каталога пользователя: код не проверен/);
    assert.equal(originNote(row('files', 'active', { origin: 'bundled' })), undefined);
    assert.equal(originNote(row('ghost', 'disabled')), undefined);
    assert.equal(userPluginsNotice(snapshot([], { userPlugins: false })), undefined);
    assert.match(userPluginsNotice(snapshot([], { userPlugins: true })) ?? '', /--user-plugins/);
  });

  it('группа рендера: метка только у плагина в чужой группе, предупреждение - слова записи ядра', () => {
    assert.equal(groupLabel(row('alice', 'active', { group: 'duo' })), 'группа duo');
    assert.equal(groupLabel(row('echo', 'active', { group: 'echo' })), undefined, 'своя группа - не метка');
    assert.equal(groupLabel(row('guest', 'active', { origin: 'user', group: 'solo_guest' })), undefined, 'сторонний один в своей группе - не метка');
    assert.equal(groupLabel(row('logic', 'active')), undefined, 'у плагина без видов группы нет');
    const warning = 'сторонний плагин не делит группу рендера: группа duo не действует, работает в своей guest';
    assert.equal(groupNote(row('guest', 'active', { origin: 'user', group: 'solo_guest', groupWarning: warning })), warning);
    assert.equal(groupNote(row('alice', 'active', { group: 'duo' })), undefined);
  });

  // K-03: области окна строятся из раскладки ядра, а не из имён плагинов.
  const view = (pluginId: string, name: string, over: Partial<LayoutRow> = {}): LayoutRow => ({ pluginId, kind: 'view', name, area: 'sidebar', order: 1000, url: `cyborg-plugin://${pluginId}/${pluginId}/?view=${name}`, ...over });

  it('виды окна: порядок раскладки ядра, оба вида одного плагина, документы и невидимые без адреса не в счёт', () => {
    const plugins = [row('a', 'active'), row('b', 'active'), row('c', 'stopped'), row('d', 'disabled'), row('e', 'restarting')];
    const layout: LayoutRow[] = [
      view('b', 'tree', { area: 'main', order: 100 }),
      view('a', 'one', { order: 200 }),
      view('a', 'two', { area: 'toolbar', order: 200 }),
      { pluginId: 'a', kind: 'document', name: 'note', area: 'main', order: 300 },
      view('d', 'main', { order: 400, url: undefined }),
      view('c', 'main', { order: 500 }),
      view('e', 'main', { order: 600 }),
      view('ghost', 'main', { order: 700 }),
    ];
    const slots = viewSlots(plugins, layout);
    assert.deepEqual(
      slots.map((s) => [s.key, s.entry.area, s.mode]),
      [
        ['b/tree', 'main', 'frame'],
        ['a/one', 'sidebar', 'frame'],
        ['a/two', 'toolbar', 'frame'],
        ['c/main', 'sidebar', 'placeholder'],
        ['e/main', 'sidebar', 'restarting'],
      ],
    );
    assert.equal(viewMode(row('d', 'disabled'), view('d', 'main', { url: undefined })), undefined);
    // Заглушку определяет метка раскладки ядра, а не состояние строки плагина.
    assert.equal(viewMode(row('a', 'active'), view('a', 'main', { mark: 'disabled' })), 'placeholder');
    assert.equal(viewMode(row('a', 'active'), view('a', 'main', { mark: 'out-of-graph' })), 'placeholder');
    assert.equal(viewMode(row('a', 'disabled'), view('a', 'main', { mark: 'not-enabled', url: undefined })), undefined);
  });

  it('в renderer нет строковых имён плагинов: области строятся из раскладки ядра', () => {
    const plugins = path.resolve(import.meta.dirname, '..', 'plugins');
    const ids = fs
      .readdirSync(plugins, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(plugins, d.name, 'manifest.json')))
      .map((d) => (JSON.parse(fs.readFileSync(path.join(plugins, d.name, 'manifest.json'), 'utf8')) as { id: string }).id);
    assert.ok(ids.includes('sessions') && ids.length > 5, 'каталог плагинов не прочитан');
    const renderer = path.resolve(import.meta.dirname, '..', 'src', 'renderer');
    const sources = fs.readdirSync(renderer, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    assert.ok(sources.length > 5, 'исходники окна не найдены');
    const found: string[] = [];
    for (const file of sources) {
      const text = fs.readFileSync(path.join(renderer, file), 'utf8');
      for (const id of ids) if (new RegExp(`(['"\`])${id.replaceAll('-', '\\-')}\\1`).test(text)) found.push(`${file}: '${id}'`);
    }
    assert.deepEqual(found, []);
  });
});

describe('окно «Плагины Cyborg»: действия над воркспейсом', () => {
  it('отказ главного процесса и сбой вызова становятся текстом для окна, успех и отмена диалога - нет', async () => {
    assert.equal(await workspaceActionError('Открыть в новом окне', () => Promise.resolve({})), undefined);
    assert.equal(await workspaceActionError('Открыть в новом окне', () => Promise.resolve({ error: 'spawn ENOENT' })), 'Открыть в новом окне: spawn ENOENT');
    assert.equal(await workspaceActionError('Открыть воркспейс', () => Promise.reject(new Error('воркспейса нет в «Недавних»'))), 'Открыть воркспейс: воркспейса нет в «Недавних»');
    // Не-Error в отказе (IPC отдаёт и строки) тоже становится текстом.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- проверяется именно не-Error
    assert.equal(await workspaceActionError('Открыть воркспейс', () => Promise.reject('строка')), 'Открыть воркспейс: строка');
  });
});

describe('окно «Плагины Cyborg»: диагностика (K-30)', () => {
  it('причина прошлого сбоя показана отдельно от причины текущего состояния; нет сбоя - нет строки', () => {
    assert.equal(previousNote(row('echo', 'active')), undefined);
    const text = previousNote(row('echo', 'active', { previousFailure: { at: Date.UTC(2026, 10, 9, 12, 0, 0), text: 'выключен, сбоев подряд: 3' } }));
    assert.match(text ?? '', /^В прошлом запуске, .*09\.11\.2026.*: выключен, сбоев подряд: 3$/);
  });

  it('строка хранения: размер, время самой ранней записи, прошлый запуск и отказ записи; без хранения строки нет', () => {
    assert.equal(diagnosticsLine(undefined), undefined);
    assert.equal(diagnosticsLine({ files: 1, bytes: 10 }), 'Диагностика: файлов 1, 1 КиБ; прошлого запуска в файлах нет');
    const full = diagnosticsLine({ files: 3, bytes: 5 * 1024 * 1024, since: Date.UTC(2026, 10, 9), previousRunAt: Date.UTC(2026, 10, 9, 8), problem: 'ENOSPC' });
    assert.match(full ?? '', /^Диагностика: файлов 3, 5120 КиБ; записи с .*09\.11\.2026.*; прошлый запуск с .*; запись в файл не удаётся \(ENOSPC\), записи держатся в памяти$/);
  });

  it('итог выгрузки: куда лёг файл, отказ с текстом, отмена диалога - пустая строка', () => {
    assert.match(exportMessage({ value: { file: '/tmp/d.txt', bytes: 42 } }), /^Выгрузка сохранена: \/tmp\/d\.txt \(42 Б\)\. Файл остаётся на этом компьютере/);
    assert.equal(exportMessage({ error: 'выгрузка не записана: EACCES' }), 'выгрузка не записана: EACCES');
    assert.equal(exportMessage({}), '');
  });
});
