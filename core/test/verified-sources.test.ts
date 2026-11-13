import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hasVerified, installVerified, releaseVerified } from '../src/verified-sources.ts';

// TR-11: хук загрузки модулей отдаёт проверенные байты вместо файла на диске. Формат по расширению и ближайшему проверенному package.json.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-verified-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;

/** Каталог с файлами на диске (`disk`) и проверенный набор (`verified`): модули грузятся из второго, а первый нужен только для разрешения адреса. */
function setup(disk: Record<string, string>, verified: Record<string, string>): { dir: string; url: (rel: string) => string; id: string } {
  const dir = path.join(root, `p${String(++counter)}`);
  for (const [name, text] of Object.entries(disk)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const id = `plugin-${String(counter)}`;
  installVerified(id, { base: pathToFileURL(`${fs.realpathSync(dir)}${path.sep}`).href, files: Object.fromEntries(Object.entries(verified).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) });
  return { dir, id, url: (rel) => pathToFileURL(path.join(fs.realpathSync(dir), rel)).href };
}

describe('ST-3009/3: проверенные байты вместо файла на диске', () => {
  it('.mjs и .json: исполняется проверенное, на диске иное; .json грузится как json', async () => {
    const t = setup({ 'a.mjs': "export default 'DISK';", 'd.json': '{"v":"DISK"}' }, { 'a.mjs': "export default 'VERIFIED';", 'd.json': '{"v":"VERIFIED"}' });
    assert.equal(hasVerified(t.id), true);
    assert.equal(((await import(t.url('a.mjs'))) as { default: string }).default, 'VERIFIED');
    const json = (await import(t.url('d.json'), { with: { type: 'json' } })) as { default: { v: string } };
    assert.equal(json.default.v, 'VERIFIED');
  });

  it('.cjs - commonjs, .js - по ближайшему проверенному package.json: module, commonjs, битый - commonjs, нет - commonjs', async () => {
    const cjs = "module.exports = 'CJS-VERIFIED';";
    const esm = "export default 'ESM-VERIFIED';";
    const t = setup(
      { 'c.cjs': 'x', 'esm/x.js': 'x', 'esm/package.json': '{}', 'sub/deep/y.js': 'x', 'sub/package.json': '{}', 'bad/z.js': 'x', 'bad/package.json': '{}', 'none.js': 'x' },
      {
        'c.cjs': cjs,
        'esm/package.json': '{"type":"module"}',
        'esm/x.js': esm,
        'sub/package.json': '{"type":"commonjs"}',
        'sub/deep/y.js': "module.exports = 'CJS-FROM-PARENT';",
        'bad/package.json': '{ нет',
        'bad/z.js': "module.exports = 'CJS-BAD-PACKAGE';",
        'none.js': "module.exports = 'CJS-NO-PACKAGE';",
      },
    );
    assert.equal(((await import(t.url('c.cjs'))) as { default: string }).default, 'CJS-VERIFIED');
    assert.equal(((await import(t.url('esm/x.js'))) as { default: string }).default, 'ESM-VERIFIED');
    assert.equal(((await import(t.url('sub/deep/y.js'))) as { default: string }).default, 'CJS-FROM-PARENT');
    assert.equal(((await import(t.url('bad/z.js'))) as { default: string }).default, 'CJS-BAD-PACKAGE');
    assert.equal(((await import(t.url('none.js'))) as { default: string }).default, 'CJS-NO-PACKAGE');
  });

  it('файл под каталогом, которого нет среди проверенных, не загружается, даже если он на диске; чужие адреса идут как обычно', async () => {
    const t = setup({ 'a.mjs': 'export default 1;', 'late.mjs': 'export default 2;' }, { 'a.mjs': 'export default 1;' });
    await assert.rejects(import(t.url('late.mjs')), /late\.mjs: файла нет среди проверенных/);
    assert.equal(typeof ((await import('node:path')) as { sep: string }).sep, 'string');
    const outside = path.join(root, `outside${String(counter)}.mjs`);
    fs.writeFileSync(outside, "export default 'OUTSIDE';");
    assert.equal(((await import(pathToFileURL(outside).href)) as { default: string }).default, 'OUTSIDE');
  });

  it('releaseVerified снимает набор; повторная установка заменяет прежнюю', () => {
    const t = setup({ 'a.mjs': 'x' }, { 'a.mjs': 'export default 1;' });
    assert.equal(hasVerified(t.id), true);
    releaseVerified(t.id);
    assert.equal(hasVerified(t.id), false);
    releaseVerified(t.id);
  });
});
