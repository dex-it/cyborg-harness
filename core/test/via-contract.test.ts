import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

const base = { version: '1.0.0', engines: { cyborg: '^1' } };

test('манифест: guard у provides - право вызывающего на аргумент члена, ошибки собираются', () => {
  const ok = parseManifest({ ...base, id: 'files', provides: { 'test.guarded': { version: ['1.0', '2.1'], guard: { read: { 'fs.read': 0 }, open: { 'fs.read': '0.path', 'secrets.ref': 1 } } } } });
  assert.ok(ok.ok);
  assert.deepEqual(ok.manifest.provides, { 'test.guarded': ['1.0', '2.1'] });
  assert.deepEqual(ok.manifest.guards, {
    'test.guarded': {
      read: [{ right: 'fs.read', arg: 0 }],
      open: [
        { right: 'fs.read', arg: 0, field: 'path' },
        { right: 'secrets.ref', arg: 1 },
      ],
    },
  });
  const plain = parseManifest({ ...base, id: 'plain', provides: { 'test.guarded': '1.0' } });
  assert.ok(plain.ok);
  assert.equal(plain.manifest.guards, undefined);

  const bad = parseManifest({
    ...base,
    id: 'bad',
    provides: { 'test.guarded': { version: '1.0', guard: { read: { process: 0 }, open: { 'fs.read': -1 }, list: { 'fs.write': '0.a.b' }, stat: {} }, extra: 1 } },
  });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors, [
    'provides.test.guarded.extra: неизвестное поле',
    'provides.test.guarded.guard.read.process: право не для аргумента - допустимы fs.read, fs.write, shell, secrets.ref',
    'provides.test.guarded.guard.open.fs.read: ожидается номер аргумента или "номер.поле"',
    'provides.test.guarded.guard.list.fs.write: ожидается номер аргумента или "номер.поле"',
    'provides.test.guarded.guard.stat: ожидается { право: номер аргумента или "номер.поле" }',
  ]);
});

/** files читает по праву на work и объявляет: путь аргумента должен быть в fs.read вызывающего. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-via-'));
  const work = path.join(root, 'work');
  await mkdir(work, { recursive: true });
  const file = path.join(work, 'readme.md');
  await writeFile(file, 'можно');
  const contexts = new Map<string, PluginContext>();
  const consumer = (id: string, permissions: Record<string, unknown> = {}) => ({ ...base, id, requires: { 'test.guarded': '^1' }, permissions });
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async (entry) => ({
      activate: (ctx: PluginContext) => {
        contexts.set(entry, ctx);
        if (entry === 'files') {
          ctx.contracts.provide('test.guarded', '1.0', {
            read: (p) => ctx.os.fs.readText(p),
            open: (spec) => ctx.os.fs.readText(spec.path),
            size: (p) => ctx.os.fs.stat(p).then((st) => st.size),
          });
        }
      },
    })),
    enabled: ['files', 'trusted', 'nosy'],
    manifests: [
      { ...base, id: 'files', provides: { 'test.guarded': { version: '1.0', guard: { read: { 'fs.read': 0 }, open: { 'fs.read': '0.path' } } } }, permissions: { 'fs.read': [work] } },
      consumer('trusted', { 'fs.read': [work] }),
      consumer('nosy'),
    ],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') },
  });
  const files = (id: string) => contexts.get(id)!.contracts.get('test.guarded', 1)!;
  const denied = () => k.journal.flatMap((e) => (e.kind === 'denied' ? [{ pluginId: e.pluginId, method: e.method, reason: e.reason }] : []));
  const dispose = async () => {
    await k.unload();
    await rm(root, { recursive: true, force: true });
  };
  return { k, root, work, file, files, denied, contexts, [Symbol.asyncDispose]: dispose };
}

test('via-contract: вызывающий без права на путь не читает его руками поставщика, и отказ - в журнале с причиной', async () => {
  await using s = await setup();
  assert.equal(await s.files('trusted').read(s.file), 'можно');
  await assert.rejects(s.files('nosy').read(s.file), { code: 'PermissionDenied' });
  await assert.rejects(s.files('nosy').open({ path: s.file }), { code: 'PermissionDenied' }, 'путь в поле объекта');
  assert.deepEqual(s.denied(), [
    { pluginId: 'nosy', method: 'test.guarded.read', reason: 'via-contract' },
    { pluginId: 'nosy', method: 'test.guarded.open', reason: 'via-contract' },
  ]);
  // Член без guard ядро не проверяет: защищает себя поставщик, объявляя то, что делает по чужой просьбе.
  assert.equal(await s.files('nosy').size(s.file), Buffer.byteLength('можно'));
});

test('via-contract: право вызывающего не расширяет поставщика, аргумент не строкой - отказ, а не пропуск', async () => {
  await using s = await setup();
  const own = path.join(s.contexts.get('nosy')!.os.paths.data, 'note.txt');
  await s.contexts.get('nosy')!.os.fs.writeText(own, 'своё');
  await assert.rejects(s.files('nosy').read(own), { code: 'PermissionDenied' }, 'у files нет права на каталог nosy');
  assert.deepEqual(s.denied().map((d) => `${d.pluginId}:${d.reason ?? '-'}`), ['files:-']);
  await assert.rejects(s.files('trusted').open({ path: [s.file] } as never), { code: 'Invalid' });
  await assert.rejects(s.files('trusted').read(42 as never), { code: 'Invalid' });
});

test('via-contract: вызов из вида (callAs) проходит ту же проверку, что из главной части', async () => {
  await using s = await setup();
  assert.equal(await s.k.callAs('trusted', 'test.guarded', 1, 'read', [s.file]), 'можно');
  await assert.rejects(s.k.callAs('nosy', 'test.guarded', 1, 'open', [{ path: s.file }]), { code: 'PermissionDenied' });
  await assert.rejects(s.k.callAs('nosy', 'test.guarded', 1, 'constructor', []), { code: 'Invalid' });
  await assert.rejects(s.k.callAs('files', 'test.guarded', 1, 'read', [s.file]), { code: 'NotDeclared' }, 'вид без контракта в манифесте');
  assert.deepEqual(s.denied(), [{ pluginId: 'nosy', method: 'test.guarded.open', reason: 'via-contract' }]);
});
