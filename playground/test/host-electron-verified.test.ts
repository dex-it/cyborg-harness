import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProvenance, load, TrustStore, PLUGIN_API_VERSION } from '@cyborg-harness/core';
import { generateSigningKey, hashFiles, renderIntegrity, signIntegrity } from '@cyborg-harness/core/integrity';
import { electronHosts } from './electron-hosts.ts';

// TR-11 (ADR-CH-0017, docs/05-verification/provenance-loading.md): проверенные байты исполняются на рантайме Electron (Node 24 внутри, процесс - бинарник Electron
// в режиме Node, как в host-electron.test.ts), а подмена файла между проверкой и import() до исполнения не доходит. Канал хоста здесь JSON: байты едут строками base64.
const GOOD = "export default { activate(ctx) { ctx.commands.register('acme.p.hello', () => 'GOOD:' + process.versions.electron); } };\n";
const EVIL = "export default { activate(ctx) { ctx.commands.register('acme.p.hello', () => 'EVIL'); } };\n";
const NOW = Date.parse('2026-11-13T12:00:00Z');

test('ST-3009/3: хост на рантайме Electron исполняет проверенные байты, а не подменённый файл', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-electron-verified-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'plugin');
  fs.mkdirSync(home);
  const manifest = JSON.stringify({ id: 'acme.p', version: '1.0.0', engines: { cyborg: '^1' }, commands: ['acme.p.hello'] });
  const files = { 'manifest.json': manifest, 'index.mjs': GOOD };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(home, name), text);
  const key = generateSigningKey();
  const map = new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));
  fs.writeFileSync(path.join(home, 'integrity.json'), renderIntegrity(signIntegrity({ id: 'acme.p', version: '1.0.0', files: hashFiles(map), notAfter: new Date(NOW + 86_400_000) }, key.secretKey)));
  const trust = await TrustStore.open(path.join(dir, 'userData', 'trust.json'));
  await trust.addPublisher(key.publicKey);
  const inner = createProvenance({ trust, releaseKeys: [], mode: () => 'enforce', bundled: () => false, homeOf: () => home, now: () => NOW });
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['acme.p'],
    manifests: [JSON.parse(manifest) as unknown],
    spawnHost: electronHosts,
    entry: () => pathToFileURL(path.join(home, 'index.mjs')).href,
    provenance: {
      async check(m) {
        const verdict = await inner.check(m);
        fs.writeFileSync(path.join(home, 'index.mjs'), EVIL);
        return verdict;
      },
    },
    watchdog: { interval: 100, timeout: 30_000, strikes: 3 },
  });
  t.after(() => k.unload());
  assert.deepEqual(k.active, ['acme.p']);
  assert.equal(fs.readFileSync(path.join(home, 'index.mjs'), 'utf8'), EVIL);
  const answer = await k.run('acme.p.hello');
  assert.match(String(answer), /^GOOD:\d+\./, 'в хосте исполнен проверенный код, а процесс - Electron');
});
