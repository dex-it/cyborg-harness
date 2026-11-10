import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore as memory } from '../../testing/src/memory.ts';
import { deepMerge, resolveSection, SectionStore } from '../src/config.ts';

test('слияние: объекты по ключам, массивы целиком', () => {
  assert.deepEqual(deepMerge({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] }), { a: { x: 1, y: 3 }, list: [9] });
});

test('воркспейс перекрывает пользователя поверх defaults', () => {
  const { result } = resolveSection({ version: 1, defaults: { idleMinutes: 10, keys: ['Mod+L'] } }, [
    ['user', { $version: 1, idleMinutes: 5 }],
    ['workspace', { $version: 1, keys: ['Mod+Shift+L'] }],
  ]);
  assert.deepEqual(result, { status: 'ok', value: { idleMinutes: 5, keys: ['Mod+Shift+L'] }, migrated: [] });
});

test('каждый слой мигрирует от своей версии', () => {
  const seen: number[] = [];
  const { result, layers } = resolveSection(
    {
      version: 3,
      migrate(from, data) {
        seen.push(from);
        let d = data;
        if (from < 2) d = { ...d, minutes: d.idle, idle: undefined };
        if (from < 3) d = { ...d, locked: false };
        return d;
      },
    },
    [
      ['user', { $version: 1, idle: 5 }],
      ['workspace', { $version: 2, minutes: 7 }],
    ],
  );
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(layers.get('user'), { minutes: 5, idle: undefined, locked: false });
  assert.deepEqual(result.migrated, ['user', 'workspace']);
});

test('слой новее манифеста - откат версии, раздел не читается', () => {
  const { result } = resolveSection({ version: 2, migrate: () => ({}) }, [['user', { $version: 3 }]]);
  assert.deepEqual(result, { status: 'newer', layer: 'user', found: 3, expected: 2 });
});

test('сбой migrate и отказ validate различаются', () => {
  const failing = resolveSection({ version: 2, migrate: () => { throw new Error('нет поля'); } }, [['user', {}]]);
  assert.deepEqual(failing.result, { status: 'migrate-error', layer: 'user', from: 1, error: 'нет поля' });
  const invalid = resolveSection({ version: 1, validate: (v) => (typeof v.n === 'number' ? [] : ['n не число']) }, [['user', { n: 'x' }]]);
  assert.deepEqual(invalid.result, { status: 'invalid', errors: ['n не число'] });
});

test('хранилище: мигрированный слой записывается сразу, чужие разделы не трогаются', async () => {
  const { store, docs, saves } = memory({ user: { other: { $version: 9, keep: true }, 'pin-lock': { $version: 1, idle: 5 } } });
  const s = await SectionStore.open(store, ['user', 'workspace']);
  const h = await s.section('pin-lock', { version: 2, migrate: (_, d) => ({ minutes: d.idle }) });
  assert.deepEqual(h.get(), { minutes: 5 });
  assert.deepEqual(saves, ['user']);
  assert.deepEqual(docs.get('user'), { other: { $version: 9, keep: true }, 'pin-lock': { $version: 2, minutes: 5 } });
});

test('хранилище: set пишет слой, уведомляет и возвращает слитое значение', async () => {
  const { store, docs } = memory({ user: { 'pin-lock': { $version: 1, minutes: 5, sound: true } } });
  const s = await SectionStore.open(store, ['user', 'workspace']);
  const h = await s.section('pin-lock', { version: 1, defaults: { minutes: 10 } });
  const seen: unknown[] = [];
  h.onChange((v) => seen.push(v));
  const value = await h.set('workspace', { minutes: 1 });
  assert.deepEqual(value, { minutes: 1, sound: true });
  assert.deepEqual(seen, [value]);
  assert.deepEqual(docs.get('workspace'), { 'pin-lock': { $version: 1, minutes: 1 } });
  await assert.rejects(h.set('machine', {}), /слоя machine нет/);
});

test('хранилище: remove стирает раздел слоя, чужие разделы целы, нет раздела - нет и записи', async () => {
  const { store, docs, saves } = memory({ workspace: { gone: { $version: 1, n: 1 }, keep: { $version: 1, n: 2 } }, user: { gone: { $version: 1, n: 3 } } });
  const s = await SectionStore.open(store, ['user', 'workspace']);
  assert.equal(await s.remove('workspace', 'gone'), true);
  assert.deepEqual(docs.get('workspace'), { keep: { $version: 1, n: 2 } });
  assert.deepEqual(docs.get('user'), { gone: { $version: 1, n: 3 } }, 'другой слой не тронут');
  assert.deepEqual(s.raw('gone'), [['user', { $version: 1, n: 3 }], ['workspace', undefined]], 'память отстала от файла');
  assert.equal(await s.remove('workspace', 'gone'), false);
  assert.deepEqual(saves, ['workspace'], 'второй remove ничего не писал');
  await assert.rejects(s.remove('machine', 'gone'), /слоя machine нет/);
});

test('хранилище: remove берёт основу из файла, а не из памяти: правка извне не стирается', async () => {
  const { store, docs } = memory({ workspace: { gone: { $version: 1 } } });
  const s = await SectionStore.open(store, ['workspace']);
  docs.set('workspace', { gone: { $version: 1 }, outside: { $version: 1, by: 'человек' } });
  assert.equal(await s.remove('workspace', 'gone'), true);
  assert.deepEqual(docs.get('workspace'), { outside: { $version: 1, by: 'человек' } });
});

test('хранилище: remove отдаёт стирание методу remove хранилища (под его замком), а не load и save', async () => {
  const { store, docs, saves } = memory({ user: { gone: { $version: 1 }, keep: { $version: 1 } } });
  const calls: string[] = [];
  const s = await SectionStore.open(
    {
      ...store,
      remove: async (layer, id) => {
        calls.push(`${layer}/${id}`);
        const { [id]: gone, ...rest } = docs.get(layer) ?? {};
        docs.set(layer, rest);
        return gone !== undefined;
      },
    },
    ['user'],
  );
  assert.equal(await s.remove('user', 'gone'), true);
  assert.equal(await s.remove('user', 'gone'), false);
  assert.deepEqual(calls, ['user/gone', 'user/gone']);
  assert.deepEqual(saves, [], 'save не вызывался');
  assert.deepEqual(s.raw('gone'), [['user', undefined]], 'память догнала файл');
  assert.deepEqual(docs.get('user'), { keep: { $version: 1 } });
});
