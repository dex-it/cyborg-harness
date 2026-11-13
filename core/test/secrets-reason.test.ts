// TR-04: хранилище секретов недоступно - причина словами человека в отказе Unavailable и в журнале строк при запуске.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { memorySecrets } from '../../testing/src/memory.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { load } from '../src/loader.ts';
import type { SecretStore } from '../src/os-gateway.ts';
import type { PluginContext } from '../src/plugin.ts';
import { inlineHosts } from '../src/transports.ts';

const REASON = 'нет хранилища паролей: запустите GNOME Keyring';

async function start(secrets: SecretStore) {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-secrets-reason-'));
  let ctx: PluginContext | undefined;
  const lines: string[] = [];
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    spawnHost: inlineHosts(async () => ({ activate: (c: PluginContext) => void (ctx = c) })),
    enabled: ['x'],
    manifests: [{ id: 'x', version: '1.0.0', engines: { cyborg: '^1' } }],
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), secrets },
    onLog: (id, message, level) => lines.push(`${id} [${level}] ${message}`),
  });
  const plugin = ctx;
  assert.ok(plugin, 'плагин активирован');
  return { k, os: plugin.os, lines, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}

test('ST-3004/1: хранилище недоступно с причиной - Unavailable называет причину, значение открытым текстом не пишется, в журнале строк запись при запуске', async () => {
  const store = { ...memorySecrets(false), unavailableReason: () => REASON };
  await using box = await start(store);
  await assert.rejects(box.os.secrets.set('token', 'секрет'), (e: unknown) => (e as { code?: string }).code === 'Unavailable' && (e as Error).message.includes(REASON));
  await assert.rejects(box.os.secrets.get('token'), { code: 'Unavailable' });
  assert.equal(store.map.size, 0);
  const line = box.lines.find((l) => l.includes('хранилище секретов недоступно'));
  assert.ok(line?.includes(REASON) && line.includes('[warn]'), box.lines.join('\n'));
  await box.k.unload();
});

test('ST-3004/1: без причины - прежний отказ «нет шифрования ОС», записи в журнале при запуске нет и проба доступности не зовётся', async () => {
  let probed = 0;
  const store: SecretStore = { ...memorySecrets(false), available: () => (probed++, false) };
  await using box = await start(store);
  assert.equal(probed, 0, 'при запуске available() не спрашивается: на macOS это дёрнуло бы Keychain');
  assert.ok(!box.lines.some((l) => l.includes('хранилище секретов недоступно')), box.lines.join('\n'));
  await assert.rejects(box.os.secrets.get('token'), (e: unknown) => (e as { code?: string }).code === 'Unavailable' && (e as Error).message.includes('нет шифрования ОС'));
  await box.k.unload();
});

test('ST-3004/1: хранилище доступно и причины не называет - записи нет, секрет сохраняется', async () => {
  await using box = await start(memorySecrets(true));
  await box.os.secrets.set('token', 'секрет');
  assert.equal(await box.os.secrets.get('token'), 'секрет');
  assert.ok(!box.lines.some((l) => l.includes('недоступно')), box.lines.join('\n'));
  await box.k.unload();
});

test('ST-3004/1: сбой самой unavailableReason запуск не останавливает', async () => {
  const store: SecretStore = {
    ...memorySecrets(true),
    unavailableReason: () => {
      throw new Error('нет ответа');
    },
  };
  await using box = await start(store);
  await box.os.secrets.set('token', 'секрет');
  await box.k.unload();
});
