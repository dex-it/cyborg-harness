import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inlineHosts, type PluginModule } from '@cyborg-harness/core';
import { writeDelivery } from '@cyborg-harness/core/delivery';
import { generateSigningKey, hashFiles, renderIntegrity, signIntegrity, signRevocations, type SigningKey } from '@cyborg-harness/core/integrity';
import { PluginsService, startPlugins, type StartOptions } from '../src/plugins.ts';

// TR-11 (ADR-CH-0017): адаптер открывает хранилище доверия, применяет список отзыва и проверяет пакеты перед запуском; причина отказа доходит до окна «Плагины Cyborg».
// Хост здесь - inlineHosts с настоящим import(): так проверенные байты идут тем же путём, что в хосте процесса.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-provenance-'));
const importer = (entry: string) => import(entry).then((m: { default: PluginModule }) => m.default);
const CODE = 'export default { activate() {} };\n';
const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;

function plugin(dir: string, id: string, options: { key?: SigningKey; version?: string; code?: string } = {}): string {
  const home = path.join(dir, id);
  const version = options.version ?? '1.0.0';
  const files = { 'manifest.json': JSON.stringify({ id, version, engines: { cyborg: '^1' } }), 'index.mjs': options.code ?? CODE };
  fs.mkdirSync(home, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(home, name), text);
  if (options.key !== undefined) {
    const map = new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));
    fs.writeFileSync(path.join(home, 'integrity.json'), renderIntegrity(signIntegrity({ id, version, files: hashFiles(map), notAfter: new Date(NOW + DAY) }, options.key.secretKey)));
  }
  return home;
}

function setup(enabled: string[]): { userData: string; builtinDir: string; user: string } {
  const userData = tmp();
  fs.writeFileSync(path.join(userData, 'cyborg.json'), JSON.stringify({ plugins: { enabled } }));
  return { userData, builtinDir: tmp(), user: path.join(userData, 'plugins') };
}

async function start(base: Omit<StartOptions, 'spawnHost' | 'log'>) {
  const service = new PluginsService({ changed: () => {}, alert: () => {} }, () => NOW);
  await service.start({ ...base, spawnHost: inlineHosts(importer), log: () => {} });
  return service;
}

test('ST-3009/4: каталог пользователя: неподписанный пакет не запущен, окно называет причину словами и позволяет «Включить снова»', async (t) => {
  const { userData, builtinDir, user } = setup(['notes']);
  plugin(user, 'notes');
  const service = await start({ userData, builtinDir, userPlugins: true, trust: { releaseKeys: [], now: () => NOW } });
  t.after(() => service.unload());
  const row = service.snapshot().plugins.find((r) => r.id === 'notes');
  assert.equal(row?.state, 'stopped');
  assert.equal(row.revivable, true);
  assert.equal(row.origin, 'user');
  assert.match(row.reason ?? '', /^плагин не запущен: происхождение пакета не подтверждено - в пакете нет integrity\.json: он не подписан/);
  const line = service.snapshot().journal.find((j) => j.text.includes('integrity.json'));
  assert.deepEqual([line?.level, line?.plugins], ['error', ['notes']]);
});

test('ST-3009/4: подписанный ключом из trust.json пакет запущен, версия записана в trust.json (0600); тот же пакет без ключа - нет', async (t) => {
  const key = generateSigningKey();
  const { userData, builtinDir, user } = setup(['notes']);
  plugin(user, 'notes', { key, version: '1.4.0' });
  fs.writeFileSync(path.join(userData, 'trust.json'), JSON.stringify({ format: 1, publishers: { [key.keyId]: { publicKey: key.publicKey, name: 'Acme' } } }));
  const service = await start({ userData, builtinDir, userPlugins: true, trust: { now: () => NOW } });
  t.after(() => service.unload());
  assert.equal(service.snapshot().plugins.find((r) => r.id === 'notes')?.state, 'active');
  const stored = JSON.parse(fs.readFileSync(path.join(userData, 'trust.json'), 'utf8')) as { versions: Record<string, string>; publishers: Record<string, { name: string }> };
  assert.equal(stored.versions.notes, '1.4.0');
  assert.equal(stored.publishers[key.keyId]?.name, 'Acme');
  assert.equal(fs.statSync(path.join(userData, 'trust.json')).mode & 0o777, 0o600);

  const other = setup(['notes']);
  plugin(other.user, 'notes', { key, version: '1.4.0' });
  const refused = await start({ ...other, userPlugins: true, trust: { now: () => NOW } });
  t.after(() => refused.unload());
  assert.match(refused.snapshot().plugins.find((r) => r.id === 'notes')?.reason ?? '', /ключ издателя [0-9a-f]{32} не в списке доверенных/);
});

test('ST-3009/4: список отзыва, подписанный ключом поставки, останавливает плагин с отозванным ключом; чужая подпись списка названа в problems', async (t) => {
  const publisher = generateSigningKey();
  const release = generateSigningKey();
  const { userData, builtinDir, user } = setup(['notes']);
  plugin(user, 'notes', { key: publisher });
  fs.writeFileSync(path.join(userData, 'trust.json'), JSON.stringify({ format: 1, publishers: { [publisher.keyId]: { publicKey: publisher.publicKey } } }));
  const forged = signRevocations({ serial: 1, keys: { [publisher.keyId]: 'подделка' }, issuedAt: new Date(NOW), notAfter: new Date(NOW + DAY) }, generateSigningKey().secretKey);
  fs.writeFileSync(path.join(userData, 'revocations.json'), forged);
  const first = await start({ userData, builtinDir, userPlugins: true, trust: { releaseKeys: [release.publicKey], now: () => NOW } });
  assert.equal(first.snapshot().plugins.find((r) => r.id === 'notes')?.state, 'active', 'список чужого ключа не действует');
  assert.ok(first.snapshot().problems.some((p) => p.includes('список отзыва') && p.includes('такое право не дано')), first.snapshot().problems.join('\n'));
  await first.unload();

  fs.writeFileSync(path.join(userData, 'revocations.json'), signRevocations({ serial: 1, keys: { [publisher.keyId]: 'утёк' }, issuedAt: new Date(NOW), notAfter: new Date(NOW + DAY) }, release.secretKey));
  const second = await start({ userData, builtinDir, userPlugins: true, trust: { releaseKeys: [release.publicKey], now: () => NOW } });
  t.after(() => second.unload());
  const row = second.snapshot().plugins.find((r) => r.id === 'notes');
  assert.equal(row?.state, 'stopped');
  assert.match(row.reason ?? '', new RegExp(`ключ издателя ${publisher.keyId} отозван`));

  // Устаревший список: отзыв действует, окно предупреждает.
  const third = await start({ userData, builtinDir, userPlugins: true, trust: { releaseKeys: [release.publicKey], now: () => NOW + 3 * DAY } });
  t.after(() => third.unload());
  assert.equal(third.snapshot().plugins.find((r) => r.id === 'notes')?.state, 'stopped');
  assert.ok(third.snapshot().problems.some((p) => p.includes('список отзыва устарел')));
});

test('ST-3009/4: trust.json повреждён - проверка отказывает с причиной, файл не стёрт; назван в problems', async (t) => {
  const { userData, builtinDir, user } = setup(['notes']);
  plugin(user, 'notes', { key: generateSigningKey() });
  fs.writeFileSync(path.join(userData, 'trust.json'), '{ битый');
  const service = await start({ userData, builtinDir, userPlugins: true, trust: { now: () => NOW } });
  t.after(() => service.unload());
  const snapshot = service.snapshot();
  assert.match(snapshot.plugins.find((r) => r.id === 'notes')?.reason ?? '', /trust\.json не разобран/);
  assert.ok(snapshot.problems.some((p) => p.includes('trust.json не разобран') && p.includes('исправлен')));
  assert.equal(fs.readFileSync(path.join(userData, 'trust.json'), 'utf8'), '{ битый');
});

test('ST-3009/5: поставка по умолчанию в режиме «предупреждать»: подмена файла записана и показана, плагин запущен; целая поставка чиста', async (t) => {
  const { userData, builtinDir } = setup(['files']);
  const home = plugin(builtinDir, 'files');
  await writeDelivery(builtinDir);
  const clean = await start({ userData, builtinDir, trust: { now: () => NOW } });
  assert.deepEqual(clean.snapshot().journal.filter((j) => j.text.includes('происхождение')), [], 'целая поставка без записей');
  assert.equal(clean.snapshot().plugins.find((r) => r.id === 'files')?.state, 'active');
  await clean.unload();

  fs.appendFileSync(path.join(home, 'index.mjs'), '// подмена');
  const tampered = await start({ userData, builtinDir, trust: { now: () => NOW } });
  t.after(() => tampered.unload());
  const row = tampered.snapshot().plugins.find((r) => r.id === 'files');
  assert.equal(row?.state, 'active', 'warn не останавливает');
  assert.equal(row.origin, 'bundled');
  const line = tampered.snapshot().journal.find((j) => j.text.includes('режим «предупреждать»'));
  assert.equal(line?.level, 'warn');
  assert.match(line.text, /файл изменён после выпуска поставки: index\.mjs/);
});

test('ST-3009/5: режим «отказывать» для поставки включается настройкой; режим стенда поставку не проверяет', async (t) => {
  const { userData, builtinDir } = setup(['files']);
  const home = plugin(builtinDir, 'files');
  await writeDelivery(builtinDir);
  fs.appendFileSync(path.join(home, 'index.mjs'), '// подмена');
  const strict = await start({ userData, builtinDir, trust: { modes: { bundled: 'enforce' }, now: () => NOW } });
  t.after(() => strict.unload());
  assert.equal(strict.snapshot().plugins.find((r) => r.id === 'files')?.state, 'stopped');
  const stand = await start({ userData, builtinDir, builtinMode: 'stand', trust: { modes: { bundled: 'enforce' }, now: () => NOW } });
  t.after(() => stand.unload());
  assert.equal(stand.snapshot().plugins.find((r) => r.id === 'files')?.state, 'active');
  assert.deepEqual(stand.snapshot().journal.filter((j) => j.text.includes('происхождение')), []);
});

test('ST-3009/3: startPlugins без trust не проверяет ничего (прежнее поведение)', async (t) => {
  const { userData, builtinDir, user } = setup(['notes']);
  plugin(user, 'notes');
  const kernel = await startPlugins({ userData, builtinDir, userPlugins: true, spawnHost: inlineHosts(importer), log: () => {} });
  t.after(() => kernel.unload());
  assert.deepEqual(kernel.active, ['notes']);
  assert.equal(kernel.journal.some((e) => e.kind === 'integrity-failed'), false);
});
