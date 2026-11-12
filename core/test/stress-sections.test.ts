import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PluginContext } from '@cyborg-harness/contracts';
import { memoryStore as memory } from '../../testing/src/memory.ts';
import { resolveSection, SectionStore } from '../src/config.ts';
import { load } from '../src/loader.ts';
import { inlineHosts } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

test('stress-sections: setViewState и documents.open одновременно - оба раздела ядра остаются в state', async () => {
  const { docs, store } = memory();
  let ctx!: PluginContext;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ activate: (c) => void (ctx = c) })),
    enabled: ['own'],
    manifests: [{ id: 'own', version: '1.0.0', engines: { cyborg: '^1' }, ui: { views: { main: './ui.js' } }, documents: { note: { restorable: true } } }],
    state: await SectionStore.open(store, ['workspace']),
  });
  await Promise.all([k.setViewState('own', 'main', { a: 1 }), ctx.documents.open('note', { title: 'n' })]);
  await k.idle();
  const saved = docs.get('workspace') ?? {};
  assert.ok(saved.$views, 'память вида записана');
  assert.ok(saved.$documents, 'таблица документов записана');
  await k.unload();
});

test('ST-5004/7: stress-sections: config.set в два слоя одновременно - значение раздела в плагине сливает оба слоя', async () => {
  const { docs, store } = memory();
  let ctx!: PluginContext;
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ config: { defaults: { a: 0, b: 0 } }, activate: (c) => void (ctx = c) })),
    enabled: ['p'],
    manifests: [{ id: 'p', version: '1.0.0', engines: { cyborg: '^1' }, config: { version: 1 } }],
    config: await SectionStore.open(store, ['user', 'workspace']),
  });
  assert.ok(ctx.config);
  await Promise.all([ctx.config.set('user', { a: 1 }), ctx.config.set('workspace', { b: 2 })]);
  assert.deepEqual(docs.get('user')?.p, { $version: 1, a: 1 });
  assert.deepEqual(docs.get('workspace')?.p, { $version: 1, b: 2 });
  assert.deepEqual(ctx.config.get(), { a: 1, b: 2 }, 'значение в плагине соответствует слоям на диске');
  await k.unload();
});

test('ST-5004/4: stress-sections: migrate бросает не Error - причина читаема, а не undefined', () => {
  const r = resolveSection(
    {
      version: 2,
      migrate: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- проверяется именно миграция, бросающая не Error
        throw 'старый формат битый';
      },
    },
    [['user', { $version: 1 }]],
  );
  assert.equal(r.result.status, 'migrate-error');
  assert.equal(typeof (r.result as { error: unknown }).error, 'string');
  assert.match(String((r.result as { error: unknown }).error), /старый формат битый/);
});

test('ST-5004/7: stress-sections: 400 последовательных записей в 8 разделов - на диске последнее значение каждого', async () => {
  const { docs, store } = memory();
  const s = await SectionStore.open(store, ['workspace']);
  for (let round = 0; round < 50; round++) {
    for (let i = 0; i < 8; i++) await s.write('workspace', `p${String(i)}`, 1, { round });
  }
  assert.equal(Object.keys(docs.get('workspace') ?? {}).length, 8);
  for (let i = 0; i < 8; i++) assert.deepEqual(docs.get('workspace')?.[`p${String(i)}`], { $version: 1, round: 49 });
  await sleep(0);
});
