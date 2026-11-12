import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { SectionStore } from '../src/config.ts';
import { load } from '../src/loader.ts';
import { openWorkspace } from '../src/workspace.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// ADR-CH-0015: значение, расширяющее права, ядро берёт только из слоя пользователя. Файл воркспейса приходит из репозитория команды.

const JIRA = 'https://jira.corp.local';
const EVIL = 'https://evil.example';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });

async function sandbox() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-trust-')));
  await mkdir(path.join(root, 'user'));
  await mkdir(path.join(root, 'ws'));
  return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

/** Плагин `web` с правом `net: ["config:baseUrl"]` и слоями config в памяти; хосты, до которых дошёл запрос, собираются в `calls`. */
async function web(layers: { user?: Record<string, unknown>; workspace?: Record<string, unknown> }, root: string, field = 'baseUrl') {
  const docs = new Map<string, Record<string, unknown>>();
  for (const [layer, baseUrl] of Object.entries(layers)) docs.set(layer, { web: { $version: 1, ...baseUrl } });
  const store = await SectionStore.open({ load: async (l) => structuredClone(docs.get(l)), save: async (l, d) => void docs.set(l, structuredClone(d)) }, ['user', 'workspace']);
  const calls: string[] = [];
  const fetch = (async (url: URL) => {
    calls.push(url.host);
    return new Response('ok');
  }) as unknown as typeof globalThis.fetch;
  let ctx: PluginContext | undefined;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
    enabled: ['web'],
    manifests: [manifest('web', { permissions: { net: [`config:${field}`] }, config: { version: 1 } })],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), fetch },
    config: store,
  });
  const plugin = () => {
    assert.ok(ctx, 'web не активирован');
    return ctx;
  };
  const denials = () => k.journal.filter((e) => e.kind === 'denied');
  return { k, store, docs, calls, plugin, denials };
}

test('config:<поле> из слоя воркспейса не пускает net.fetch, из слоя пользователя - пускает', async () => {
  await using box = await sandbox();

  const fromWorkspace = await web({ workspace: { baseUrl: EVIL } }, box.root);
  await assert.rejects(fromWorkspace.plugin().os.net!.fetch(`${EVIL}/token`), { code: 'PermissionDenied' });
  assert.deepEqual(fromWorkspace.calls, [], 'запрос на хост из файла воркспейса не ушёл');
  const [denied] = fromWorkspace.denials();
  assert.ok(denied);
  assert.equal(denied.method, 'net.fetch');
  assert.match(denied.detail, /config:baseUrl/);
  assert.match(denied.detail, /воркспейс/);
  assert.match(denied.detail, /пользовател/);
  await fromWorkspace.k.unload();

  const fromUser = await web({ user: { baseUrl: JIRA } }, box.root);
  await fromUser.plugin().os.net!.fetch(`${JIRA}/rest`);
  assert.deepEqual(fromUser.calls, ['jira.corp.local']);
  assert.deepEqual(fromUser.denials(), []);
  await fromUser.k.unload();
});

// PL-10 (#226): хабов трекера у человека бывает несколько (свои GitLab и Jira), и одной строкой они не выражаются.
test('config:<поле> со списком: из слоя пользователя пускает каждый названный хост, из слоя воркспейса - ни одного, чужой хост вне списка - отказ', async () => {
  await using box = await sandbox();
  const HUBS = ['https://gitlab.corp.local', 'https://jira.corp.local:8443', 'git.corp.local:9000'];

  const fromWorkspace = await web({ workspace: { hubs: HUBS } }, box.root, 'hubs');
  for (const hub of HUBS) await assert.rejects(fromWorkspace.plugin().os.net!.fetch(`${hub.includes('//') ? hub : `https://${hub}`}/x`), { code: 'PermissionDenied' }, hub);
  assert.deepEqual(fromWorkspace.calls, [], 'ни один запрос на хост из файла воркспейса не ушёл');
  assert.match(fromWorkspace.denials()[0]?.detail ?? '', /config:hubs задан в файле воркспейса/);
  await fromWorkspace.k.unload();

  const fromUser = await web({ user: { hubs: [...HUBS, 42, null, { host: 'evil.example' }] } }, box.root, 'hubs');
  const os = fromUser.plugin().os;
  for (const url of ['https://gitlab.corp.local/a', 'https://jira.corp.local:8443/b', 'https://git.corp.local:9000/c']) await os.net!.fetch(url);
  assert.deepEqual(fromUser.calls, ['gitlab.corp.local', 'jira.corp.local:8443', 'git.corp.local:9000']);
  for (const url of [EVIL, 'https://jira.corp.local/', 'https://gitlab.corp.local:8443/', 'https://42/', 'https://null/']) await assert.rejects(os.net!.fetch(url), { code: 'PermissionDenied' }, url);
  assert.equal(fromUser.calls.length, 3, 'хост вне списка запроса не получил');
  await fromUser.k.unload();
});

test('config:<поле> со списком: воркспейс перекрывает список для плагина, но не для права net; правка списка человеком извне расширяет, правка воркспейса - нет', async () => {
  await using box = await sandbox();
  const w = await web({ user: { hubs: [JIRA] }, workspace: { hubs: [JIRA, EVIL] } }, box.root, 'hubs');
  assert.deepEqual(w.plugin().config?.get().hubs, [JIRA, EVIL], 'плагин видит слитое значение');
  await assert.rejects(w.plugin().os.net!.fetch(`${EVIL}/`), { code: 'PermissionDenied' });
  await w.plugin().os.net!.fetch(`${JIRA}/`);
  w.docs.set('user', { web: { $version: 1, hubs: [JIRA, EVIL] } });
  await w.store.reload();
  await w.k.reloadSections('config', ['web']);
  await w.plugin().os.net!.fetch(`${EVIL}/`);
  assert.deepEqual(w.calls, ['jira.corp.local', 'evil.example']);
  await assert.rejects(w.plugin().config!.set('user', { hubs: [JIRA, EVIL, 'https://other.example'] }), { code: 'PermissionDenied' }, 'плагин сам список не расширяет');
  await w.k.unload();
});

test('config:<поле>: воркспейс перекрывает значение для плагина, но не для права net', async () => {
  await using box = await sandbox();
  const both = await web({ user: { baseUrl: JIRA }, workspace: { baseUrl: EVIL } }, box.root);
  assert.equal(both.plugin().config?.get().baseUrl, EVIL, 'плагин видит слитое значение, как раньше');
  await assert.rejects(both.plugin().os.net!.fetch(`${EVIL}/`), { code: 'PermissionDenied' });
  await both.plugin().os.net!.fetch(`${JIRA}/`);
  assert.deepEqual(both.calls, ['jira.corp.local']);
  await both.k.unload();
});

test('config:<поле>: правка файла воркспейса извне хоста не расширяет, правка файла пользователя - расширяет', async () => {
  await using box = await sandbox();
  const w = await web({ user: { baseUrl: JIRA } }, box.root);
  w.docs.set('workspace', { web: { $version: 1, baseUrl: EVIL } });
  assert.deepEqual(await w.store.reload(), ['web']);
  await w.k.reloadSections('config', ['web']);
  await assert.rejects(w.plugin().os.net!.fetch(`${EVIL}/`), { code: 'PermissionDenied' });
  w.docs.set('user', { web: { $version: 1, baseUrl: EVIL } });
  await w.store.reload();
  await w.k.reloadSections('config', ['web']);
  await w.plugin().os.net!.fetch(`${EVIL}/`);
  assert.deepEqual(w.calls, ['evil.example']);
  await w.k.unload();
});

test('config:<поле>: плагин не переносит значение из слоя воркспейса в слой пользователя', async () => {
  await using box = await sandbox();
  const w = await web({ user: { baseUrl: JIRA }, workspace: { baseUrl: EVIL } }, box.root);
  const config = w.plugin().config!;
  // get() отдаёт слитое значение: запись его целиком в слой пользователя сделала бы чужой хост доверенным.
  await assert.rejects(config.set('user', { ...config.get(), theme: 'dark' }), { code: 'PermissionDenied' });
  await assert.rejects(config.set('user', { baseUrl: EVIL }), { code: 'PermissionDenied' });
  assert.ok(w.denials().some((e) => e.method === 'config.set'));
  await config.set('user', { baseUrl: JIRA, theme: 'dark' });
  await config.set('workspace', { theme: 'light' });
  await assert.rejects(w.plugin().os.net!.fetch(`${EVIL}/`), { code: 'PermissionDenied' });
  await w.k.unload();
});

test('plugins.hosts из файла воркспейса: сторонний плагин остаётся в своём хосте, группа поставки действует', async () => {
  await using box = await sandbox();
  const wsFile = path.join(box.root, 'ws', 'workspace.cyborg.json');
  const userFile = path.join(box.root, 'user', 'cyborg.json');
  await writeFile(userFile, JSON.stringify({ cyborg: 2, plugins: {} }));
  await writeFile(wsFile, JSON.stringify({ cyborg: 2, plugins: { enabled: ['a', 'b', 'guest'], hosts: { shared: ['a', 'b', 'guest'] } } }));
  const opened = await openWorkspace({ file: wsFile, userFile, stateDir: path.join(box.root, 'state') });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  try {
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
      enabled: ws.plugins.enabled,
      manifests: ['a', 'b', 'guest'].map((id) => manifest(id)),
      bundled: ['a', 'b'],
      hosts: ws.plugins.hosts,
      config: ws.config,
      state: ws.state,
    });
    assert.equal(k.hostOf('guest'), 'guest', 'сторонний плагин из группы воркспейса остался в своём хосте');
    assert.deepEqual([k.hostOf('a'), k.hostOf('b')], ['shared', 'shared']);
    assert.deepEqual(k.journal.filter((e) => e.kind === 'host-isolated').map((e) => e.pluginId), ['guest']);
    await k.unload();
  } finally {
    ws.close();
  }
});

test('plugins.uiGroups из файла воркспейса: присланный файл не сажает плагины поставки в одну группу рендера, группа пользователя действует', async () => {
  await using box = await sandbox();
  const wsFile = path.join(box.root, 'ws', 'workspace.cyborg.json');
  const userFile = path.join(box.root, 'user', 'cyborg.json');
  const view = { ui: { views: { main: './ui.js' } } };
  // Воркспейс команды сводит в группу w плагин, что рендерит чужие данные (a), и плагин с сильным мостом (lock): XSS в первом получил бы мост второго.
  await writeFile(wsFile, JSON.stringify({ cyborg: 2, plugins: { enabled: ['a', 'lock', 'x'], uiGroups: { w: ['a', 'lock', 'x'] } } }));
  await writeFile(userFile, JSON.stringify({ cyborg: 2, plugins: { uiGroups: { u: ['x'] } } }));
  const opened = await openWorkspace({ file: wsFile, userFile, stateDir: path.join(box.root, 'state') });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  try {
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async () => ({ activate: () => undefined })),
      enabled: ws.plugins.enabled,
      manifests: ['a', 'lock', 'x'].map((id) => manifest(id, view)),
      bundled: ['a', 'lock', 'x'],
      uiGroups: ws.plugins.uiGroups,
      config: ws.config,
      state: ws.state,
    });
    assert.deepEqual([k.groupOf('a'), k.groupOf('lock')], ['a', 'lock'], 'группа воркспейса не объединила плагины');
    assert.equal(k.groupOf('x'), 'u', 'плагин, названный в двух слоях, получает группу пользователя');
    assert.ok(ws.problems.some((p) => p.includes('plugins.uiGroups') && p.includes('только из файла пользователя')));
    await k.unload();
  } finally {
    ws.close();
  }
});

test('файлы на диске: baseUrl в settings воркспейса хоста не даёт, в settings пользователя даёт', async () => {
  await using box = await sandbox();
  const wsFile = path.join(box.root, 'ws', 'workspace.cyborg.json');
  const userFile = path.join(box.root, 'user', 'cyborg.json');
  await writeFile(userFile, JSON.stringify({ settings: {} }));
  await writeFile(wsFile, JSON.stringify({ cyborg: 2, plugins: { enabled: ['web'] }, settings: { web: { $version: 1, baseUrl: EVIL } } }));
  const opened = await openWorkspace({ file: wsFile, userFile, stateDir: path.join(box.root, 'state') });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  const calls: string[] = [];
  const fetch = (async (url: URL) => {
    calls.push(url.host);
    return new Response('ok');
  }) as unknown as typeof globalThis.fetch;
  let ctx: PluginContext | undefined;
  try {
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
      enabled: ws.plugins.enabled,
      manifests: [manifest('web', { permissions: { net: ['config:baseUrl'] }, config: { version: 1 } })],
      os: { dataDir: path.join(box.root, 'data'), tempDir: path.join(box.root, 'temp'), fetch },
      config: ws.config,
      state: ws.state,
    });
    assert.ok(ctx);
    assert.equal(ctx.config?.get().baseUrl, EVIL);
    await assert.rejects(ctx.os.net!.fetch(`${EVIL}/token`), { code: 'PermissionDenied' });
    await writeFile(userFile, JSON.stringify({ settings: { web: { $version: 1, baseUrl: JIRA } } }));
    await ws.config.reload();
    await k.reloadSections('config', ['web']);
    await ctx.os.net!.fetch(`${JIRA}/rest`);
    await assert.rejects(ctx.os.net!.fetch(`${EVIL}/token`), { code: 'PermissionDenied' }, 'слой воркспейса перекрывает значение плагина, но не право');
    assert.deepEqual(calls, ['jira.corp.local']);
    await k.unload();
  } finally {
    ws.close();
  }
});

test('config:<поле> в слое воркспейса: миграция и пересохранение этого слоя не дают отказа, хоста тоже не дают', async () => {
  await using box = await sandbox();
  const docs = new Map<string, Record<string, unknown>>([['workspace', { web: { $version: 1, baseUrl: EVIL } }]]);
  const store = await SectionStore.open({ load: async (l) => structuredClone(docs.get(l)), save: async (l, d) => void docs.set(l, structuredClone(d)) }, ['user', 'workspace']);
  let ctx: PluginContext | undefined;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ config: { version: 2, migrate: (_from: number, d: Record<string, unknown>) => d }, activate: (c: PluginContext) => void (ctx = c) })),
    enabled: ['web'],
    manifests: [manifest('web', { permissions: { net: ['config:baseUrl'] }, config: { version: 2 } })],
    os: { dataDir: path.join(box.root, 'data'), tempDir: path.join(box.root, 'temp'), fetch: (async () => new Response('ok')) as unknown as typeof globalThis.fetch },
    config: store,
  });
  assert.ok(ctx, 'миграция слоя воркспейса не выключила плагин');
  const config = ctx.config!;
  await config.set('workspace', { ...config.get(), theme: 'dark' });
  await assert.rejects(ctx.os.net!.fetch(`${EVIL}/`), { code: 'PermissionDenied' });
  await k.unload();
});

// У-40, корни (#136): присланный воркспейс задаёт `settings.projects.items[].repos`, плагин `projects` отдаёт их ядру через `security.setRoots`.

interface Item { readonly id: string; readonly repos: readonly string[] }
const repos = (config: Record<string, unknown> | undefined): string[] => ((config?.items ?? []) as Item[]).flatMap((i) => [...i.repos]);

/** Настоящие файлы пользователя и воркспейса; `projects` (право `security.roots`, раздел `config`) и `tool` (чтение области `workspace`). */
async function projectsOnDisk(box: { root: string }, layers: { user?: readonly string[]; workspace?: readonly string[] }, over: { dialog?: string[] } = {}) {
  const userDir = path.join(box.root, 'user-repo');
  const sneaky = path.join(box.root, 'sneaky');
  for (const d of [userDir, sneaky]) {
    await mkdir(d, { recursive: true });
    await writeFile(path.join(d, 'key.txt'), `секрет ${path.basename(d)}`);
  }
  const section = (list: readonly string[] | undefined) => ({ projects: { $version: 1, items: [{ id: 'p', repos: list ?? [] }] } });
  const wsFile = path.join(box.root, 'ws', 'workspace.cyborg.json');
  const userFile = path.join(box.root, 'user', 'cyborg.json');
  await writeFile(userFile, JSON.stringify({ settings: layers.user ? section(layers.user) : {} }));
  await writeFile(wsFile, JSON.stringify({ cyborg: 2, plugins: { enabled: ['projects', 'tool'] }, settings: layers.workspace ? section(layers.workspace) : {} }));
  const opened = await openWorkspace({ file: wsFile, userFile, stateDir: path.join(box.root, 'state') });
  assert.ok(opened.ok);
  const ws = opened.workspace;
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({ activate: (c: PluginContext) => void contexts.set(entry, c) })),
    enabled: ws.plugins.enabled,
    manifests: [manifest('projects', { permissions: { 'security.roots': true }, config: { version: 1 } }), manifest('tool', { permissions: { 'fs.read': ['workspace'] } })],
    os: { dataDir: path.join(box.root, 'data'), tempDir: path.join(box.root, 'temp'), ...(over.dialog && { dialog: { open: async () => over.dialog ?? [] } }) },
    config: ws.config,
    state: ws.state,
  });
  const ctx = (id: string) => {
    const c = contexts.get(id);
    assert.ok(c, `${id} не активирован`);
    return c;
  };
  /** Как `projects` по SAD: репозитории берёт из слитого `ctx.config.get()` и отдаёт ядру. */
  const publish = () => ctx('projects').os.security!.setRoots(repos(ctx('projects').config?.get()));
  const reads = (dir: string) => ctx('tool').os.fs.readText(path.join(dir, 'key.txt'));
  return { k, ws, userDir, sneaky, ctx, publish, reads, denials: () => k.journal.filter((e) => e.kind === 'denied') };
}

test('setRoots: корень из settings.projects воркспейса не попадает в область workspace, а запись denied называет корень, слой и причину', async () => {
  await using box = await sandbox();
  const p = await projectsOnDisk(box, { workspace: [path.join(box.root, 'sneaky')] });
  try {
    await assert.rejects(p.publish(), { code: 'PermissionDenied' });
    await assert.rejects(p.reads(p.sneaky), { code: 'PermissionDenied' }, 'чужой корень открыл чтение области workspace');
    const [denied] = p.denials().filter((e) => e.method === 'security.setRoots');
    assert.ok(denied, 'отказ не записан в журнал');
    assert.equal(denied.pluginId, 'projects');
    assert.ok(denied.detail.includes(p.sneaky), denied.detail);
    assert.match(denied.detail, /воркспейс/);
    assert.match(denied.detail, /пользовател/);
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});

test('setRoots: корень из слоя пользователя принимается, смешанный список с чужим корнем отвергается целиком', async () => {
  await using box = await sandbox();
  const p = await projectsOnDisk(box, { user: [path.join(box.root, 'user-repo')], workspace: [path.join(box.root, 'sneaky')] });
  try {
    await assert.rejects(p.ctx('projects').os.security!.setRoots([p.userDir, p.sneaky]), { code: 'PermissionDenied' });
    await assert.rejects(p.reads(p.userDir), { code: 'PermissionDenied' }, 'отказ принял часть списка');
    await p.ctx('projects').os.security!.setRoots([p.userDir]);
    assert.equal(await p.reads(p.userDir), 'секрет user-repo');
    await assert.rejects(p.reads(p.sneaky), { code: 'PermissionDenied' });
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});

test('setRoots: слой воркспейса перекрывает значение плагина, но корень, названный и в слое пользователя, принимается', async () => {
  await using box = await sandbox();
  const same = path.join(box.root, 'user-repo');
  const p = await projectsOnDisk(box, { user: [same], workspace: [same] });
  try {
    await p.publish();
    assert.equal(await p.reads(p.userDir), 'секрет user-repo');
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});

test('setRoots: корень из воркспейса, который человек выбрал в диалоге (granted), принимается; родитель и потомок названного корня - нет', async () => {
  await using box = await sandbox();
  const sneaky = path.join(box.root, 'sneaky');
  const inner = path.join(sneaky, 'inner');
  await mkdir(inner, { recursive: true });
  await writeFile(path.join(inner, 'key.txt'), 'внутри');
  const p = await projectsOnDisk(box, { workspace: [sneaky] }, { dialog: [sneaky] });
  try {
    await assert.rejects(p.ctx('projects').os.security!.setRoots([inner]), { code: 'PermissionDenied' }, 'потомок названного корня');
    await assert.rejects(p.ctx('projects').os.security!.setRoots([box.root]), { code: 'PermissionDenied' }, 'родитель названного корня');
    await assert.rejects(p.publish(), { code: 'PermissionDenied' }, 'без выбора человека');
    assert.deepEqual(await p.ctx('projects').os.dialog.open({}), [sneaky]);
    await p.publish();
    assert.equal(await p.reads(sneaky), 'секрет sneaky');
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});

test('setRoots: корень, которого в config нет ни в одном слое (плагин нашёл его сам), принимается как раньше', async () => {
  await using box = await sandbox();
  const p = await projectsOnDisk(box, {});
  try {
    await p.ctx('projects').os.security!.setRoots([p.sneaky]);
    assert.equal(await p.reads(p.sneaky), 'секрет sneaky');
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});

test('setRoots: корень, названный в воркспейсе через ~ тоже отвергается', async () => {
  await using box = await sandbox();
  const rel = path.relative(homedir(), path.join(box.root, 'sneaky'));
  const p = await projectsOnDisk(box, { workspace: [`~/${rel}`] });
  try {
    await assert.rejects(p.ctx('projects').os.security!.setRoots([p.sneaky]), { code: 'PermissionDenied' });
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});

test('config.set: плагин не переносит корни из слоя воркспейса в слой пользователя, свои корни пишет', async () => {
  await using box = await sandbox();
  const p = await projectsOnDisk(box, { user: [path.join(box.root, 'user-repo')], workspace: [path.join(box.root, 'sneaky')] });
  try {
    const config = p.ctx('projects').config!;
    const merged = config.get();
    // get() отдаёт слитое значение: запись его целиком в слой пользователя сделала бы чужой корень названным человеком.
    await assert.rejects(config.set('user', merged), { code: 'PermissionDenied' });
    assert.ok(p.denials().some((e) => e.method === 'config.set' && e.detail.includes(p.sneaky)));
    await config.set('user', { items: [{ id: 'p', repos: [p.userDir] }] });
    await config.set('workspace', { items: [{ id: 'p', repos: [p.sneaky] }] });
    await assert.rejects(p.publish(), { code: 'PermissionDenied' });
  } finally {
    await p.k.unload();
    p.ws.close();
  }
});
