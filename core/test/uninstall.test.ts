import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { load } from '../src/loader.ts';
import type { SecretStore } from '../src/os-gateway.ts';
import { describeEntry, entryLevel, pluginStatuses } from '../src/status.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// K-10: Kernel.uninstall стирает всё, что привязано к id плагина, чтобы новый плагин с тем же id не унаследовал чужое.

const manifest = (id: string, extra: object = {}) => ({
  id,
  version: '1.0.0',
  engines: { cyborg: '^1' },
  permissions: { 'fs.read': ['granted'] },
  ui: { views: { main: './ui.js' } },
  documents: { note: { restorable: true } },
  state: { version: 1 },
  config: { version: 1 },
  ...extra,
});

function memorySecrets(): SecretStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const deletePrefix = async (prefix: string) => {
    const keys = [...map.keys()].filter((k) => k.startsWith(prefix));
    for (const k of keys) map.delete(k);
    return keys.length;
  };
  return { map, available: () => true, get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v), delete: async (k) => void map.delete(k), deletePrefix };
}

/** Всё, что переживает перезапуск ядра: каталоги, секреты и документы воркспейса. */
async function world() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cyborg-uninstall-')));
  const picked = path.join(root, 'picked');
  await mkdir(picked);
  await writeFile(path.join(picked, 'a.txt'), 'выбрано человеком');
  const docs: Record<'user' | 'workspace', Record<string, unknown>> = { user: {}, workspace: {} };
  const store: LayerStore = {
    load: async (layer) => structuredClone(docs[layer as 'user' | 'workspace']),
    save: async (layer, next) => void (docs[layer as 'user' | 'workspace'] = structuredClone(next)),
  };
  const secrets = memorySecrets();
  const dirs = { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') };

  async function start(plugins: readonly string[], options: { enabled?: readonly string[]; manifests?: Record<string, object> } = {}) {
    const contexts = new Map<string, PluginContext>();
    const k = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async (entry) => ({ state: { defaults: {} }, config: { defaults: {} }, activate: (c: PluginContext) => void contexts.set(entry, c) })),
      enabled: options.enabled ?? plugins,
      manifests: plugins.map((id) => manifest(id, options.manifests?.[id])),
      os: { ...dirs, secrets, dialog: { open: async () => [picked] } },
      state: await SectionStore.open(store, ['workspace']),
      config: await SectionStore.open(store, ['user', 'workspace']),
    });
    const ctx = (id: string) => {
      const c = contexts.get(id);
      assert.ok(c, `${id} не активирован`);
      return c;
    };
    return { k, ctx };
  }

  /** Плагин оставил следы во всех местах, где ядро хранит что-то по его id. */
  async function leaveTraces(k: Awaited<ReturnType<typeof start>>['k'], ctx: PluginContext) {
    const id = ctx.pluginId;
    await ctx.os.fs.writeText(path.join(ctx.os.paths.data, 'note.txt'), `данные ${id}`);
    await ctx.os.fs.writeText(path.join(ctx.os.paths.temp, 'cache.txt'), `кэш ${id}`);
    await ctx.os.secrets.set('token', `секрет ${id}`);
    await ctx.os.dialog.open({ directory: true });
    await ctx.documents.open('note', { title: `заметка ${id}`, data: { id } });
    await k.setViewState(id, 'main', { opened: id });
    await ctx.state?.set('workspace', { memory: id });
    await ctx.config?.set('user', { theme: id });
  }

  return {
    root,
    picked,
    docs,
    secrets,
    dirs,
    start,
    leaveTraces,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  };
}

const ownTree = async (dir: string) => readdir(dir).catch(() => []);
const byPlugin = (docs: Record<string, unknown>) => (docs.$granted as { byPlugin: Record<string, string[]> } | undefined)?.byPlugin ?? {};

test('uninstall: файлы, секреты, granted, память видов, документы и state плагина стёрты; config остаётся; чужое цело; в журнале список словами', async () => {
  await using w = await world();
  const { k, ctx } = await w.start(['jira', 'other']);
  for (const id of ['jira', 'other']) await w.leaveTraces(k, ctx(id));
  await k.idle();
  assert.deepEqual([...w.secrets.map.keys()].sort(), ['jira/token', 'other/token']);

  await k.disable('jira');
  const report = await k.uninstall('jira');

  assert.deepEqual(report.erased, [
    'данные плагина (plugin-data)',
    'временные файлы (plugin-temp)',
    'секреты: 1',
    'выбранные человеком пути (granted): 1',
    'память видов: 1',
    'документы: 1',
    'состояние (state) воркспейса',
  ]);
  assert.deepEqual(report.left, [
    'настройки (config) в файлах пользователя и воркспейса: их правит человек',
    'state, память видов, документы и выбранные пути в других воркспейсах: ядро знает только текущий',
    'код плагина на диске: его убирает приложение',
  ]);
  assert.equal(report.pluginId, 'jira');

  assert.deepEqual(await ownTree(w.dirs.dataDir), ['other']);
  assert.deepEqual(await ownTree(w.dirs.tempDir), ['other']);
  assert.deepEqual([...w.secrets.map.keys()], ['other/token']);
  assert.deepEqual(Object.keys(byPlugin(w.docs.workspace)), ['other']);
  assert.deepEqual(Object.keys(w.docs.workspace.$views as object).sort(), ['$version', 'other/main']);
  assert.deepEqual((w.docs.workspace.$documents as { list: { pluginId: string }[] }).list.map((d) => d.pluginId), ['other']);
  assert.equal('jira' in w.docs.workspace, false, 'раздел state плагина стёрт');
  assert.deepEqual(w.docs.workspace.other, { $version: 1, memory: 'other' });
  assert.deepEqual(w.docs.user.jira, { $version: 1, theme: 'jira' }, 'config остаётся в файле пользователя');
  assert.deepEqual(k.documents.map((d) => d.pluginId), ['other'], 'окно видит уже без строк плагина');

  const entry = k.journal.findLast((e) => e.kind === 'uninstalled');
  assert.deepEqual(entry, { pluginId: 'jira', kind: 'uninstalled', erased: report.erased, left: report.left });
  assert.ok(entry);
  assert.match(describeEntry(entry), /^удалён; стёрто: данные плагина \(plugin-data\), .*документы: 1, состояние \(state\) воркспейса; осталось: настройки \(config\)/);
  assert.equal(entryLevel(entry), 'info');
  assert.equal(pluginStatuses(k.journal).find((s) => s.id === 'jira')?.revivable, false, 'удалённый плагин «включить снова» не предлагает');
  await k.unload();
});

test('uninstall: новый плагин с тем же id ничего не наследует: ни каталогов, ни секретов, ни выбранных путей, ни документов, ни памяти видов, ни state', async () => {
  await using w = await world();
  const first = await w.start(['jira']);
  await w.leaveTraces(first.k, first.ctx('jira'));
  await first.k.disable('jira');
  await first.k.uninstall('jira');
  await first.k.unload();

  const second = await w.start(['jira']);
  const jira = second.ctx('jira');
  assert.deepEqual(await jira.os.fs.list(jira.os.paths.data), []);
  assert.deepEqual(await jira.os.fs.list(jira.os.paths.temp), []);
  assert.equal(await jira.os.secrets.get('token'), undefined);
  await assert.rejects(jira.os.fs.readText(path.join(w.picked, 'a.txt')), { code: 'PermissionDenied' }, 'выбор человека не пережил удаление');
  assert.deepEqual(await jira.documents.list(), []);
  assert.deepEqual(second.k.documents, []);
  assert.equal(second.k.viewState('jira', 'main'), undefined);
  assert.deepEqual(jira.state?.get(), {});
  await second.k.unload();
});

test('uninstall: активный плагин - отказ, ничего не стёрто; после disable проходит', async () => {
  await using w = await world();
  const { k, ctx } = await w.start(['jira']);
  await w.leaveTraces(k, ctx('jira'));
  await assert.rejects(k.uninstall('jira'), { code: 'Invalid', message: /сначала disable/ });
  assert.deepEqual(w.secrets.map.size, 1);
  assert.deepEqual(await ownTree(w.dirs.dataDir), ['jira']);
  assert.equal(k.journal.some((e) => e.kind === 'uninstalled'), false, 'отказ в журнал не пишется как удаление');
  assert.deepEqual(k.active, ['jira']);

  await k.disable('jira');
  await k.uninstall('jira');
  assert.equal(w.secrets.map.size, 0);
  await k.unload();
});

test('uninstall: плагин, не включённый в настройках, и плагин, которого нет среди манифестов, чистятся без disable', async () => {
  await using w = await world();
  const first = await w.start(['jira', 'ghost']);
  for (const id of ['jira', 'ghost']) await w.leaveTraces(first.k, first.ctx(id));
  await first.k.unload();

  // jira отключён в plugins.enabled, ghost убрали с диска: оба в графе не участвуют.
  const second = await w.start(['jira'], { enabled: [] });
  assert.deepEqual(second.k.active, []);
  assert.equal((await second.k.uninstall('jira')).erased.includes('секреты: 1'), true);
  assert.equal((await second.k.uninstall('ghost')).erased.includes('документы: 1'), true);
  assert.deepEqual(await ownTree(w.dirs.dataDir), []);
  assert.equal(w.secrets.map.size, 0);
  assert.deepEqual((w.docs.workspace.$documents as { list: unknown[] }).list, []);
  assert.deepEqual(byPlugin(w.docs.workspace), {});
  await second.k.unload();
});

test('uninstall: сбой одного шага не останавливает остальные, ошибка названа и записана; повтор доделывает', async () => {
  await using w = await world();
  const { k, ctx } = await w.start(['jira']);
  await w.leaveTraces(k, ctx('jira'));
  await k.disable('jira');

  const deletePrefix = w.secrets.deletePrefix.bind(w.secrets);
  w.secrets.deletePrefix = async () => {
    throw new Error('связка ключей занята');
  };
  await assert.rejects(k.uninstall('jira'), { code: 'Unavailable', message: /секреты: связка ключей занята.*стёрто: данные плагина/s });
  assert.deepEqual(await ownTree(w.dirs.dataDir), [], 'файлы стёрты, хотя секреты не ушли');
  assert.equal(w.secrets.map.size, 1);
  const failed = k.journal.findLast((e) => e.kind === 'uninstalled');
  assert.ok(failed?.kind === 'uninstalled');
  assert.match(failed.error ?? '', /секреты: связка ключей занята/);
  assert.equal(entryLevel(failed), 'error');
  assert.match(describeEntry(failed), /; осталось: .*; не удалось: секреты: связка ключей занята$/);

  w.secrets.deletePrefix = deletePrefix;
  const report = await k.uninstall('jira');
  assert.equal(w.secrets.map.size, 0);
  assert.ok(report.erased.includes('секреты: 1'));
  await k.unload();
});

test('uninstall: ядро выгружено - Unavailable', async () => {
  await using w = await world();
  const { k } = await w.start(['jira']);
  await k.disable('jira');
  await k.unload();
  await assert.rejects(k.uninstall('jira'), { code: 'Unavailable', message: /выгружается/ });
});
