import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { claimInstance, instanceAddress, neighborInstances, type Claim } from '../src/instance.ts';
import { load } from '../src/loader.ts';
import type { Kernel } from '../src/kernel-types.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

// #154 (K-20): Kernel.uninstall отказывает, пока плагин может работать в соседнем окне того же userData. Два экземпляра - два ядра на общих plugin-data и plugin-temp,
// у каждого свой адрес в каталоге адресов; соседей находит neighborInstances по этим адресам, а плагины соседа называет его владелец по запросу.

const posix = process.platform !== 'win32';
const manifest = (id: string, lazy = false) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'fs.read': ['plugin-data'], 'fs.write': ['plugin-data'] }, ...(lazy && { activation: 'lazy', commands: { [`${id}.hello`]: {} } }) });

async function sandbox() {
  // Короткий путь: адрес сокета unix ограничен ~104 байтами.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'cn-')));
  const sockets = path.join(root, 's');
  await mkdir(sockets);
  const shared = { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') };
  const open: { k: Kernel; claim: Extract<Claim, { kind: 'owner' }> }[] = [];

  /** Окно воркспейса `key`: ядро с плагинами `ids` на общем userData и адрес владельца с перечнем `Kernel.working`. */
  async function window(key: string, ids: readonly string[], options: { neighbors?: boolean; safeMode?: boolean; lazy?: readonly string[] } = {}) {
    const contexts = new Map<string, PluginContext>();
    const self: { kernel?: Kernel } = {};
    const claim = await claimInstance(key, {}, () => undefined, { dir: sockets, plugins: () => self.kernel?.working ?? [] });
    assert.equal(claim.kind, 'owner');
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      spawnHost: inlineHosts(async (entry) => ({ state: { defaults: {} }, config: { defaults: {} }, activate: (c: PluginContext) => void contexts.set(entry, c) })),
      enabled: ids,
      manifests: ids.map((id) => manifest(id, options.lazy?.includes(id))),
      ...(options.safeMode && { safeMode: true }),
      os: shared,
      ...(options.neighbors !== false && { neighbors: () => neighborInstances(key, { dir: sockets, timeoutMs: 300 }) }),
    });
    self.kernel = kernel;
    open.push({ k: kernel, claim });
    const write = async (id: string) => {
      const c = contexts.get(id);
      assert.ok(c, `${id} не активирован в ${key}`);
      await c.os.fs.writeText(path.join(c.os.paths.data, 'note.txt'), `данные ${key}`);
    };
    return { k: kernel, claim, write };
  }

  return {
    root,
    sockets,
    shared,
    window,
    [Symbol.asyncDispose]: async () => {
      for (const { k, claim } of open) {
        await k.unload().catch(() => undefined);
        claim.close();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const dataOf = (box: { shared: { dataDir: string } }) => readdir(box.shared.dataDir).catch(() => []);

test('uninstall: плагин активен в соседнем окне - отказ с названием окна, ничего не стёрто; после выгрузки там проходит', { skip: !posix }, async () => {
  await using box = await sandbox();
  const a = await box.window(A, ['jira']);
  const b = await box.window(B, ['jira']);
  await a.write('jira');
  await a.k.disable('jira');

  await assert.rejects(a.k.uninstall('jira'), (error: Error & { code?: string }) => error.code === 'Invalid' && error.message.includes(B) && error.message.includes('соседнем окне') && error.message.includes('ничего не стёрто'));
  assert.deepEqual(await dataOf(box), ['jira'], 'данные плагина целы: отказ идёт до стирания');
  assert.equal(a.k.journal.some((e) => e.kind === 'uninstalled'), false, 'отказ не пишет uninstalled');

  await b.k.disable('jira');
  const report = await a.k.uninstall('jira');
  assert.deepEqual(report.erased.slice(0, 2), ['данные плагина (plugin-data)', 'временные файлы (plugin-temp)']);
  assert.deepEqual(await dataOf(box), []);
  assert.equal(report.left.some((line) => line.includes('соседнем окне')), false, 'соседние окна проверены: оговорки в left нет');
});

test('uninstall: сосед выгрузил ядро целиком - плагин там не работает, проходит; плагин соседа, которого в этом воркспейсе нет, не мешает', { skip: !posix }, async () => {
  await using box = await sandbox();
  const a = await box.window(A, ['jira']);
  const b = await box.window(B, ['jira', 'other']);
  await a.k.disable('jira');
  await assert.rejects(a.k.uninstall('other'), { code: 'Invalid' }, 'other у соседа работает, хотя здесь его нет');
  await b.k.unload();
  b.claim.close();
  await a.k.uninstall('jira');
  await a.k.uninstall('other');
});

test('uninstall: плагин соседа, ждущий первого обращения или не выключенный, тоже может работать - отказ; выключенный человеком там - проходит', { skip: !posix }, async () => {
  await using box = await sandbox();
  const a = await box.window(A, ['jira', 'later']);
  const b = await box.window(B, ['jira', 'later'], { lazy: ['later'] });
  await a.k.disable('jira');
  await a.k.disable('later');
  assert.deepEqual([...b.k.working].sort(), ['jira', 'later']);
  assert.deepEqual(b.k.active, ['jira'], 'later у соседа ещё не запущен: ждёт первого обращения');
  await assert.rejects(a.k.uninstall('later'), { code: 'Invalid' }, 'ждущий запуска плагин вернётся сам при первом обращении и пересоздал бы стёртое');
  await b.k.disable('later');
  assert.deepEqual(b.k.working, ['jira'], 'выключенный человеком плагин не считается работающим');
  await a.k.uninstall('later');
});

test('uninstall: сосед жив, но не ответил в срок - отказ Unavailable, ничего не стёрто; мёртвый адрес (файл от убитого процесса) не сосед', { skip: !posix }, async () => {
  await using box = await sandbox();
  const a = await box.window(A, ['jira']);
  await a.write('jira');
  await a.k.disable('jira');
  // Мёртвый адрес: файл, к которому никто не подключается.
  await writeFile(instanceAddress('cccccccccccccccc', box.sockets), '');
  await a.k.uninstall('jira');

  const mute = net.createServer(() => undefined);
  await new Promise<void>((resolve) => mute.listen(instanceAddress(B, box.sockets), resolve));
  try {
    const again = await box.window('dddddddddddddddd', ['jira']);
    await again.k.disable('jira');
    await assert.rejects(again.k.uninstall('jira'), (error: Error & { code?: string }) => error.code === 'Unavailable' && error.message.includes(B) && error.message.includes('ничего не стёрто'));
  } finally {
    mute.close();
  }
});

test('uninstall: проверка соседей бросила - Unavailable, ничего не стёрто; без neighbors ядро о соседях молчит и left это называет', async () => {
  await using box = await sandbox();
  const contexts = new Map<string, PluginContext>();
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({ state: { defaults: {} }, config: { defaults: {} }, activate: (c: PluginContext) => void contexts.set(entry, c) })),
    enabled: ['jira'],
    manifests: [manifest('jira')],
    os: box.shared,
    neighbors: () => Promise.reject(new Error('каталог адресов недоступен')),
  });
  const c = contexts.get('jira');
  assert.ok(c);
  await c.os.fs.writeText(path.join(c.os.paths.data, 'note.txt'), 'x');
  await k.disable('jira');
  await assert.rejects(k.uninstall('jira'), (error: Error & { code?: string }) => error.code === 'Unavailable' && error.message.includes('каталог адресов недоступен') && error.message.includes('ничего не стёрто'));
  assert.deepEqual(await dataOf(box), ['jira']);
  await k.unload();

  const silent = await box.window(A, ['jira'], { neighbors: false });
  await silent.k.disable('jira');
  const report = await silent.k.uninstall('jira');
  assert.ok(report.left.some((line) => line.includes('соседнем окне') && line.includes('neighbors')), 'без neighbors оговорка о соседях остаётся в left');
});

test('Kernel.working: активные и ждущие запуска, без выключенных; в безопасном режиме пусто', async () => {
  await using box = await sandbox();
  const a = await box.window(A, ['jira', 'other']);
  assert.deepEqual([...a.k.working].sort(), ['jira', 'other']);
  await a.k.disable('other');
  assert.deepEqual(a.k.working, ['jira']);
  const safe = await box.window(B, ['jira'], { safeMode: true });
  assert.deepEqual(safe.k.working, []);
});
