import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { generateSigningKey, sha256Hex } from '../src/integrity.ts';
import { TRUST_FILE, TrustStore, signRevocations, verifyRevocations } from '../src/trust-store.ts';

// TR-11 (ADR-CH-0017): userData/trust.json - ключи издателей, наибольшие версии, отозванные ключи и хеши. Ключи создаются на лету.
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-trust-')), 'userData', TRUST_FILE);
const NOW = Date.parse('2026-11-13T12:00:00Z');
const day = 86_400_000;

describe('ST-3009/4: хранилище доверия - файл', () => {
  it('нет файла - пустое; запись создаёт каталог 0700 и файл 0600; читается обратно другим экземпляром', async () => {
    const file = tmp();
    const store = await TrustStore.open(file);
    assert.equal(store.error, undefined);
    assert.equal(store.publishers().size, 0);
    const key = generateSigningKey();
    assert.equal(await store.addPublisher(key.publicKey, { name: 'Acme', now: NOW }), key.keyId);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [TRUST_FILE], 'временных файлов не осталось');
    const again = await TrustStore.open(file);
    assert.equal(again.publishers().get(key.keyId)?.name, 'Acme');
    assert.equal(again.publishers().get(key.keyId)?.addedAt, '2026-11-13T12:00:00.000Z');
    assert.equal(again.publisherKeys().get(key.keyId), key.publicKey);
    assert.equal(await again.removePublisher(key.keyId), true);
    assert.equal(await again.removePublisher(key.keyId), false);
    assert.equal((await TrustStore.open(file)).publishers().size, 0);
  });

  it('версия только растёт: ниже и равная ничего не пишут; forgetVersion - решение человека', async () => {
    const file = tmp();
    const store = await TrustStore.open(file);
    await store.recordVersion('acme.p', '1.2.0');
    await store.recordVersion('acme.p', '1.1.9');
    await store.recordVersion('acme.p', '1.2.0');
    assert.equal(store.highestSeen('acme.p'), '1.2.0');
    await store.recordVersion('acme.p', '2.0.0');
    assert.equal((await TrustStore.open(file)).highestSeen('acme.p'), '2.0.0');
    assert.equal(store.highestSeen('constructor'), undefined, 'недоверенное имя не находится в прототипе');
    await assert.rejects(store.recordVersion('acme.p', 'x'), /x\.y\.z/);
    assert.equal(await store.forgetVersion('acme.p'), true);
    assert.equal(store.highestSeen('acme.p'), undefined);
    assert.equal(await store.forgetVersion('acme.p'), false);
  });

  it('отзыв ключа и хеша: запись с причиной, проверка форм', async () => {
    const file = tmp();
    const store = await TrustStore.open(file);
    const key = generateSigningKey();
    await store.revokeKey(key.keyId, 'утёк');
    await store.revokeHash(sha256Hex('плохой файл'), 'вредный');
    const again = await TrustStore.open(file);
    assert.deepEqual([...again.revokedKeys()], [key.keyId]);
    assert.deepEqual([...again.revokedHashes()], [sha256Hex('плохой файл')]);
    assert.equal(again.revoked().keys[key.keyId], 'утёк');
    await assert.rejects(store.revokeKey('abc'), /32 символа/);
    await assert.rejects(store.revokeHash('abc'), /sha256/);
    await assert.rejects(store.addPublisher('ed25519:AAAA'), /32 байт/);
  });

  it('два экземпляра одного файла (два окна) не затирают правки друг друга', async () => {
    const file = tmp();
    const a = await TrustStore.open(file);
    const b = await TrustStore.open(file);
    await a.recordVersion('acme.a', '1.0.0');
    await b.recordVersion('acme.b', '2.0.0');
    const merged = await TrustStore.open(file);
    assert.equal(merged.highestSeen('acme.a'), '1.0.0');
    assert.equal(merged.highestSeen('acme.b'), '2.0.0');
  });

  it('битый файл: ошибка с причиной, запись отказывает и файл не стёрт', async () => {
    const file = tmp();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cases: [string, RegExp][] = [
      ['{ нет', /не разобран/],
      ['[]', /ожидался объект/],
      [JSON.stringify({ format: 2 }), /формат 2/],
      [JSON.stringify({ format: 1, versions: { a: 'v1' } }), /versions\.a/],
      [JSON.stringify({ format: 1, publishers: { x: { publicKey: 'ed25519:AAAA' } } }), /32 байт/],
      [JSON.stringify({ format: 1, publishers: { ['0'.repeat(32)]: { publicKey: generateSigningKey().publicKey } } }), /не соответствует/],
      [JSON.stringify({ format: 1, revoked: { keys: { zz: '' } } }), /недопустимый/],
      [JSON.stringify({ format: 1, revocations: { serial: 'x' } }), /revocations/],
      [JSON.stringify({ format: 1, versions: [] }), /ожидался объект/],
    ];
    for (const [text, expected] of cases) {
      fs.writeFileSync(file, text);
      const store = await TrustStore.open(file);
      assert.match(store.error ?? '', expected, text);
      await assert.rejects(store.recordVersion('acme.p', '1.0.0'));
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'файл не перезаписан');
    }
  });
});

describe('ST-3009/4: подписанный список отзыва', () => {
  const release = generateSigningKey();

  it('список подписан ключом поставки: ключи и хеши применяются, serial растёт, повтор и старый список отвергаются', async () => {
    const store = await TrustStore.open(tmp());
    const bad = generateSigningKey();
    const hash = sha256Hex('плохой');
    const first = signRevocations({ serial: 1, keys: { [bad.keyId]: 'утёк' }, issuedAt: new Date(NOW), notAfter: new Date(NOW + 30 * day) }, release.secretKey);
    assert.deepEqual(await store.applyRevocations(first, [release.publicKey], NOW), { ok: true, added: 1, serial: 1 });
    assert.deepEqual([...store.revokedKeys()], [bad.keyId]);
    assert.equal(store.revocationState()?.serial, 1);
    assert.equal((await store.applyRevocations(first, [release.publicKey], NOW)).ok, false, 'тот же serial');
    const second = signRevocations({ serial: 2, keys: { [bad.keyId]: 'утёк' }, hashes: { [hash]: 'плохой файл' }, issuedAt: new Date(NOW), notAfter: new Date(NOW + 30 * day) }, release.secretKey);
    assert.deepEqual(await store.applyRevocations(second, [release.publicKey], NOW), { ok: true, added: 1, serial: 2 });
    assert.deepEqual([...store.revokedHashes()], [hash]);
    const reopened = await TrustStore.open(store.file);
    assert.equal(reopened.revocationState()?.serial, 2);
    assert.equal(reopened.revocationsStale(NOW), false);
    assert.equal(reopened.revocationsStale(NOW + 31 * day), true, 'отзыв действует, но список устарел');
    assert.equal(reopened.revokedKeys().has(bad.keyId), true);
    const old = signRevocations({ serial: 1, hashes: {}, keys: {}, issuedAt: new Date(NOW), notAfter: new Date(NOW + day) }, release.secretKey);
    assert.match(String((await reopened.applyRevocations(old, [release.publicKey], NOW) as { reason?: string }).reason), /не новее/);
  });

  it('подпись чужого ключа, издателя без права, поддельная подпись и просроченный список - отказ', async () => {
    const store = await TrustStore.open(tmp());
    const stranger = generateSigningKey();
    const text = (key = stranger, serial = 1, notAfter = NOW + day) => signRevocations({ serial, keys: { [generateSigningKey().keyId]: '' }, issuedAt: new Date(NOW), notAfter: new Date(notAfter) }, key.secretKey);
    const reason = async (list: string) => {
      const r = await store.applyRevocations(list, [release.publicKey], NOW);
      return r.ok ? 'принят' : r.reason;
    };
    assert.match(await reason(text()), /которому такое право не дано/);
    await store.addPublisher(stranger.publicKey, { name: 'без права' });
    assert.match(await reason(text()), /не дано/);
    await store.addPublisher(stranger.publicKey, { name: 'с правом', canRevoke: true });
    assert.equal(await reason(text()), 'принят', 'издатель с canRevoke');
    assert.match(await reason(text(release, 2, NOW - 1)), /устарел/);
    const forged = JSON.parse(text(release, 3)) as { keys: Record<string, string> };
    forged.keys[generateSigningKey().keyId] = 'подсунуто';
    assert.match(await reason(JSON.stringify(forged)), /подпись не сходится/);
    assert.match(await reason('{ нет'), /не разобран/);
    assert.match(await reason('[]'), /формата 1/);
    assert.match(await reason(JSON.stringify({ format: 1, serial: 0 })), /serial/);
    assert.match(await reason(JSON.stringify({ format: 1, serial: 1, issuedAt: 'x', notAfter: 'y' })), /даты/);
    assert.match(await reason(JSON.stringify({ format: 1, serial: 1, issuedAt: new Date(NOW).toISOString(), notAfter: new Date(NOW).toISOString() })), /нет keyId/);
    assert.match(await reason(JSON.stringify({ format: 1, serial: 1, issuedAt: new Date(NOW).toISOString(), notAfter: new Date(NOW).toISOString(), keyId: 'a', signature: 'b', keys: { zz: '' }, hashes: {} })), /недопустимая запись/);
    assert.throws(() => signRevocations({ serial: 0, issuedAt: new Date(), notAfter: new Date() }, release.secretKey), /serial/);
    assert.throws(() => signRevocations({ serial: 1, keys: { zz: '' }, issuedAt: new Date(), notAfter: new Date() }, release.secretKey), /keys\.zz/);
    assert.throws(() => signRevocations({ serial: 1, hashes: { zz: '' }, issuedAt: new Date(), notAfter: new Date() }, release.secretKey), /hashes\.zz/);
  });

  it('verifyRevocations с испорченным открытым ключом не бросает', () => {
    const list = signRevocations({ serial: 1, issuedAt: new Date(NOW), notAfter: new Date(NOW + day) }, release.secretKey);
    const keyId = (JSON.parse(list) as { keyId: string }).keyId;
    assert.equal(verifyRevocations(list, new Map([[keyId, 'ed25519:AAAA']]), NOW), 'список отзыва: подпись не сходится');
  });
});
