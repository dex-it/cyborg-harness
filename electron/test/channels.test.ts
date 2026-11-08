import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

// Имена каналов IPC записаны строками дважды: в preload.ts (окно и вид просят) и в channels.ts, window.ts, views.ts (главный процесс отвечает и шлёт).
// Опечатка в одном месте - молчаливо мёртвая кнопка, поэтому соответствие сверяет тест по исходникам.
const src = path.resolve(import.meta.dirname, '..', 'src');
const read = (file: string) => fs.readFileSync(path.join(src, file), 'utf8');

const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1] ?? '').sort();
const unique = (list: string[]) => [...new Set(list)].sort();

/** Каналы, которые адаптер сам не обслуживает: их регистрирует приложение (смена воркспейса и безопасного режима - перезапуск, `restarts`). */
const APP_CHANNELS = ['app:safe-mode', 'workspace:open'];

describe('каналы IPC: preload и главный процесс', () => {
  const preload = read('preload.ts');
  const main = ['channels.ts'].map(read).join('\n');

  it('каждому invoke и send из preload есть обработчик в главном процессе или он назван каналом приложения', () => {
    const asked = unique(names(preload, /ipcRenderer\.(?:invoke|send)\('([^']+)'/g));
    const handled = unique([...names(main, /(?:ipcMain\.(?:handle|on)|windowChannel|terminalChannel)\('([^']+)'/g), ...APP_CHANNELS]);
    assert.ok(asked.length >= 25, `каналов в preload: ${String(asked.length)}`);
    assert.deepEqual(
      asked.filter((c) => !handled.includes(c)),
      [],
      'канал просят в preload, а обработчика нет',
    );
  });

  it('у каждого обработчика главного процесса есть тот, кто его просит', () => {
    const asked = unique(names(preload, /ipcRenderer\.(?:invoke|send)\('([^']+)'/g));
    const handled = unique(names(main, /(?:ipcMain\.(?:handle|on)|windowChannel|terminalChannel)\('([^']+)'/g));
    assert.deepEqual(
      handled.filter((c) => !asked.includes(c)),
      [],
      'обработчик без вызова из preload',
    );
  });

  it('каждый канал, который preload слушает, главный процесс где-то отправляет', () => {
    const listened = unique(names(preload, /ipcRenderer\.on\('([^']+)'/g));
    const sources = ['channels.ts', 'window.ts', 'views.ts', 'view-terminals.ts', 'plugins.ts'].map(read).join('\n');
    const sent = unique(names(sources, /\.send\('([^']+)'/g));
    // Терминал шлёт через фрейм: имя канала в view-terminals.ts.
    assert.ok(listened.length >= 6, `слушателей в preload: ${String(listened.length)}`);
    assert.deepEqual(
      listened.filter((c) => !sent.includes(c)),
      [],
      'preload ждёт канал, который никто не отправляет',
    );
  });
});
