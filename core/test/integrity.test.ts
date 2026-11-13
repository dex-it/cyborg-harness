import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  canonicalBytes,
  checkPublicKey,
  generateSigningKey,
  hashFiles,
  INTEGRITY_FILE,
  keyIdOf,
  parseIntegrity,
  publicKeyOf,
  readPackageTree,
  renderIntegrity,
  sha256Hex,
  signIntegrity,
  verifyIntegrity,
  type PackageBytes,
  type VerifyPolicy,
} from '../src/integrity.ts';

// TR-10 (ADR-CH-0017): формат подписанного пакета. Ключи создаются на лету в каждом прогоне, в репозитории секретов нет.
const NOW = Date.parse('2026-11-13T12:00:00Z');
const enc = (text: string) => new TextEncoder().encode(text);

function pack(files: Record<string, string> = { 'manifest.json': '{"id":"acme.p","version":"1.2.3"}', 'index.mjs': 'export default {}', 'ui/view.js': 'export const v = 1;' }) {
  const key = generateSigningKey();
  const map = new Map(Object.entries(files).map(([name, text]) => [name, enc(text)]));
  const manifest = signIntegrity({ id: 'acme.p', version: '1.2.3', files: hashFiles(map), notAfter: new Date('2027-01-01T00:00:00Z') }, key.secretKey);
  const bytes: PackageBytes = { files: map, integrity: renderIntegrity(manifest) };
  const policy: VerifyPolicy = { keys: new Map([[key.keyId, key.publicKey]]), now: NOW, expect: { id: 'acme.p', version: '1.2.3' } };
  return { key, map, manifest, bytes, policy };
}

const code = (v: ReturnType<typeof verifyIntegrity>) => (v.ok ? 'ok' : v.code);

describe('ST-3009/1: подписанный пакет - ключи и запись', () => {
  it('ключ: открытый и закрытый вид, идентификатор от открытого, открытый выводится из закрытого', () => {
    const key = generateSigningKey();
    assert.match(key.publicKey, /^ed25519:[A-Za-z0-9+/]{43}=$/);
    assert.match(key.secretKey, /^ed25519-secret:[A-Za-z0-9+/]{43}=$/);
    assert.match(key.keyId, /^[0-9a-f]{32}$/);
    assert.equal(keyIdOf(key.publicKey), key.keyId);
    assert.equal(publicKeyOf(key.secretKey), key.publicKey);
    assert.notEqual(generateSigningKey().keyId, key.keyId);
    assert.equal(checkPublicKey(key.publicKey), undefined);
    assert.match(checkPublicKey('ed25519:AAAA') ?? '', /32 байт/);
    assert.match(checkPublicKey('rsa:xx') ?? '', /ed25519:/);
  });

  it('запись: подпись детерминирована для тех же полей, порядок файлов не важен, текст читается обратно', () => {
    const { manifest, key } = pack();
    const again = signIntegrity({ id: 'acme.p', version: '1.2.3', files: Object.fromEntries(Object.entries(manifest.files).reverse()), notAfter: new Date(manifest.notAfter) }, key.secretKey);
    assert.deepEqual(again, manifest, 'Ed25519 детерминирован, файлы сортируются');
    assert.deepEqual(parseIntegrity(renderIntegrity(manifest)), manifest);
    assert.ok(canonicalBytes(manifest).toString().startsWith('cyborg-plugin-integrity/v1\n{"format":1,"id":"acme.p"'));
    assert.deepEqual(Object.keys(manifest.files), ['index.mjs', 'manifest.json', 'ui/view.js']);
  });

  it('разбор строг: лишнее поле, чужой формат, плохой путь и хеш, дата не в виде toISOString - отказ с причиной', () => {
    const { manifest } = pack();
    const text = (r: ReturnType<typeof parseIntegrity>) => (typeof r === 'string' ? r : 'ПРИНЯТО');
    const bad = (patch: Record<string, unknown>) => text(parseIntegrity(JSON.stringify({ ...manifest, ...patch })));
    assert.match(text(parseIntegrity('{ нет')), /не разобран/);
    assert.match(text(parseIntegrity('[]')), /ожидался объект/);
    assert.match(bad({ extra: 1 }), /лишние поля extra/);
    assert.match(bad({ format: 2 }), /формат 2/);
    assert.match(bad({ id: '' }), /нет id/);
    assert.match(bad({ version: 'v1' }), /version/);
    assert.match(bad({ keyId: 'abc' }), /keyId/);
    assert.match(bad({ notAfter: '2027-01-01' }), /notAfter/);
    assert.match(bad({ signature: '' }), /нет подписи/);
    assert.match(bad({ files: [] }), /files/);
    assert.match(bad({ files: { '../x': manifest.files['index.mjs'] } }), /недопустимый путь/);
    assert.match(bad({ files: { [INTEGRITY_FILE]: manifest.files['index.mjs'] } }), /в список файлов не входит/);
    assert.match(bad({ files: { 'a.js': 'xyz' } }), /sha256/);
    assert.throws(() => signIntegrity({ id: 'a', version: '1.0.0', files: { '/abs': sha256Hex('x') }, notAfter: new Date() }, generateSigningKey().secretKey), /недопустимый путь/);
    assert.throws(() => signIntegrity({ id: 'a', version: '1.0.0', files: {}, notAfter: new Date('nope') }, generateSigningKey().secretKey), /срок подписи/);
  });
});

describe('ST-3009/1: verify - негативные проверки', () => {
  it('цельный пакет проходит, digest - sha256 канонической записи', () => {
    const { bytes, policy, manifest } = pack();
    const verdict = verifyIntegrity(bytes, policy);
    assert.ok(verdict.ok);
    assert.equal(verdict.digest, sha256Hex(canonicalBytes(manifest)));
  });

  it('изменён один байт файла - modified, и файл назван', () => {
    const { bytes, policy, map } = pack();
    const evil = new Uint8Array(map.get('index.mjs') ?? []);
    evil[0] = (evil[0] ?? 0) ^ 1;
    const v = verifyIntegrity({ ...bytes, files: new Map([...map, ['index.mjs', evil]]) }, policy);
    assert.equal(code(v), 'modified');
    assert.match(v.ok ? '' : v.reason, /index\.mjs/);
  });

  it('лишний файл - extra; пропавший - missing; ссылка - symlink', () => {
    const { bytes, policy, map } = pack();
    assert.equal(code(verifyIntegrity({ ...bytes, files: new Map([...map, ['.hidden.mjs', enc('x')]]) }, policy)), 'extra');
    const fewer = new Map(map);
    fewer.delete('ui/view.js');
    assert.equal(code(verifyIntegrity({ ...bytes, files: fewer }, policy)), 'missing');
    assert.equal(code(verifyIntegrity({ ...bytes, links: new Map([['evil', '/etc/passwd']]) }, policy)), 'symlink');
  });

  it('чужой ключ - unknown-key; подпись другого ключа под идентификатором доверенного - bad-signature', () => {
    const { bytes, policy, manifest } = pack();
    assert.equal(code(verifyIntegrity(bytes, { ...policy, keys: new Map([[generateSigningKey().keyId, generateSigningKey().publicKey]]) })), 'unknown-key');
    assert.equal(code(verifyIntegrity(bytes, { ...policy, keys: new Map() })), 'unknown-key');
    // Злоумышленник подписал своим ключом, но в записи выставил keyId доверенного.
    const mallory = generateSigningKey();
    const forged = signIntegrity({ id: manifest.id, version: manifest.version, files: manifest.files, notAfter: new Date(manifest.notAfter) }, mallory.secretKey);
    const asTrusted = { ...forged, keyId: manifest.keyId };
    assert.equal(code(verifyIntegrity({ ...bytes, integrity: JSON.stringify(asTrusted) }, policy)), 'bad-signature');
    // Ключ в списке лежит под чужим идентификатором.
    assert.equal(code(verifyIntegrity(bytes, { ...policy, keys: new Map([[manifest.keyId, mallory.publicKey]]) })), 'unknown-key');
  });

  it('правка любого поля записи ломает подпись: версия, срок, хеш', () => {
    const { bytes, policy, manifest } = pack();
    const tamper = (patch: Record<string, unknown>, expect = policy.expect) => verifyIntegrity({ ...bytes, integrity: JSON.stringify({ ...manifest, ...patch }) }, { ...policy, expect });
    assert.equal(code(tamper({ version: '9.9.9' }, undefined)), 'bad-signature');
    assert.equal(code(tamper({ notAfter: '2099-01-01T00:00:00.000Z' })), 'bad-signature');
    assert.equal(code(tamper({ files: { ...manifest.files, 'index.mjs': sha256Hex('другое') } })), 'bad-signature');
  });

  it('срок истёк - expired; ровно в срок ещё действует', () => {
    const { bytes, policy, manifest } = pack();
    assert.equal(code(verifyIntegrity(bytes, { ...policy, now: Date.parse(manifest.notAfter) + 1 })), 'expired');
    assert.equal(code(verifyIntegrity(bytes, { ...policy, now: Date.parse(manifest.notAfter) })), 'ok');
  });

  it('id и версия должны совпасть с manifest.json пакета', () => {
    const { bytes, policy } = pack();
    assert.equal(code(verifyIntegrity(bytes, { ...policy, expect: { id: 'acme.other' } })), 'mismatch');
    assert.equal(code(verifyIntegrity(bytes, { ...policy, expect: { version: '1.2.4' } })), 'mismatch');
  });

  it('нет integrity.json - no-integrity; битый - malformed', () => {
    const { bytes, policy } = pack();
    assert.equal(code(verifyIntegrity({ files: bytes.files }, policy)), 'no-integrity');
    assert.equal(code(verifyIntegrity({ ...bytes, integrity: '{ нет' }, policy)), 'malformed');
    assert.equal(code(verifyIntegrity({ ...bytes, integrity: enc(String(bytes.integrity)) }, policy)), 'ok', 'байты принимаются как и текст');
  });

  it('версия ниже виденной - rollback; равная и выше проходят', () => {
    const { bytes, policy } = pack();
    assert.equal(code(verifyIntegrity(bytes, { ...policy, highestSeen: '1.3.0' })), 'rollback');
    assert.equal(code(verifyIntegrity(bytes, { ...policy, highestSeen: '1.2.3' })), 'ok');
    assert.equal(code(verifyIntegrity(bytes, { ...policy, highestSeen: '0.9.0' })), 'ok');
  });

  it('отозванный ключ и отозванный хеш (выпуска или файла) - отказ, хотя подпись верна', () => {
    const { bytes, policy, manifest, map } = pack();
    assert.equal(code(verifyIntegrity(bytes, { ...policy, revokedKeys: new Set([manifest.keyId]) })), 'revoked-key');
    const digest = sha256Hex(canonicalBytes(manifest));
    assert.equal(code(verifyIntegrity(bytes, { ...policy, revokedHashes: new Set([digest]) })), 'revoked-hash');
    const v = verifyIntegrity(bytes, { ...policy, revokedHashes: new Set([sha256Hex(map.get('index.mjs') ?? '')]) });
    assert.equal(code(v), 'revoked-hash');
    assert.match(v.ok ? '' : v.reason, /index\.mjs/);
    assert.equal(code(verifyIntegrity(bytes, { ...policy, revokedHashes: new Set(['0'.repeat(64)]), revokedKeys: new Set(['f'.repeat(32)]) })), 'ok');
  });

  it('открытый ключ испорчен - bad-signature с причиной, а не исключение', () => {
    const { bytes, policy, manifest } = pack();
    assert.equal(code(verifyIntegrity(bytes, { ...policy, keys: new Map([[manifest.keyId, 'ed25519:AAAA']]) })), 'bad-signature');
  });
});

describe('ST-3009/1: чтение пакета с диска', () => {
  it('readPackageTree читает все файлы один раз, integrity.json отдельно, ссылки не раскрывает', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-integrity-'));
    fs.mkdirSync(path.join(dir, 'ui'));
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'a');
    fs.writeFileSync(path.join(dir, 'ui', 'v.js'), 'b');
    fs.writeFileSync(path.join(dir, '.hidden'), 'c');
    fs.writeFileSync(path.join(dir, INTEGRITY_FILE), '{}');
    fs.mkdirSync(path.join(dir, 'ui', 'sub'));
    fs.writeFileSync(path.join(dir, 'ui', 'sub', INTEGRITY_FILE), 'вложенный');
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link'));
    const tree = await readPackageTree(dir);
    assert.deepEqual([...tree.files.keys()], ['.hidden', 'index.mjs', 'ui/sub/integrity.json', 'ui/v.js']);
    assert.equal(tree.integrity?.toString(), '{}');
    assert.deepEqual([...tree.links], [['link', '/etc/hosts']]);
    fs.rmSync(dir, { recursive: true });
  });
});
