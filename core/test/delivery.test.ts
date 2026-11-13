import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DELIVERY_FILE, readDelivery, verifyDelivery, verifyDeliverySignature, writeDelivery } from '../src/delivery.ts';
import { generateSigningKey } from '../src/integrity.ts';

// P-07: контрольные суммы поставки. Формат - delivery.json в каталоге поставки: плагин -> файл (путь через /) -> sha256.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-delivery-'));

function put(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

/** Поставка из двух плагинов: у второго вложенный каталог. */
function catalog(): string {
  const root = tmp();
  put(root, 'alpha/manifest.json', '{"id":"alpha"}');
  put(root, 'alpha/index.mjs', 'export default {}');
  put(root, 'beta/manifest.json', '{"id":"beta"}');
  put(root, 'beta/index.mjs', 'export default {}');
  put(root, 'beta/ui/view.js', 'export const v = 1;');
  return root;
}

describe('поставка: запись и чтение', () => {
  it('writeDelivery хеширует файлы каждого плагина, пути через /, по алфавиту; sha256 в hex', async () => {
    const root = catalog();
    const written = await writeDelivery(root);
    assert.equal(written.format, 1);
    assert.deepEqual(Object.keys(written.plugins), ['alpha', 'beta']);
    assert.deepEqual(Object.keys(written.plugins.beta ?? {}), ['index.mjs', 'manifest.json', 'ui/view.js']);
    assert.match(written.plugins.alpha?.['index.mjs'] ?? '', /^[0-9a-f]{64}$/);
    assert.equal(written.plugins.alpha?.['index.mjs'], '9aeb8d59b4d483ca6298e9a450fbf37dfd2b4c63990135ab1d040d76314087ec', 'sha256 от «export default {}»');
    assert.deepEqual(await readDelivery(root), written, 'файл на диске читается обратно');
    assert.ok(fs.existsSync(path.join(root, DELIVERY_FILE)));
  });

  it('хеш - sha256 содержимого: одинаковые файлы дают одинаковую сумму, разные - разную', async () => {
    const root = catalog();
    put(root, 'alpha/same.txt', 'x');
    put(root, 'beta/same.txt', 'x');
    put(root, 'beta/other.txt', 'y');
    const { plugins } = await writeDelivery(root);
    assert.equal(plugins.alpha?.['same.txt'], plugins.beta?.['same.txt']);
    assert.notEqual(plugins.beta?.['same.txt'], plugins.beta?.['other.txt']);
    assert.equal(plugins.alpha?.['same.txt'], '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881', 'sha256 от «x»');
  });

  it('записанный файл не входит в хеши: пересчёт на той же поставке даёт тот же результат', async () => {
    const root = catalog();
    const first = await writeDelivery(root);
    const second = await writeDelivery(root);
    assert.deepEqual(second, first);
  });

  it('файлы в корне поставки (не в каталоге плагина) в список не входят', async () => {
    const root = catalog();
    put(root, 'README.txt', 'не плагин');
    assert.deepEqual(Object.keys((await writeDelivery(root)).plugins), ['alpha', 'beta']);
  });

  it('readDelivery: нет файла - undefined; битый JSON и чужой формат - отказ с причиной', async () => {
    const root = tmp();
    assert.equal(await readDelivery(root), undefined);
    fs.writeFileSync(path.join(root, DELIVERY_FILE), '{ нет');
    await assert.rejects(readDelivery(root), /delivery\.json/);
    fs.writeFileSync(path.join(root, DELIVERY_FILE), JSON.stringify({ format: 2, plugins: {} }));
    await assert.rejects(readDelivery(root), /формат 2/);
    fs.writeFileSync(path.join(root, DELIVERY_FILE), JSON.stringify({ format: 1, plugins: { a: { 'x.js': 'не хеш' } } }));
    await assert.rejects(readDelivery(root), /a\/x\.js/);
    fs.writeFileSync(path.join(root, DELIVERY_FILE), JSON.stringify({ format: 1 }));
    await assert.rejects(readDelivery(root), /plugins/);
  });
});

describe('поставка: проверка', () => {
  it('нетронутая поставка - расхождений нет', async () => {
    const root = catalog();
    const manifest = await writeDelivery(root);
    assert.deepEqual(await verifyDelivery(root, manifest), []);
  });

  it('изменённый файл называет плагин, файл и обе суммы (по 12 знаков)', async () => {
    const root = catalog();
    const manifest = await writeDelivery(root);
    const was = manifest.plugins.alpha?.['index.mjs'] ?? '';
    fs.writeFileSync(path.join(root, 'alpha/index.mjs'), 'export default { подмена: true }');
    const problems = await verifyDelivery(root, manifest);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /alpha\/index\.mjs/);
    assert.ok((problems[0] ?? '').includes(was.slice(0, 12)), 'ожидаемая сумма названа');
    assert.match(problems[0] ?? '', /контрольная сумма не совпала/);
  });

  it('пропавший файл, лишний файл, пропавший каталог плагина, лишний каталог - каждое отдельной строкой', async () => {
    const root = catalog();
    const manifest = await writeDelivery(root);
    fs.rmSync(path.join(root, 'beta/ui/view.js'));
    put(root, 'alpha/extra.js', 'вброшен');
    put(root, 'gamma/manifest.json', '{"id":"gamma"}');
    fs.rmSync(path.join(root, 'beta'), { recursive: true });
    const problems = await verifyDelivery(root, manifest);
    assert.deepEqual(problems.sort(), [
      'alpha/extra.js: файла нет в delivery.json',
      'beta: каталога плагина нет в поставке',
      'gamma: каталога плагина нет в delivery.json',
    ]);
  });

  it('пропавший файл при живом каталоге плагина - строка «файла нет в поставке»', async () => {
    const root = catalog();
    const manifest = await writeDelivery(root);
    fs.rmSync(path.join(root, 'beta/ui/view.js'));
    assert.deepEqual(await verifyDelivery(root, manifest), ['beta/ui/view.js: файла нет в поставке']);
  });

  it('файл подменён ссылкой: запись отличается от хеша и проверка это видит', async () => {
    const root = catalog();
    const manifest = await writeDelivery(root);
    fs.rmSync(path.join(root, 'alpha/index.mjs'));
    fs.symlinkSync(path.join(root, 'beta/index.mjs'), path.join(root, 'alpha/index.mjs'));
    const problems = await verifyDelivery(root, manifest);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /alpha\/index\.mjs.*контрольная сумма не совпала/);
  });

  it('нет каталога поставки - все плагины из списка пропали, а не исключение', async () => {
    const root = catalog();
    const manifest = await writeDelivery(root);
    fs.rmSync(root, { recursive: true });
    assert.deepEqual((await verifyDelivery(root, manifest)).sort(), ['alpha: каталога плагина нет в поставке', 'beta: каталога плагина нет в поставке']);
  });
});

describe('ST-3009/6: подпись delivery.json (TR-12)', () => {
  const NOW = Date.parse('2026-11-13T12:00:00Z');
  const future = new Date(NOW + 86_400_000);

  it('подписанный список читается обратно, проходит verifyDelivery с ключами выпуска; подпись не мешает старому разбору хешей', async () => {
    const root = catalog();
    const key = generateSigningKey();
    const written = await writeDelivery(root, { sign: { secretKey: key.secretKey, notAfter: future } });
    assert.equal(written.signature?.keyId, key.keyId);
    assert.equal(written.signature.notAfter, future.toISOString());
    const read = await readDelivery(root);
    assert.deepEqual(read, written);
    assert.deepEqual(await verifyDelivery(root, read, { releaseKeys: [key.publicKey], now: NOW }), []);
    assert.deepEqual(verifyDeliverySignature(written, [key.publicKey], NOW), { ok: true, keyId: key.keyId, notAfter: future.toISOString() });
    const plain = await writeDelivery(root);
    assert.deepEqual(plain.plugins, written.plugins, 'хеши те же, подпись - надстройка');
    assert.equal('signature' in plain, false);
  });

  it('verifyDelivery отказывает: нет подписи, правленный список, чужой ключ, истёкший срок, подмена хеша; без ключей подпись не проверяется', async () => {
    const root = catalog();
    const key = generateSigningKey();
    const signed = await writeDelivery(root, { sign: { secretKey: key.secretKey, notAfter: future } });
    const reason = async (manifest: Parameters<typeof verifyDelivery>[1], keys: string[] = [key.publicKey], now = NOW) => (await verifyDelivery(root, manifest, { releaseKeys: keys, now }))[0] ?? 'чисто';
    assert.match(await reason({ format: 1, plugins: signed.plugins }), /не подписан ключом выпуска/);
    assert.match(await reason(signed, [generateSigningKey().publicKey]), /ключом .* которого нет среди ключей выпуска/);
    assert.match(await reason(signed, [], NOW), /которого нет среди ключей выпуска/);
    assert.match(await reason(signed, [key.publicKey], future.getTime() + 1), /срок подписи delivery\.json истёк/);
    const forged = { ...signed, plugins: { ...signed.plugins, alpha: { ...signed.plugins.alpha, 'index.mjs': 'f'.repeat(64) } } };
    const problems = await verifyDelivery(root, forged, { releaseKeys: [key.publicKey], now: NOW });
    assert.match(problems[0] ?? '', /подпись delivery\.json не сходится/);
    assert.ok(problems.some((p) => p.includes('alpha/index.mjs: контрольная сумма не совпала')), 'и сверка файлов идёт дальше');
    assert.match(await reason({ ...signed, signature: { ...signed.signature!, notAfter: '2099-01-01T00:00:00.000Z' } }), /подпись delivery\.json не сходится/);
    assert.deepEqual(await verifyDelivery(root, { format: 1, plugins: signed.plugins }), [], 'без releaseKeys подпись не требуется');
    assert.equal(verifyDeliverySignature({ ...signed, signature: { keyId: key.keyId, notAfter: 'не дата', value: 'x' } }, [key.publicKey], NOW).ok, false);
    await assert.rejects(writeDelivery(root, { sign: { secretKey: key.secretKey, notAfter: new Date('nope') } }), /ожидалась дата/);
  });

  it('readDelivery: поле signature неверной формы - отказ с причиной', async () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, DELIVERY_FILE), JSON.stringify({ format: 1, plugins: {}, signature: { keyId: 1 } }));
    await assert.rejects(readDelivery(root), /signature - ожидались keyId, notAfter и value/);
  });
});
