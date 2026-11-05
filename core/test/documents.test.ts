import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginContext } from '@cyborg/contracts';
import { SectionStore, type LayerStore } from '../src/config.ts';
import { load } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import { inlineHosts } from '../src/transports.ts';

const ED = { id: 'ed', version: '1.0.0', engines: { cyborg: '^1' }, documents: { note: { restorable: true }, scratch: {} } };

async function start(saved: unknown[]) {
  let doc: Record<string, unknown> = { $documents: { $version: 1, list: saved } };
  const store: LayerStore = { load: async () => structuredClone(doc), save: async (_layer, next) => void (doc = structuredClone(next)) };
  let ctx: PluginContext | undefined;
  let changes = 0;
  const k = await load({
    apiVersion: '1.0.0',
    spawnHost: inlineHosts(async () => ({
      activate: (c) => {
        ctx = c;
        return undefined;
      },
    })),
    enabled: ['ed'],
    manifests: [ED],
    state: await SectionStore.open(store, ['workspace']),
    onDocuments: () => changes++,
  });
  assert.ok(ctx);
  return { k, ctx, disk: () => (doc.$documents as { list: { id: string; type: string }[] }).list, changes: () => changes };
}

test('документы: тип с restorable переживает перезапуск, без владельца вкладка недоступна, убранный тип отсеян', async () => {
  const { k, ctx, disk, changes } = await start([
    { id: 'n1', pluginId: 'ed', type: 'note', title: 'Заметка', data: { path: 'a.md' } },
    { id: 'o1', pluginId: 'ed', type: 'old', title: 'Тип убран' },
    { id: 's0', pluginId: 'ed', type: 'scratch', title: 'Черновик без restorable' },
    { id: 'g1', pluginId: 'ghost', type: 'x', title: 'Плагина нет' },
    { id: 'n1', pluginId: 'ed', type: 'note', title: 'Повтор id' },
    { pluginId: 'ed', type: 'note', title: 'Без id' },
  ]);
  assert.deepEqual(await ctx.documents.list(), [{ id: 'n1', type: 'note', title: 'Заметка', data: { path: 'a.md' } }]);
  const note = await ctx.documents.open('note', { title: 'Вторая', data: { path: 'b.md' } });
  const scratch = await ctx.documents.open('scratch', { title: 'Черновик' });
  assert.deepEqual(
    k.documents.map((d) => [d.id === note ? 'note' : d.id === scratch ? 'scratch' : d.id, d.pluginId, d.available]),
    [['n1', 'ed', true], ['g1', 'ghost', false], ['note', 'ed', true], ['scratch', 'ed', true]],
    'порядок окна - порядок открытия, сохранённые впереди',
  );
  assert.deepEqual(disk().map((d) => (d.id === note ? 'note' : d.id)), ['n1', 'g1', 'note'], 'на диск - только restorable и строки без владельца');
  assert.ok(changes() >= 2);

  await ctx.documents.save(note, { title: 'Переименована' });
  assert.deepEqual((await ctx.documents.list()).find((d) => d.id === note), { id: note, type: 'note', title: 'Переименована', data: { path: 'b.md' } }, 'не названное поле не тронуто');
  await ctx.documents.save(note, { data: undefined });
  assert.deepEqual((await ctx.documents.list()).find((d) => d.id === note), { id: note, type: 'note', title: 'Переименована' }, 'data: undefined - забыть');
  await k.unload();
});

test('документы: отказы - чужой и незнакомый документ, необъявленный тип, title и размер данных', async () => {
  const { k, ctx } = await start([{ id: 'g1', pluginId: 'ghost', type: 'x', title: 'Чужой' }]);
  await assert.rejects(ctx.documents.open('nope', { title: 'X' }), { code: 'NotDeclared' });
  await assert.rejects(ctx.documents.open('note', { title: ' ' }), { code: 'Invalid' });
  await assert.rejects(ctx.documents.open('note', { title: 'x'.repeat(201) }), { code: 'Invalid' });
  await assert.rejects(ctx.documents.open('note', { title: 'X', data: 'x'.repeat(64 * 1024) }), /больше 65536 байт/);
  await assert.rejects(ctx.documents.open('note', { title: 'X', extra: 1 } as never), /нет поля extra/);
  await assert.rejects(ctx.documents.save('g1', { title: 'Моё' }), { code: 'NotFound' }, 'чужой документ для плагина не существует');
  await assert.rejects(ctx.documents.close('нет'), { code: 'NotFound' });
  assert.deepEqual(await ctx.documents.list(), []);
  await k.unload();
});

test('документы: человек закрывает вкладку - владелец получает onClose; выгруженный владелец - вкладка недоступна', async () => {
  const { k, ctx, disk } = await start([]);
  const closed: string[] = [];
  ctx.documents.onClose((id) => closed.push(id));
  const a = await ctx.documents.open('note', { title: 'A' });
  const b = await ctx.documents.open('note', { title: 'B' });
  await k.closeDocument(a);
  await k.idle();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [a]);
  assert.deepEqual(disk().map((d) => d.id), [b]);
  await assert.rejects(k.closeDocument(a), { code: 'NotFound' });
  await k.disable('ed');
  assert.deepEqual(k.documents.map((d) => [d.id, d.available]), [[b, false]], 'выключенный владелец не теряет вкладку');
  await k.closeDocument(b);
  assert.deepEqual(k.documents, []);
  await k.unload();
});

test('манифест: documents - имя типа и только restorable', () => {
  const r = (documents: unknown) => parseManifest({ ...ED, documents });
  const ok = r({ note: { restorable: true }, plain: {} });
  assert.ok(ok.ok);
  assert.deepEqual(ok.manifest.documents, { note: { restorable: true }, plain: { restorable: false } });
  for (const bad of [{}, [], { Note: {} }, { note: { restorable: 'да' } }, { note: { title: 'x' } }, { note: true }]) assert.equal(r(bad).ok, false, JSON.stringify(bad));
});
