import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { trustFromArgv } from './trust-args.ts';

// TR-11, TR-12: стенд включает проверку пакетов только командной строкой.
test('ST-3009/5: trustFromArgv: без флагов проверки нет; ключи и режимы читаются; чужой режим - ошибка', () => {
  assert.deepEqual(trustFromArgv(['--user-plugins', '--delivery']), {});
  assert.deepEqual(trustFromArgv(['--release-key=ed25519:AAA', '--release-key=ed25519:BBB']), { trust: { releaseKeys: ['ed25519:AAA', 'ed25519:BBB'], modes: {} } });
  assert.deepEqual(trustFromArgv(['--delivery-signatures=enforce', '--plugin-signatures=warn', '--plugin-signatures=off']), { trust: { releaseKeys: [], modes: { bundled: 'enforce', user: 'off' } } });
  assert.match(trustFromArgv(['--plugin-signatures=strict']).error ?? '', /ожидается off, warn или enforce/);
});

test('main.ts: проверка пакетов настраивается через trustFromArgv(process.argv) и больше ниоткуда (не из файлов настроек и воркспейса)', () => {
  const main = fs.readFileSync(path.resolve(import.meta.dirname, 'main.ts'), 'utf8');
  const lines = main.split('\n').filter((line) => line.includes('trustFromArgv(') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('/**')).map((l) => l.trim());
  assert.deepEqual(lines, ['const trustArgs = trustFromArgv(process.argv);']);
  assert.ok(main.includes('...(trustArgs.trust !== undefined && { trust: trustArgs.trust }),'));
});
