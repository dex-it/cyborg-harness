import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildPlugin } from '../src/build.ts';
import { cleanup, fresh } from './fixture.ts';

after(cleanup);

// Кроме служебной метки, по которой следующая сборка узнаёт свой каталог (BUILD_MARKER).
const withoutMarker = (files: string[]): string[] => files.filter((f) => f !== '.cyborg-plugin-build');

// P-06 п. 4: стенд собирается инструментом, и состав playground/dist/plugins не изменился: исходники плагина как есть, кроме ui/*.ts, плюс ui/*.js и карты.
const plugins = path.resolve(import.meta.dirname, '..', '..', '..', 'playground', 'plugins');

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])).sort();
}

describe('стенд на инструменте: состав результата прежний', () => {
  const homes = fs.readdirSync(plugins, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it('в стенде больше десяти плагинов, и видами обладают несколько', () => {
    assert.ok(homes.length > 10, String(homes.length));
    assert.ok(homes.filter((h) => fs.existsSync(path.join(plugins, h, 'ui'))).length >= 5);
  });

  for (const name of homes) {
    it(`ST-7001/2: ${name}: исходники как есть, кроме ui/*.ts; на каждый ui/*.ts - ui/*.js и карта`, async () => {
      const src = path.join(plugins, name);
      const out = fresh(name);
      const report = await buildPlugin(src, { out, main: 'source', check: false });
      assert.equal(report.ok, true, report.problems.map((p) => p.message).join('; '));
      const sources = walk(src);
      const views = sources.filter((f) => /^ui\/[^/]+\.ts$/.test(f));
      const want = [...sources.filter((f) => !views.includes(f)), ...views.flatMap((f) => [f.replace(/\.ts$/, '.js'), f.replace(/\.ts$/, '.js.map')])];
      assert.ok(walk(out).includes('.cyborg-plugin-build'), 'нет метки сборки');
      // Таблицу стилей и шрифт, которые модуль вида подтянул импортом (Monaco в editor), сборщик кладёт рядом с ним: это не исходники плагина.
      const generated = (f: string) => /^ui\/(ui\.css(\.map)?|[\w.-]+-[\w]+\.ttf)$/.test(f);
      assert.deepEqual(withoutMarker(walk(out)).filter((f) => !generated(f) || want.includes(f)), [...new Set(want)].sort());
      for (const f of sources.filter((s) => !views.includes(s))) {
        assert.deepEqual(fs.readFileSync(path.join(out, f)), fs.readFileSync(path.join(src, f)), `${f} изменён`);
      }
    });
  }
});
