import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkspace } from '@cyborg-harness/core';
import { migrateLegacyWorkspace } from './legacy-workspace.ts';

const json = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

test('ST-5004/5: перенос {projects, lastProjectId}: проекты и трекеры в settings, активный проект в state, копия старого файла', async () => {
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

// PL-06: файл воркспейса Cyborg на коммите ai-cyborg e4beb72. Копия собрана настоящим `ProjectStore` того коммита из вымышленных данных (личных данных нет):
// проекты с trackers и jira, lastProjectId, кнопки commands, плюс неизвестные поля, которых приложение не знает (в проектах и наверху файла).
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'workspace-e4beb72.cyborg.json');

async function openFixture(root: string) {
  const file = path.join(root, 'team.cyborg.json');
  await cp(FIXTURE, file);
  const options = { file, userFile: path.join(root, 'user', 'cyborg.json'), stateDir: path.join(root, 'state'), migrate: migrateLegacyWorkspace };
  const opened = await openWorkspace(options);
  assert.ok(opened.ok);
  return { file, options, ws: opened.workspace };
}

/** Все скалярные значения документа, по одному на вхождение: потеря значения при переносе - его нет в итоге, перенос по другому пути не мешает. */
function leaves(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => leaves(v, into));
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach((v) => leaves(v, into));
  else into.push(JSON.stringify(value));
  return into;
}

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && !entry.name.endsWith('.lock')) out[path.relative(root, path.join(entry.parentPath, entry.name))] = await readFile(path.join(entry.parentPath, entry.name), 'base64');
  }
  return out;
}

test('ST-5004/5: файл e4beb72: ни одно значение не потеряно, поля уходят по таблице, копия .v1.bak побайтно равна исходнику', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pl06-')));
  try {
    const original = await readFile(FIXTURE);
    const old = JSON.parse(original.toString('utf8')) as Record<string, unknown>;
    const { file, ws } = await openFixture(root);
    assert.equal(ws.migrated.length, 2);
    assert.ok(original.equals(await readFile(`${file}.v1.bak`)), '.v1.bak не равна исходному файлу побайтно');

    const config = (await json(file)) as { cyborg: number; settings: Record<string, Record<string, unknown>>; [k: string]: unknown };
    const state = (await json(ws.stateFile)) as Record<string, unknown>;
    const projects = old.projects as Record<string, unknown>[];
    // projects -> settings.projects.items (id, name, description, repos и неизвестные поля проекта на месте)
    assert.deepEqual(config.settings.projects, { items: projects.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'trackers' && k !== 'jira'))) });
    // trackers и jira проекта -> settings.trackers.byProject.<id>; проект без обоих полей в таблицу не попадает
    assert.deepEqual(config.settings.trackers, {
      byProject: Object.fromEntries(projects.map((p): [string, unknown] => [p.id as string, { ...(p.trackers as object), ...(p.jira !== undefined && { jira: p.jira }) }])),
    });
    // commands -> settings.command-buttons.commands как записаны (поля неизвестной кнопки тоже)
    assert.deepEqual(config.settings['command-buttons'], { commands: old.commands });
    // lastProjectId -> state.projects.lastProjectId
    assert.deepEqual(state, { projects: { lastProjectId: 'p-core' } });
    // неизвестные поля верхнего уровня остаются на месте, а перенесённые из верхнего уровня ушли
    assert.deepEqual(Object.keys(config).sort(), ['cyborg', 'futureNote', 'settings', 'theme']);
    assert.deepEqual({ futureNote: config.futureNote, theme: config.theme }, { futureNote: old.futureNote, theme: old.theme });

    // инвариант «без потерь»: каждое значение исходного файла есть в config или state
    const after = leaves([config.settings, state, { futureNote: config.futureNote, theme: config.theme }]);
    const lost: string[] = [];
    for (const value of leaves(old)) {
      const at = after.indexOf(value);
      if (at < 0) lost.push(value);
      else after.splice(at, 1);
    }
    assert.deepEqual(lost, []);
    ws.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ST-5004/5: файл e4beb72: повторное открытие не меняет ни одного файла (config, state, копия), перенос не повторяется', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-pl06-')));
  try {
    const { options, ws } = await openFixture(root);
    ws.close();
    const before = await tree(root);
    assert.deepEqual(Object.keys(before).sort(), ['state/' + path.basename(ws.stateFile), 'team.cyborg.json', 'team.cyborg.json.v1.bak'].sort());
    for (let run = 0; run < 2; run++) {
      const again = await openWorkspace(options);
      assert.ok(again.ok);
      assert.deepEqual(again.workspace.migrated, []);
      assert.deepEqual(again.workspace.problems, []);
      again.workspace.close();
      assert.deepEqual(await tree(root), before, `файлы изменились после повторного открытия ${String(run + 1)}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ST-5004/5: перенос: неизвестные поля проекта остаются в его записи, пропущенные записи сохраняются в settings.projects.skipped, а не пропадают', () => {
  const migrated = migrateLegacyWorkspace({
    projects: [{ id: 'a', name: 'A', repos: ['/r'], color: 'red', extra: { n: 1 } }, 'мусор', { name: 'без id' }, null, { id: 'b', path: '/p' }],
    lastProjectId: 'a',
  });
  assert.deepEqual(migrated?.config.settings, {
    projects: {
      items: [
        { id: 'a', name: 'A', description: '', repos: ['/r'], color: 'red', extra: { n: 1 } },
        { id: 'b', name: 'b', description: '', repos: ['/p'] },
      ],
      skipped: ['мусор', { name: 'без id' }, null],
    },
  });
});

test('перенос: commands - только список; иное значение, как и lastProjectId не строкой, остаётся в файле на месте', () => {
  const migrated = migrateLegacyWorkspace({ projects: [], commands: { не: 'список' }, lastProjectId: 7 });
  assert.ok(migrated);
  assert.deepEqual(migrated.config, { settings: { projects: { items: [] } }, commands: { не: 'список' }, lastProjectId: 7 });
  assert.deepEqual(migrated.state, {});
  assert.deepEqual(migrateLegacyWorkspace({ projects: [], commands: [], lastProjectId: null })?.config, { settings: { projects: { items: [] }, 'command-buttons': { commands: [] } } });
});
