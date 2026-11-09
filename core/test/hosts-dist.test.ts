import assert from 'node:assert/strict';
import { test } from 'node:test';
// Вариант hosts.test.ts на собранном пакете: ядро берётся по имени (workspace -> exports -> core/dist), а не из core/src.
import { forkHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';

test('собранный пакет: forkHosts находит host-entry.js, вызов идёт в другой процесс', async () => {
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['files', 'consumer'],
    manifests: [
      { id: 'files', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'test.files': '1.0' } },
      { id: 'consumer', version: '1.0.0', engines: { cyborg: '^1' }, optional: { 'test.files': '^1' }, commands: { 'consumer.call': { args: ['string'], rest: 'any' }, 'consumer.state': {} } },
    ],
    hosts: { storage: ['files'], ui: ['consumer'] },
    spawnHost: forkHosts({ silent: true }),
    entry: (m) => new URL(`./fixtures/${m.id}.ts`, import.meta.url).href,
  });
  try {
    assert.equal(await k.run('consumer.call', 'read', 'a.txt'), 'data:a.txt');
    await assert.rejects(k.run('consumer.call', 'fail'), { code: 'Remote', message: 'нет файла' });
    const state = (await k.run('consumer.state')) as { pid: number };
    assert.notEqual(state.pid, process.pid);
  } finally {
    await k.unload();
  }
});
