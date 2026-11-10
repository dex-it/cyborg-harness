import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
async function web(layers: { user?: Record<string, unknown>; workspace?: Record<string, unknown> }, root: string) {
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
    manifests: [manifest('web', { permissions: { net: ['config:baseUrl'] }, config: { version: 1 } })],
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
