import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { forkHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';
import { readDelivery, verifyDelivery, DELIVERY_FILE } from '@cyborg-harness/core/delivery';
import { formatProblem } from '@cyborg-harness/core/plugin-check';
import { generateSigningKey } from '@cyborg-harness/core/integrity';
import { buildDelivery } from '../src/delivery.ts';
import { runCli } from '../src/cli.ts';
import { cleanup, fresh, plugin, write } from './fixture.ts';

after(cleanup);

// P-07 п. 2: поставка приложения - каталог собранных плагинов и delivery.json; собирается инструментом P-06 (buildPlugin в режиме bundle).
const second = (id = 'acme.two') =>
  plugin(
    { 'index.ts': `export default { activate(ctx: { commands: { register(n: string, f: () => string): void } }) { ctx.commands.register('${id}.who', () => '${id}'); } };\n`, 'ui/ui.ts': null, 'ui/ui.css': null, 'config.schema.json': null },
    { id, version: '2.0.0', commands: { [`${id}.who`]: { args: [] } }, ui: undefined, config: undefined },
    {},
  );

const problems = (r: { problems: readonly Parameters<typeof formatProblem>[0][] }) => r.problems.map(formatProblem);

describe('buildDelivery: каталог поставки (P-07 п. 2)', () => {
  it('два плагина: каталог на плагин по id, index.mjs в каждом, delivery.json перечисляет все файлы, метки сборки в поставке нет; сверка чистая', async () => {
    const out = fresh('delivery');
    const report = await buildDelivery([plugin(), second()], { out });
    assert.deepEqual(problems(report), []);
    assert.equal(report.ok, true);
    assert.deepEqual(report.plugins, ['acme.dep', 'acme.two']);
    assert.deepEqual(fs.readdirSync(out).sort(), ['acme.dep', 'acme.two', DELIVERY_FILE]);
    assert.ok(fs.existsSync(path.join(out, 'acme.dep', 'index.mjs')) && fs.existsSync(path.join(out, 'acme.two', 'index.mjs')));
    const list = await readDelivery(out);
    assert.deepEqual(Object.keys(list?.plugins ?? {}), ['acme.dep', 'acme.two']);
    assert.deepEqual(Object.keys(list?.plugins['acme.two'] ?? {}).sort(), ['index.mjs', 'index.mjs.map', 'manifest.json']);
    assert.ok(!Object.keys(list?.plugins['acme.dep'] ?? {}).some((f) => f.startsWith('.')), 'служебная метка сборки в списке');
    assert.deepEqual(await verifyDelivery(out, list ?? { format: 1, plugins: {} }), []);
  });

  it('поставка = N плагинов, все активны: ядро поднимает каталог поставки в хосте builtin, команды отвечают, лишнего и пропущенного нет', async () => {
    const out = fresh('delivery');
    assert.equal((await buildDelivery([plugin(), second()], { out })).ok, true);
    const ids = fs.readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    assert.deepEqual(ids, ['acme.dep', 'acme.two']);
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ids,
      manifests: ids.map((id) => JSON.parse(fs.readFileSync(path.join(out, id, 'manifest.json'), 'utf8')) as unknown),
      bundled: ids,
      spawnHost: forkHosts(),
      entry: (m) => pathToFileURL(path.join(out, m.id, 'index.mjs')).href,
    });
    try {
      assert.deepEqual([...kernel.active].sort(), ids);
      assert.deepEqual(ids.map((id) => kernel.hostOf(id)), ['builtin', 'builtin']);
      assert.equal(await kernel.run('acme.two.who'), 'acme.two');
      assert.equal(await kernel.run('acme.dep.shout', 'х'), 'Х!');
    } finally {
      await kernel.unload();
    }
  });

  it('плагин с нарушением (node:fs): сборка отказывает, out не создан, временных каталогов не осталось', async () => {
    const out = fresh('delivery');
    const bad = plugin({ 'index.ts': "import fs from 'node:fs';\nexport default { activate() { fs.readFileSync('/'); } };\n" });
    const report = await buildDelivery([second(), bad], { out });
    assert.equal(report.ok, false);
    assert.ok(problems(report).some((p) => p.includes('node:fs')), problems(report).join('\n'));
    assert.ok(problems(report).some((p) => p.startsWith('acme.dep: ')), 'нарушение названо по плагину');
    assert.ok(!fs.existsSync(out));
    assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((n) => n.includes(path.basename(out))), []);
  });

  it('два каталога с одним id и каталог без манифеста - отказ с причиной', async () => {
    const out = fresh('delivery');
    const twice = await buildDelivery([plugin(), plugin()], { out });
    assert.equal(twice.ok, false);
    assert.match(problems(twice).join('\n'), /повтор id acme\.dep/);
    const none = fresh('nomanifest');
    fs.mkdirSync(none);
    const missing = await buildDelivery([none], { out });
    assert.equal(missing.ok, false);
    assert.ok(!fs.existsSync(out));
    assert.equal((await buildDelivery([], { out })).ok, false, 'пустой список - не поставка');
  });

  it('out: чужой непустой каталог - отказ, ничего не стёрто; прежняя поставка заменяется целиком (снятый плагин пропадает)', async () => {
    const foreign = fresh('foreign');
    write(foreign, { 'notes.txt': 'не трогать' });
    const refused = await buildDelivery([second()], { out: foreign });
    assert.equal(refused.ok, false);
    assert.match(problems(refused).join('\n'), /не пуст и не поставка/);
    assert.equal(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf8'), 'не трогать');

    const out = fresh('delivery');
    assert.equal((await buildDelivery([plugin(), second()], { out })).ok, true);
    assert.equal((await buildDelivery([second()], { out })).ok, true);
    assert.deepEqual(fs.readdirSync(out).sort(), ['acme.two', DELIVERY_FILE]);
    assert.deepEqual((await readDelivery(out))?.plugins && Object.keys((await readDelivery(out))?.plugins ?? {}), ['acme.two']);
  });

  it('отказ повторной сборки оставляет прежнюю поставку целой', async () => {
    const out = fresh('delivery');
    assert.equal((await buildDelivery([second()], { out })).ok, true);
    const before = fs.readFileSync(path.join(out, DELIVERY_FILE), 'utf8');
    const bad = plugin({ 'index.ts': "import fs from 'node:fs';\nexport default { activate() { fs.readFileSync('/'); } };\n" });
    assert.equal((await buildDelivery([second(), bad], { out })).ok, false);
    assert.equal(fs.readFileSync(path.join(out, DELIVERY_FILE), 'utf8'), before);
  });
});

describe('cyborg-plugin delivery (командная строка)', () => {
  async function cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  }

  it('несколько каталогов и --out: код 0, итог называет плагины и каталог', async () => {
    const out = fresh('delivery');
    const r = await cli('delivery', plugin(), second(), '--out', out);
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.ok(r.out.some((l) => l.includes('acme.dep') && l.includes('acme.two')), r.out.join('\n'));
    assert.ok(r.out.some((l) => l.includes(out)), r.out.join('\n'));
  });

  it('без --out и без каталогов - неверный вызов (код 2); нарушение в плагине - код 1', async () => {
    assert.equal((await cli('delivery', plugin())).code, 2);
    assert.equal((await cli('delivery', '--out', fresh('delivery'))).code, 2);
    const bad = plugin({ 'index.ts': "import fs from 'node:fs';\nexport default { activate() { fs.readFileSync('/'); } };\n" });
    const r = await cli('delivery', bad, '--out', fresh('delivery'));
    assert.equal(r.code, 1);
    assert.ok(r.err.some((l) => l.includes('node:fs')));
  });
});

describe('ST-3009/6: подпись поставки (TR-12)', () => {
  it('buildDelivery с ключом выпуска подписывает delivery.json; verifyDelivery с открытым ключом чисто, без подписи и с чужим ключом - отказ', async () => {
    const key = generateSigningKey();
    const out = fresh('delivery');
    const report = await buildDelivery([plugin(), second()], { out, sign: { secretKey: key.secretKey, notAfter: new Date(Date.now() + 86_400_000) } });
    assert.deepEqual(problems(report), []);
    assert.equal(report.keyId, key.keyId);
    const list = await readDelivery(out);
    assert.equal(list?.signature?.keyId, key.keyId);
    assert.deepEqual(await verifyDelivery(out, list, { releaseKeys: [key.publicKey] }), []);
    assert.match((await verifyDelivery(out, list, { releaseKeys: [generateSigningKey().publicKey] }))[0] ?? '', /которого нет среди ключей выпуска/);
    const plain = fresh('delivery');
    assert.equal((await buildDelivery([plugin()], { out: plain })).keyId, undefined);
    assert.match((await verifyDelivery(plain, (await readDelivery(plain)) ?? { format: 1, plugins: {} }, { releaseKeys: [key.publicKey] }))[0] ?? '', /не подписан ключом выпуска/);
  });

  it('cyborg-plugin delivery --sign-key: подпись и срок; --days без ключа, плохой ключ и срок в прошлом - отказ', async () => {
    const prefix = fresh('rel');
    const lines: string[] = [];
    const run = async (...argv: string[]) => {
      lines.length = 0;
      const code = await runCli(argv, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
      return { code, text: lines.join('\n') };
    };
    assert.equal((await run('keygen', '--out', prefix)).code, 0);
    const out = fresh('delivery');
    const signed = await run('delivery', plugin(), '--out', out, '--sign-key', `${prefix}.key`, '--days', '30');
    assert.equal(signed.code, 0, signed.text);
    assert.match(signed.text, /delivery\.json подписан ключом выпуска [0-9a-f]{32}/);
    const list = await readDelivery(out);
    assert.ok(Date.parse(list?.signature?.notAfter ?? '') > Date.now() + 29 * 86_400_000);
    const unsigned = await run('delivery', plugin(), '--out', fresh('delivery'));
    assert.match(unsigned.text, /delivery\.json не подписан \(нет --sign-key\)/);
    assert.equal((await run('delivery', plugin(), '--out', fresh('delivery'), '--days', '5')).code, 2);
    assert.equal((await run('delivery', plugin(), '--out', fresh('delivery'), '--sign-key', `${prefix}.key`, '--days', '5', '--expires', '2099-01-01')).code, 2);
    assert.equal((await run('delivery', plugin(), '--out', fresh('delivery'), '--sign-key', `${prefix}.key`, '--expires', '2001-01-01')).code, 2);
    assert.equal((await run('delivery', plugin(), '--out', fresh('delivery'), '--sign-key', `${prefix}.pub`)).code, 1, 'открытый ключ вместо закрытого');
    assert.equal((await run('delivery', plugin(), '--out', fresh('delivery'), '--sign-key', `${prefix}.нет`)).code, 1);
  });
});
