import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkspace } from '../../../core/src/index.ts';
import { migrateLegacyWorkspace } from './legacy-workspace.ts';

const json = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

test('перенос {projects, lastProjectId}: проекты и трекеры в settings, активный проект в state, копия старого файла', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-legacy-')));
  const file = path.join(root, 'team.cyborg.json');
  const options = { file, userFile: path.join(root, 'user', 'cyborg.json'), stateDir: path.join(root, 'state'), migrate: migrateLegacyWorkspace };
  try {
    const legacy = {
      projects: [
        { id: 'p1', name: 'Cyborg', path: '/w/cyborg', trackers: { github: true }, jira: { enabled: false, projects: [] } },
        { id: 'p2', name: 'Core', description: 'ядро', repos: ['/w/a', '/w/b'] },
      ],
      lastProjectId: 'p2',
    };
    await writeFile(file, JSON.stringify(legacy));
    const opened = await openWorkspace(options);
    assert.ok(opened.ok);
    const ws = opened.workspace;
    assert.equal(ws.migrated.length, 2);
    assert.deepEqual(await json(file), {
      cyborg: 2,
      settings: {
        projects: {
          items: [
            { id: 'p1', name: 'Cyborg', description: '', repos: ['/w/cyborg'] },
            { id: 'p2', name: 'Core', description: 'ядро', repos: ['/w/a', '/w/b'] },
          ],
        },
        trackers: { byProject: { p1: { github: true, jira: { enabled: false, projects: [] } } } },
      },
    });
    assert.deepEqual(await json(ws.stateFile), { projects: { lastProjectId: 'p2' } });
    assert.deepEqual(await json(`${file}.v1.bak`), legacy);
    ws.close();
    const second = await openWorkspace(options);
    assert.ok(second.ok);
    assert.deepEqual(second.workspace.migrated, [], 'перенос повторился');
    second.workspace.close();
    assert.equal(migrateLegacyWorkspace({ settings: {} }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
