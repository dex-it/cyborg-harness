import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { writeDelivery } from '../src/delivery.ts';
import { generateSigningKey, hashFiles, renderIntegrity, sha256Hex, signIntegrity, type SigningKey } from '../src/integrity.ts';
import { load, type JournalEntry, type Kernel } from '../src/loader.ts';
import { createProvenance, type Provenance, type TrustMode } from '../src/provenance.ts';
import { describeEntry, entryLevel, pluginStatuses } from '../src/status.ts';
import { forkHosts, inlineHosts } from '../src/transports.ts';
import { TrustStore } from '../src/trust-store.ts';
import { trackKernels } from './kernels.ts';

// TR-11 (ADR-CH-0017): проверка пакета перед запуском и исполнение проверенных байтов. Ключи создаются на лету, каталоги - во временном каталоге.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-provenance-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const track = trackKernels();
const NOW = Date.parse('2026-11-13T12:00:00Z');
let counter = 0;
const fresh = (name: string): string => path.join(root, `${name}-${String(++counter)}`);

const GOOD = "export default { activate(ctx) { ctx.commands.register('acme.p.hello', () => 'GOOD'); } };\n";
const EVIL = "export default { activate(ctx) { ctx.commands.register('acme.p.hello', () => 'EVIL'); } };\n";

function manifestText(version: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'acme.p', version, engines: { cyborg: '^1' }, commands: ['acme.p.hello'], ...extra });
}

/** Каталог плагина `acme.p` с подписанным `integrity.json`; `key: null` - без подписи. */
function plugin(options: { key?: SigningKey | null; version?: string; files?: Record<string, string>; notAfter?: Date; manifest?: Record<string, unknown> } = {}): string {
  const dir = fresh('plugin');
  const version = options.version ?? '1.0.0';
  const files: Record<string, string> = { 'manifest.json': manifestText(version, options.manifest), 'index.mjs': GOOD, 'ui/view.css': 'body {}', ...options.files };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  if (options.key !== null && options.key !== undefined) {
    const map = new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]));
    fs.writeFileSync(path.join(dir, 'integrity.json'), renderIntegrity(signIntegrity({ id: 'acme.p', version, files: hashFiles(map), notAfter: options.notAfter ?? new Date(NOW + 86_400_000) }, options.key.secretKey)));
  }
  return dir;
}

async function trusting(...keys: SigningKey[]): Promise<TrustStore> {
  const store = await TrustStore.open(path.join(fresh('userData'), 'trust.json'));
  for (const key of keys) await store.addPublisher(key.publicKey);
  return store;
}

const provenance = (trust: TrustStore, home: string | undefined, mode: TrustMode = 'enforce', more: Partial<Parameters<typeof createProvenance>[0]> = {}): Provenance =>
  createProvenance({ trust, releaseKeys: [], mode: () => mode, bundled: () => false, homeOf: () => home, now: () => NOW, ...more });

const check = (p: Provenance, version = '1.0.0') => p.check({ id: 'acme.p', version });

describe('ST-3009/3: createProvenance - пакет каталога пользователя', () => {
  it('подписанный пакет принят; хосту уходят только загружаемые файлы, адрес каталога настоящий; версия запомнена', async () => {
    const key = generateSigningKey();
    const trust = await trusting(key);
    const home = plugin({ key });
    const verdict = await check(provenance(trust, home));
    assert.ok(verdict.ok);
    assert.deepEqual(Object.keys(verdict.verified?.files ?? {}).sort(), ['index.mjs', 'manifest.json']);
    assert.equal(verdict.verified?.base, pathToFileURL(`${fs.realpathSync(home)}${path.sep}`).href);
    assert.match(verdict.verified.base, /\/$/);
    assert.equal(trust.highestSeen('acme.p'), '1.0.0');
  });

  it('режим off не читает пакет; ключ поставки доверен как издатель', async () => {
    const trust = await trusting();
    assert.deepEqual(await check(provenance(trust, undefined, 'off')), { ok: true });
    const release = generateSigningKey();
    assert.ok((await check(provenance(trust, plugin({ key: release }), 'enforce', { releaseKeys: [release.publicKey] }))).ok);
  });

  it('изменённый байт, лишний файл, чужой ключ, истёкший срок, нет подписи - отказ с кодом и режимом', async () => {
    const key = generateSigningKey();
    const trust = await trusting(key);
    const codeOf = async (home: string, mode: TrustMode = 'enforce') => {
      const v = await check(provenance(trust, home, mode));
      return v.ok ? 'ok' : `${v.code}/${v.mode}`;
    };
    const changed = plugin({ key });
    fs.appendFileSync(path.join(changed, 'index.mjs'), '// правка');
    assert.equal(await codeOf(changed), 'modified/enforce');
    assert.equal(await codeOf(changed, 'warn'), 'modified/warn');
    const extra = plugin({ key });
    fs.writeFileSync(path.join(extra, 'evil.mjs'), 'x');
    assert.equal(await codeOf(extra), 'extra/enforce');
    assert.equal(await codeOf(plugin({ key: generateSigningKey() })), 'unknown-key/enforce');
    assert.equal(await codeOf(plugin({ key, notAfter: new Date(NOW - 1) })), 'expired/enforce');
    assert.equal(await codeOf(plugin({ key: null })), 'no-integrity/enforce');
  });

  it('откат: версия ниже принятой отвергнута, даже если подписана; подмена файла из-под записи версии не обходит', async () => {
    const key = generateSigningKey();
    const trust = await trusting(key);
    assert.ok((await check(provenance(trust, plugin({ key, version: '2.0.0' })), '2.0.0')).ok);
    const old = await check(provenance(trust, plugin({ key, version: '1.5.0' })), '1.5.0');
    assert.ok(!old.ok);
    assert.equal(old.code, 'rollback');
    assert.match(old.reason, /1\.5\.0.*2\.0\.0/);
    await trust.forgetVersion('acme.p');
    assert.ok((await check(provenance(trust, plugin({ key, version: '1.5.0' })), '1.5.0')).ok, 'после решения человека старую версию принимают');
  });

  it('отозванный ключ и отозванный хеш - отказ, хотя подпись верна', async () => {
    const key = generateSigningKey();
    const trust = await trusting(key);
    const home = plugin({ key });
    await trust.revokeKey(key.keyId, 'утёк');
    const byKey = await check(provenance(trust, home));
    assert.ok(!byKey.ok);
    assert.equal(byKey.code, 'revoked-key');
    assert.equal(byKey.keyId, key.keyId);
    const fine = await trusting(key);
    await fine.revokeHash(sha256Hex(GOOD), 'вредный файл');
    const byHash = await check(provenance(fine, home));
    assert.ok(!byHash.ok);
    assert.equal(byHash.code, 'revoked-hash');
  });

  it('manifest.json должен совпасть с тем, что прочёл поиск плагинов: иначе права ядра взяты из другого файла', async () => {
    const key = generateSigningKey();
    const trust = await trusting(key);
    const home = plugin({ key });
    const raw = JSON.parse(manifestText('1.0.0')) as unknown;
    assert.ok((await check(provenance(trust, home, 'enforce', { rawManifestOf: () => raw }))).ok);
    const wider = { ...(raw as object), permissions: { process: [{ program: 'sh' }] } };
    const v = await check(provenance(trust, home, 'enforce', { rawManifestOf: () => wider }));
    assert.ok(!v.ok);
    assert.equal(v.code, 'mismatch');
    const other = await check(provenance(trust, home), '9.9.9');
    assert.ok(!other.ok);
    assert.match(other.reason, /не тот, что прочитал поиск/);
  });

  it('хранилище не читается, каталога нет, чтение падает - unavailable, а не исключение', async () => {
    const key = generateSigningKey();
    const file = path.join(fresh('userData'), 'trust.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, '{ нет');
    const broken = await TrustStore.open(file);
    const a = await check(provenance(broken, plugin({ key })));
    assert.ok(!a.ok);
    assert.equal(a.code, 'unavailable');
    assert.match(a.reason, /trust\.json не разобран/);
    const trust = await trusting(key);
    const b = await check(provenance(trust, undefined));
    assert.ok(!b.ok);
    assert.match(b.reason, /каталог плагина не найден/);
    const c = await check(provenance(trust, path.join(root, 'нет такого')));
    assert.ok(!c.ok);
    assert.equal(c.code, 'unavailable');
    assert.match(c.reason, /проверка не выполнена/);
  });
});

describe('ST-3009/3: createProvenance - встроенные плагины по delivery.json', () => {
  async function catalog(): Promise<{ dir: string; home: string }> {
    const dir = fresh('delivery');
    const home = path.join(dir, 'acme.p');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'manifest.json'), manifestText('1.0.0'));
    fs.writeFileSync(path.join(home, 'index.mjs'), GOOD);
    return { dir, home };
  }
  const bundled = (trust: TrustStore, home: string, delivery: Parameters<typeof createProvenance>[0]['delivery'], mode: TrustMode = 'warn') => provenance(trust, home, mode, { bundled: () => true, delivery });

  it('цельная поставка принята; изменённый, лишний, пропавший файл и чужой каталог названы', async () => {
    const { dir, home } = await catalog();
    const manifest = await writeDelivery(dir);
    const trust = await trusting();
    assert.ok((await check(bundled(trust, home, { manifest }))).ok);
    const codeOf = async (delivery: Parameters<typeof createProvenance>[0]['delivery']) => {
      const v = await check(bundled(trust, home, delivery));
      return v.ok ? 'ok' : `${v.code}: ${v.reason}`;
    };
    assert.match(await codeOf(undefined), /^no-integrity: .*delivery\.json/);
    assert.match(await codeOf({ manifest: undefined }), /^no-integrity/);
    assert.match(await codeOf({ manifest: { format: 1, plugins: {} } }), /^missing: плагина acme\.p нет/);
    fs.writeFileSync(path.join(home, 'extra.mjs'), 'x');
    assert.match(await codeOf({ manifest }), /^extra: лишний файл/);
    fs.rmSync(path.join(home, 'extra.mjs'));
    fs.appendFileSync(path.join(home, 'index.mjs'), '// правка');
    assert.match(await codeOf({ manifest }), /^modified: файл изменён после выпуска поставки: index\.mjs/);
    fs.writeFileSync(path.join(home, 'index.mjs'), GOOD);
    fs.rmSync(path.join(home, 'index.mjs'));
    assert.match(await codeOf({ manifest }), /^missing: файла нет в пакете: index\.mjs/);
  });

  it('подпись поставки не сошлась, ключ поставки отозван, откат и отозванный хеш - отказ; ссылка в каталоге плагина тоже видна', async () => {
    const { dir, home } = await catalog();
    const manifest = await writeDelivery(dir);
    const trust = await trusting();
    const bad = await check(bundled(trust, home, { manifest, signature: { ok: false, code: 'bad-signature', reason: 'подпись не сходится', keyId: 'k' } }));
    assert.ok(!bad.ok);
    assert.equal(bad.code, 'bad-signature');
    const keyId = '1'.repeat(32);
    await trust.revokeKey(keyId);
    const revoked = await check(bundled(trust, home, { manifest, signature: { ok: true, keyId, notAfter: 'x' } }));
    assert.ok(!revoked.ok);
    assert.equal(revoked.code, 'revoked-key');
    const fresh1 = await trusting();
    await fresh1.recordVersion('acme.p', '3.0.0');
    const rolled = await check(bundled(fresh1, home, { manifest }));
    assert.ok(!rolled.ok);
    assert.equal(rolled.code, 'rollback');
    const fresh2 = await trusting();
    await fresh2.revokeHash(sha256Hex(GOOD));
    const hashed = await check(bundled(fresh2, home, { manifest }));
    assert.ok(!hashed.ok);
    assert.equal(hashed.code, 'revoked-hash');
    fs.symlinkSync('index.mjs', path.join(home, 'alias.mjs'));
    const linked = await check(bundled(await trusting(), home, { manifest }));
    assert.ok(!linked.ok);
    assert.equal(linked.code, 'extra');
  });
});

describe('ST-3009/3, ST-3009/4: ядро исполняет проверенные байты и отказывает в запуске', () => {
  const journalOf = (kernel: Kernel, kind: JournalEntry['kind']) => kernel.journal.filter((e) => e.kind === kind);

  async function start(prov: Provenance | undefined, home: string, spawn: 'fork' | 'inline' = 'fork'): Promise<Kernel> {
    return track(
      await load({
        apiVersion: PLUGIN_API_VERSION,
        enabled: ['acme.p'],
        manifests: [JSON.parse(fs.readFileSync(path.join(home, 'manifest.json'), 'utf8')) as unknown],
        spawnHost: spawn === 'fork' ? forkHosts({ silent: true }) : inlineHosts(async (entry) => ((await import(entry)) as { default: never }).default),
        entry: () => pathToFileURL(path.join(home, 'index.mjs')).href,
        ...(prov !== undefined && { provenance: prov }),
        watchdog: { interval: 200, timeout: 5000, strikes: 3 },
      }),
    );
  }

  /** Проверка прошла, и сразу после неё файл на диске подменён: так выглядит гонка между проверкой и import(). */
  const swapping = (inner: Provenance, home: string): Provenance => ({
    async check(manifest) {
      const verdict = await inner.check(manifest);
      fs.writeFileSync(path.join(home, 'index.mjs'), EVIL);
      return verdict;
    },
  });

  it('подмена файла между проверкой и запуском (хост - настоящий процесс): исполняются проверенные байты, не диск', async () => {
    const key = generateSigningKey();
    const home = plugin({ key });
    const kernel = await start(swapping(provenance(await trusting(key), home), home), home);
    assert.deepEqual(kernel.active, ['acme.p']);
    assert.equal(fs.readFileSync(path.join(home, 'index.mjs'), 'utf8'), EVIL, 'на диске уже подмена');
    assert.equal(await kernel.run('acme.p.hello'), 'GOOD');
  });

  it('контроль опыта: та же подмена без проверенных байтов исполняется (тест не бессмыслен)', async () => {
    const home = plugin({ key: null });
    const blind: Provenance = { check: () => Promise.resolve({ ok: true }) };
    const kernel = await start(swapping(blind, home), home);
    assert.equal(await kernel.run('acme.p.hello'), 'EVIL');
  });

  it('то же в общем процессе (inlineHosts): проверенные байты', async () => {
    const key = generateSigningKey();
    const home = plugin({ key });
    const kernel = await start(swapping(provenance(await trusting(key), home), home), home, 'inline');
    assert.equal(await kernel.run('acme.p.hello'), 'GOOD');
  });

  it('enforce: изменённый пакет не запущен, запись integrity-failed с причиной, состояние «остановлен» и текст для окна', async () => {
    const key = generateSigningKey();
    const home = plugin({ key });
    fs.writeFileSync(path.join(home, 'index.mjs'), EVIL);
    const kernel = await start(provenance(await trusting(key), home), home);
    assert.deepEqual(kernel.active, []);
    const [entry] = journalOf(kernel, 'integrity-failed');
    assert.ok(entry?.kind === 'integrity-failed');
    assert.deepEqual({ code: entry.code, mode: entry.mode, keyId: entry.keyId, pluginId: entry.pluginId }, { code: 'modified', mode: 'enforce', keyId: key.keyId, pluginId: 'acme.p' });
    const status = pluginStatuses(kernel.journal).find((s) => s.id === 'acme.p');
    assert.equal(status?.state, 'stopped');
    assert.equal(status.revivable, true);
    assert.match(describeEntry(entry), /^плагин не запущен: происхождение пакета не подтверждено - файл изменён после подписи: index\.mjs/);
    assert.equal(entryLevel(entry), 'error');
    assert.equal(journalOf(kernel, 'activated').length, 0);
  });

  it('warn: запись есть, плагин запущен с диска как раньше', async () => {
    const home = plugin({ key: null });
    const kernel = await start(provenance(await trusting(), home, 'warn'), home);
    assert.deepEqual(kernel.active, ['acme.p']);
    const [entry] = journalOf(kernel, 'integrity-failed');
    assert.ok(entry?.kind === 'integrity-failed');
    assert.equal(entry.mode, 'warn');
    assert.equal(entry.code, 'no-integrity');
    assert.equal(entryLevel(entry), 'warn');
    assert.match(describeEntry(entry), /плагин запущен \(режим «предупреждать»\)/);
    assert.equal(await kernel.run('acme.p.hello'), 'GOOD');
  });

  it('откат между запусками: v2 принята и запомнена в trust.json, v1 того же издателя в новом ядре не запущена', async () => {
    const key = generateSigningKey();
    const trust = await trusting(key);
    const v2 = plugin({ key, version: '2.0.0' });
    const first = await start(provenance(trust, v2), v2);
    assert.deepEqual(first.active, ['acme.p']);
    await first.unload();
    const v1 = plugin({ key, version: '1.0.0' });
    const reopened = await TrustStore.open(trust.file);
    const second = await start(provenance(reopened, v1), v1);
    assert.deepEqual(second.active, []);
    const [entry] = journalOf(second, 'integrity-failed');
    assert.ok(entry?.kind === 'integrity-failed');
    assert.equal(entry.code, 'rollback');
  });

  it('проверяющий бросил исключение: в режиме отказа плагин не запущен, причина - unavailable', async () => {
    const home = plugin({ key: null });
    const kernel = await start({ check: () => Promise.reject(new Error('диск ушёл')) }, home);
    assert.deepEqual(kernel.active, []);
    const [entry] = journalOf(kernel, 'integrity-failed');
    assert.ok(entry?.kind === 'integrity-failed');
    assert.deepEqual({ code: entry.code, mode: entry.mode }, { code: 'unavailable', mode: 'enforce' });
    assert.match(entry.reason, /диск ушёл/);
  });

  it('плагин не может подгрузить файл вне проверенного набора: import() соседа, которого нет в подписи, отклонён', async () => {
    const key = generateSigningKey();
    const home = plugin({
      key,
      files: {
        'index.mjs': "export default { async activate(ctx) { ctx.commands.register('acme.p.hello', async () => { try { await import('./late.mjs'); return 'LOADED'; } catch (e) { return 'DENIED:' + String(e.message).slice(0, 40); } }); } };\n",
      },
    });
    const kernel = await start(provenance(await trusting(key), home), home);
    fs.writeFileSync(path.join(home, 'late.mjs'), 'export default 1;');
    const answer = await kernel.run('acme.p.hello');
    assert.match(String(answer), /^DENIED:/);
  });
});
