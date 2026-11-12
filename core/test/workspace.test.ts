import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, PluginModule } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { RecentWorkspaces } from '../src/recent.ts';
import { inlineHosts } from '../src/transports.ts';
import { lockWorkspace, openWorkspace, workspaceKey, type MigrateWorkspace, type Workspace } from '../src/workspace.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { waitFor } from './wait-for.ts';

async function sandbox() {
  // На macOS tmpdir - симлинк /var -> /private/var, а «Недавние» хранят путь после realpath.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-ws-')));
  return {
    root,
    file: path.join(root, 'team.cyborg.json'),
    userFile: path.join(root, 'user', 'cyborg.json'),
    stateDir: path.join(root, 'state'),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}

const json = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

async function open(box: Awaited<ReturnType<typeof sandbox>>, pid?: number): Promise<Workspace> {
  const r = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, ...(pid !== undefined && { pid }) });
  assert.ok(r.ok, 'воркспейс занят');
  return r.workspace;
}

test('ST-1007/1: замок: второй открывающий получает pid владельца, замок умершего процесса забирается, close снимает', async () => {
  await using box = await sandbox();
  const ws = await open(box);
  const again = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, pid: process.pid + 1 });
  assert.deepEqual(again, { ok: false, owner: process.pid });
  ws.close();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  assert.ok(dead);
  await writeFile(`${box.file}.lock`, JSON.stringify({ pid: dead }));
  const taken = lockWorkspace(box.file);
  assert.ok(taken.ok, 'замок умершего процесса не забран');
  taken.release();
  (await open(box)).close();
});

test('ST-1007/3: state по ключу воркспейса: тот же файл через симлинк - то же состояние', async () => {
  await using box = await sandbox();
  await writeFile(box.file, '{}');
  const link = path.join(box.root, 'link.json');
  await symlink(box.file, link);
  assert.equal(workspaceKey(link), workspaceKey(box.file));
  assert.notEqual(workspaceKey(path.join(box.root, 'other.json')), workspaceKey(box.file));
});

test('ST-5004/5: ST-1007/5: перенос старого формата хуком приложения: копия .v1.bak, config с полем cyborg, разделы state, повтор не идёт', async () => {
  await using box = await sandbox();
  const old = { items: ['a', 'b'], current: 'b', plugins: { enabled: ['list'] } };
  await writeFile(box.file, JSON.stringify(old));
  await mkdir(box.stateDir, { recursive: true });
  const seen: Record<string, unknown>[] = [];
  const migrate: MigrateWorkspace = (doc) => {
    seen.push(doc);
    if (!Array.isArray(doc.items)) return undefined;
    const { items, current, ...rest } = doc;
    return { config: { ...rest, settings: { list: { items } } }, state: typeof current === 'string' ? { list: { current } } : {} };
  };
  const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  assert.equal(ws.migrated.length, 2);
  assert.deepEqual(await json(box.file), { cyborg: 2, plugins: { enabled: ['list'] }, settings: { list: { items: ['a', 'b'] } } });
  assert.deepEqual(ws.plugins.enabled, ['list']);
  assert.deepEqual(await json(ws.stateFile), { list: { current: 'b' } });
  assert.deepEqual(await json(`${box.file}.v1.bak`), old);
  ws.close();
  const second = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate });
  assert.ok(second.ok);
  assert.deepEqual(second.workspace.migrated, [], 'перенос повторился');
  assert.equal(seen.length, 1, 'хук позван для документа с полем cyborg');
  second.workspace.close();
});

// PL-06: копия `.v1.bak` - защита пользователя от потери данных, поэтому она байты исходника, а не его пересериализация (приложение пишет файл без перевода строки в конце).
test('ST-1007/5: перенос: .v1.bak побайтно равна исходному файлу, даже если его формат отличается от записи ядра', async () => {
  await using box = await sandbox();
  const original = Buffer.from('{"items":[ "a" ,"b"],\r\n  "current":"b",  "n": 1.0, "текст": "\\u0041"}');
  await writeFile(box.file, original);
  const migrate: MigrateWorkspace = (doc) => ({ config: { settings: { list: { items: doc.items } } }, state: {} });
  const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate });
  assert.ok(opened.ok);
  opened.workspace.close();
  assert.ok(original.equals(await readFile(`${box.file}.v1.bak`)), 'копия не равна исходнику побайтно');
  assert.deepEqual(await json(box.file), { cyborg: 2, settings: { list: { items: ['a', 'b'] } } });
});

test('перенос: сбой записи state оставляет файл прежним, и следующее открытие переносит всё, включая state', async () => {
  await using box = await sandbox();
  const original = JSON.stringify({ items: ['a'], current: 'a' });
  await writeFile(box.file, original);
  // На месте каталога state лежит файл: запись раздела state невозможна.
  await writeFile(box.stateDir, 'не каталог');
  const migrate: MigrateWorkspace = (doc) => ({ config: { settings: { list: { items: doc.items } } }, state: { list: { current: doc.current } } });
  await assert.rejects(openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate }));
  assert.equal(await readFile(box.file, 'utf8'), original, 'файл переведён раньше, чем записан state: перенос уже не повторится');
  await rm(box.stateDir);
  const again = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate });
  assert.ok(again.ok);
  assert.deepEqual(await json(again.workspace.stateFile), { list: { current: 'a' } });
  assert.deepEqual(await json(box.file), { cyborg: 2, settings: { list: { items: ['a'] } } });
  again.workspace.close();
});

test('файл новее известного формата (cyborg 3): читается, но не перезаписывается, причина в problems', async () => {
  await using box = await sandbox();
  const future = JSON.stringify({ cyborg: 3, plugins: { enabled: ['a'] }, settings: { a: { $version: 1, x: 1 } }, ещё: { новое: true } });
  await writeFile(box.file, future);
  let called = false;
  const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate: () => ((called = true), undefined) });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  assert.equal(called, false, 'хук позван для документа с полем cyborg');
  assert.deepEqual(ws.plugins.enabled, ['a']);
  assert.match(ws.problems.join('\n'), /cyborg 3.*новее.*2/);
  await assert.rejects(ws.config.write('workspace', 'a', 1, { x: 2 }), /новее|запись отменена/);
  ws.close();
  assert.equal(await readFile(box.file, 'utf8'), future);
  assert.equal((await readdir(box.root)).some((n) => n.includes('.v1.bak') || n.includes('.corrupt-')), false, 'копий не должно быть');
});

test('пустой файл и корень не объект: не стираются и не переводятся, рядом копия; запись в них отменена', async () => {
  for (const content of ['', '[1]', 'null']) {
    await using box = await sandbox();
    await writeFile(box.file, content);
    let called = false;
    const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate: () => ((called = true), undefined) });
    assert.ok(opened.ok);
    assert.equal(called, false, `хук позван для ${JSON.stringify(content)}`);
    assert.equal(opened.workspace.problems.length, 1);
    await assert.rejects(opened.workspace.config.write('workspace', 'a', 1, { x: 1 }));
    opened.workspace.close();
    assert.equal(await readFile(box.file, 'utf8'), content);
    assert.equal((await readdir(box.root)).filter((n) => n.startsWith('team.cyborg.json.corrupt-')).length, 1);
    assert.equal((await readdir(box.root)).some((n) => n.endsWith('.v1.bak')), false);
  }
});

// Права: под root проверка доступа ничего не запрещает.
const asRoot = process.getuid?.() === 0;

test('файл только для чтения: старый формат не переводится, запись разделов отменена, файл и его права на месте', { skip: asRoot }, async () => {
  await using box = await sandbox();
  const original = JSON.stringify({ items: ['a'] });
  await writeFile(box.file, original);
  await chmod(box.file, 0o444);
  const migrate: MigrateWorkspace = (doc) => ({ config: { settings: { list: { items: doc.items } } }, state: {} });
  const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate });
  assert.ok(opened.ok);
  assert.equal(opened.workspace.migrated.length, 0);
  assert.match(opened.workspace.problems.join('\n'), /только для чтения/);
  await assert.rejects(opened.workspace.config.write('workspace', 'list', 1, { items: [] }), /только для чтения/);
  opened.workspace.close();
  assert.equal(await readFile(box.file, 'utf8'), original);
  assert.equal((await stat(box.file)).mode & 0o777, 0o444, 'права файла заменены записью ядра');
  assert.equal((await readdir(box.root)).some((n) => n.endsWith('.v1.bak')), false, 'копия без переноса не нужна');
});

test('каталог только для чтения: открытие отказывает ошибкой доступа, файл не тронут', { skip: asRoot }, async () => {
  await using box = await sandbox();
  const original = JSON.stringify({ items: ['a'] });
  await writeFile(box.file, original);
  await chmod(box.root, 0o555);
  try {
    await assert.rejects(openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate: () => ({ config: {}, state: {} }) }), { code: 'EACCES' });
    assert.equal(await readFile(box.file, 'utf8'), original);
  } finally {
    await chmod(box.root, 0o755);
  }
});

test('хук вернул undefined или его нет: файл не тронут, копии нет', async () => {
  await using box = await sandbox();
  const old = { unknown: true };
  await writeFile(box.file, JSON.stringify(old));
  const opened = await openWorkspace({ file: box.file, userFile: box.userFile, stateDir: box.stateDir, migrate: () => undefined });
  assert.ok(opened.ok);
  assert.deepEqual(opened.workspace.migrated, []);
  opened.workspace.close();
  (await open(box)).close();
  assert.deepEqual(await json(box.file), old);
  await assert.rejects(readFile(`${box.file}.v1.bak`), { code: 'ENOENT' });
});

test('ST-1007/3: plugins: воркспейс перекрывает enabled пользователя, группы хостов сливаются; нет файла - пустой новый', async () => {
  await using box = await sandbox();
  const fresh = await open(box);
  assert.deepEqual(fresh.plugins, { enabled: [], hosts: {}, uiGroups: {}, keybindings: [] });
  assert.deepEqual(await json(box.file), { cyborg: 2, plugins: {}, settings: {} });
  fresh.close();
  await rm(box.file);
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['b'], hosts: { two: ['b'] }, keybindings: [{ key: 'F2', command: null }, { key: 'F3' }] } }));
  await mkdir(path.dirname(box.userFile), { recursive: true });
  await writeFile(box.userFile, JSON.stringify({ plugins: { enabled: ['a'], hosts: { one: ['a'] }, keybindings: [{ key: 'F2', command: 'a.go' }] } }));
  const ws = await open(box);
  assert.deepEqual(ws.plugins, { enabled: ['b'], hosts: { one: ['a'], two: ['b'] }, uiGroups: {}, keybindings: [{ key: 'F2', command: 'a.go' }, { key: 'F2', command: null }] });
  ws.close();
});

// K-04: plugins.uiGroups - группа рендера -> плагины; группа рендера делит мост плагинов, поэтому читается только из слоя пользователя (ADR-CH-0015, п. 5).
test('ST-3008/2: plugins.uiGroups: действуют группы пользователя, поле файла воркспейса не действует и называется в problems', async () => {
  await using box = await sandbox();
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { uiGroups: { panels: ['b', 'c'], solo: ['d'] } } }));
  await mkdir(path.dirname(box.userFile), { recursive: true });
  await writeFile(box.userFile, JSON.stringify({ plugins: { uiGroups: { panels: ['a'], extra: ['e', 7] } } }));
  const ws = await open(box);
  assert.deepEqual(ws.plugins.uiGroups, { panels: ['a'], extra: ['e'] });
  assert.deepEqual(ws.plugins.hosts, {}, 'группы рендера не смешиваются с группами хостов');
  assert.deepEqual(ws.problems.map((p) => p.replace(box.root, '')), [
    '/user/cyborg.json: plugins.uiGroups.extra[1]: ожидается id плагина (строка), получено 7',
    '/team.cyborg.json: plugins.uiGroups: группы рендера берутся только из файла пользователя, поле воркспейса не действует',
  ]);
  ws.close();
});

test('plugins.uiGroups: ошибки называют поле и файл пользователя, годное остаётся', async () => {
  await using box = await sandbox();
  await mkdir(path.dirname(box.userFile), { recursive: true });
  await writeFile(
    box.userFile,
    JSON.stringify({ plugins: { uiGroups: { 'Bad Name': ['a'], list: 'a', ok: ['a', 'b'], 'http:80': ['c'], dup: ['a'], null: null } } }),
  );
  const ws = await open(box);
  assert.deepEqual(ws.plugins.uiGroups, { ok: ['a', 'b'], dup: [] });
  const rel = ws.problems.map((p) => p.replace(box.root, ''));
  assert.deepEqual(rel, [
    '/user/cyborg.json: plugins.uiGroups.Bad Name: ожидается имя группы: строчные латинские буквы, цифры и дефис, части через точку, получено "Bad Name"',
    '/user/cyborg.json: plugins.uiGroups.list: ожидается список id плагинов, получено "a"',
    '/user/cyborg.json: plugins.uiGroups.http:80: ожидается имя группы: строчные латинские буквы, цифры и дефис, части через точку, получено "http:80"',
    '/user/cyborg.json: plugins.uiGroups.dup: плагин a уже назван в группе ok - действует первая',
    '/user/cyborg.json: plugins.uiGroups.null: ожидается список id плагинов, получено null',
  ]);
  ws.close();
  await writeFile(box.userFile, JSON.stringify({ plugins: { uiGroups: ['a'] } }));
  const bad = await open(box);
  assert.deepEqual(bad.plugins.uiGroups, {});
  assert.deepEqual(bad.problems.map((p) => p.replace(box.root, '')), ['/user/cyborg.json: plugins.uiGroups: ожидается объект «группа -> список id плагинов», получено ["a"]']);
  bad.close();
});

test('ST-5004/3, ST-5004/8: ST-1007/8: правка файла извне доходит до ctx.config.onChange; не прошедшая проверку - запись в журнале, значение прежнее; своя запись не будит', async (t) => {
  await using box = await sandbox();
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['lock'] }, settings: { lock: { $version: 1, minutes: 5 } } }));
  const ws = await open(box);
  const seen: unknown[] = [];
  let ctx: PluginContext | undefined;
  const lock: PluginModule = {
    config: { defaults: { minutes: 10 }, validate: (v) => (typeof v.minutes === 'number' && v.minutes > 0 ? [] : ['minutes: ожидается число > 0']) },
    activate(c) {
      ctx = c;
      c.config?.onChange((v) => seen.push(v.minutes));
    },
  };
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => lock),
    enabled: ws.plugins.enabled,
    manifests: [{ id: 'lock', version: '1.0.0', engines: { cyborg: '^1' }, config: { version: 1 } }],
    config: ws.config,
    state: ws.state,
  });
  const problems: string[] = [];
  const watching = ws.watch((ids) => void k.reloadSections('config', ids), (m) => problems.push(m));
  t.after(async () => {
    watching.dispose();
    await k.unload();
    ws.close();
  });
  const config = ctx?.config;
  assert.ok(config, 'плагин не получил config');
  assert.equal(config.get().minutes, 5);

  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['lock'] }, settings: { lock: { $version: 1, minutes: 7 } } }));
  await waitFor('onChange с 7', () => seen.includes(7));

  await writeFile(box.file, JSON.stringify({ cyborg: 2, settings: { lock: { $version: 1, minutes: -1 } } }));
  await waitFor('отказ в журнале', () => k.journal.some((e) => e.kind === 'config' && e.result.status === 'invalid'));
  assert.equal(config.get().minutes, 7);

  await writeFile(box.file, '{ "cyborg": 2, "settings": {');
  await waitFor('битый файл замечен', () => problems.length > 0);
  await assert.rejects(config.set('workspace', { minutes: 3 }), /запись отменена|JSON/);
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['lock'] }, settings: { lock: { $version: 1, minutes: 7 } } }));
  // Пока слежение не перечитало исправленный файл, запись отменяется: проба повторяется до первой удавшейся.
  await waitFor('исправленный файл перечитан, запись снова разрешена', async () => (await config.set('workspace', { minutes: 3 }).then(() => true, () => undefined)));
  assert.deepEqual(seen, [7, 3]);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(seen, [7, 3], 'своя запись вернулась через слежение');
  assert.equal(((await json(box.file)).settings as Record<string, Record<string, unknown>>).lock?.minutes, 3);

});

test('слежение: правка между открытием воркспейса и запуском слежения не теряется (на macOS события до готовности FSEvents не приходят)', async (t) => {
  await using box = await sandbox();
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['lock'] }, settings: { lock: { $version: 1, minutes: 5 } } }));
  const ws = await open(box);
  const seen: unknown[] = [];
  const lock: PluginModule = {
    config: { defaults: { minutes: 10 } },
    activate(c) {
      c.config?.onChange((v) => seen.push(v.minutes));
    },
  };
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => lock),
    enabled: ws.plugins.enabled,
    manifests: [{ id: 'lock', version: '1.0.0', engines: { cyborg: '^1' }, config: { version: 1 } }],
    config: ws.config,
    state: ws.state,
  });
  t.after(async () => {
    await k.unload();
    ws.close();
  });
  await writeFile(box.file, JSON.stringify({ cyborg: 2, plugins: { enabled: ['lock'] }, settings: { lock: { $version: 1, minutes: 7 } } }));
  await new Promise((r) => setTimeout(r, 300));
  const watching = ws.watch((ids) => void k.reloadSections('config', ids));
  t.after(() => watching.dispose());
  await waitFor('onChange с 7', () => seen.includes(7));
});

test('битый файл пользователя не роняет открытие: причина в problems, файл не перезаписан', async () => {
  await using box = await sandbox();
  await mkdir(path.dirname(box.userFile), { recursive: true });
  await writeFile(box.userFile, '{ "plugins": ');
  const ws = await open(box);
  assert.equal(ws.problems.length, 1);
  assert.match(ws.problems[0] ?? '', /cyborg\.json/);
  assert.deepEqual(ws.plugins, { enabled: [], hosts: {}, uiGroups: {}, keybindings: [] });
  await assert.rejects(ws.config.write('user', 'x', 1, { a: 1 }));
  assert.equal(await readFile(box.userFile, 'utf8'), '{ "plugins": ');
  ws.close();
});

test('ST-1007/4: битый файл воркспейса: рядом копия .corrupt-<время> с исходником, сам файл не тронут, повторное открытие копий не плодит', async () => {
  await using box = await sandbox();
  const broken = '{ "cyborg": 2, "plugins": ';
  await writeFile(box.file, broken);
  const copies = async () => (await readdir(box.root)).filter((n) => n.startsWith('team.cyborg.json.corrupt-'));
  const first = await open(box);
  const [copy] = await copies();
  assert.ok(copy, 'копии нет');
  assert.match(copy, /^team\.cyborg\.json\.corrupt-\d{4}-\d\d-\d\dT[\d-]+Z(-\d+)?$/);
  assert.match(first.problems[0] ?? '', new RegExp(`копия - ${copy.replaceAll('.', '\\.')}`));
  assert.equal(await readFile(path.join(box.root, copy), 'utf8'), broken);
  assert.equal(await readFile(box.file, 'utf8'), broken);
  first.close();

  const again = await open(box);
  assert.deepEqual(await copies(), [copy], 'та же порча - та же копия');
  again.close();
  await writeFile(box.file, `${broken} "иначе"`);
  (await open(box)).close();
  assert.equal((await copies()).length, 2, 'новая порча - новая копия');
});

test('ST-1007/6: «Недавние»: последний открытый первым, без повторов по realpath, пропавший файл не показывается, битый список не мешает', async () => {
  await using box = await sandbox();
  const list = path.join(box.root, 'recent.json');
  const recent = new RecentWorkspaces(list, 3);
  const files = ['a', 'b', 'c', 'd'].map((n) => path.join(box.root, `${n}.cyborg.json`));
  for (const f of files) await writeFile(f, '{}');
  await symlink(files[0]!, path.join(box.root, 'link.cyborg.json'));
  for (const f of files.slice(0, 3)) recent.add(f);
  recent.add(path.join(box.root, 'link.cyborg.json'));
  assert.deepEqual(recent.list(), [files[0], files[2], files[1]]);
  recent.add(files[3]!);
  assert.deepEqual(recent.list(), [files[3], files[0], files[2]], 'лимит');
  await rm(files[0]!);
  assert.deepEqual(recent.list(), [files[3], files[2]]);
  recent.remove(files[3]!);
  assert.deepEqual(recent.list(), [files[2]]);
  await writeFile(list, '{');
  assert.deepEqual(recent.list(), []);
  recent.add(files[1]!);
  assert.deepEqual(recent.list(), [files[1]]);
});
