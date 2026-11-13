import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolationFromArgv, trustFromArgv } from './trust-args.ts';

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

// TR-21, TR-22: способ запуска сторонних плагинов - только командная строка, как проверка пакетов.
test('ST-3010/5: TR-21: isolationFromArgv: без флагов настроек нет (utilityProcess); --node-host, --third-party-host, --confiner читаются; чужое значение - ошибка', () => {
  assert.deepEqual(isolationFromArgv(['--user-plugins'], '/app/node-host/host.mjs'), {});
  assert.deepEqual(isolationFromArgv(['--node-host=/opt/node', '--confiner=off', '--confiner-bin=/opt/cyborg-confine'], '/app/node-host/host.mjs'), {
    node: { binary: '/opt/node', entry: '/app/node-host/host.mjs' },
    confiner: 'off',
    confinerBinary: '/opt/cyborg-confine',
  });
  assert.equal(isolationFromArgv(['--node-host=/opt/node', '--third-party-host=utility'], '/e').thirdPartyHost, 'utility', 'возврат на utilityProcess одной настройкой');
  assert.throws(() => isolationFromArgv(['--third-party-host=docker'], '/e'), /ожидается utility или node/);
  assert.throws(() => isolationFromArgv(['--confiner=maybe'], '/e'), /ожидается auto или off/);
});

test('main.ts: изоляция сторонних плагинов настраивается через isolationFromArgv(process.argv, …) и больше ниоткуда', () => {
  const main = fs.readFileSync(path.resolve(import.meta.dirname, 'main.ts'), 'utf8');
  const lines = main.split('\n').filter((line) => line.includes('isolationFromArgv(') && !line.trimStart().startsWith('//') && !line.trimStart().startsWith('import')).map((l) => l.trim());
  // Хосты окна приложения и два замера на хосте стороннего плагина (`--spike-gateway` для `check:budgets`, `--trust-probe`); других мест нет.
  assert.equal(lines.length, 3);
  assert.equal(lines.at(-1), "const hosts = isolatedHosts(path.join(__dirname, 'plugin-host.mjs'), isolationFromArgv(process.argv, path.join(__dirname, 'node-host', 'host.mjs')));");
  assert.ok(lines.slice(0, 2).every((line) => /^void (runGatewaySpike|runTrustProbe)\(/.test(line)));
});
