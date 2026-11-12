import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { inlineHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';
import { checkPlugin, formatProblem } from '@cyborg-harness/core/plugin-check';
import type { PluginModule } from '@cyborg-harness/contracts';
import { buildPlugin } from '../src/build.ts';
import { packPlugin } from '../src/pack.ts';
import { cleanup, fresh } from './fixture.ts';

after(cleanup);

// P-05: шаблон templates/plugin проходит сборщик и упаковку P-06 как плагин вне репозитория; собранный результат грузится ядром.
const template = path.resolve(import.meta.dirname, '..', '..', '..', 'templates', 'plugin');
const problems = (r: { problems: readonly Parameters<typeof formatProblem>[0][] }) => r.problems.map(formatProblem);

describe('templates/plugin на сборщике (P-06)', () => {
  it('сборка: состав результата, проверка собранного каталога, упаковка', async () => {
    const out = fresh('template');
    const report = await buildPlugin(template, { out });
    assert.deepEqual(problems(report), []);
    assert.deepEqual(report.warnings, []);
    const files = fs.readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((f) => fs.statSync(path.join(out, f)).isFile()).map((f) => f.split(path.sep).join('/')).sort();
    assert.deepEqual(files, ['.cyborg-plugin-build', 'config.schema.json', 'index.mjs', 'index.mjs.map', 'manifest.json', 'ui/ui.js', 'ui/ui.js.map']);
    const checked = await checkPlugin(out, { bundled: false });
    assert.deepEqual(problems(checked), []);

    const archive = path.join(fresh('archive'), 'example.tgz');
    fs.mkdirSync(path.dirname(archive));
    const packed = await packPlugin(out, { out: archive });
    assert.deepEqual(problems(packed), []);
    assert.deepEqual(packed.files.map((f) => f.path), ['config.schema.json', 'index.mjs', 'index.mjs.map', 'manifest.json', 'ui/ui.js', 'ui/ui.js.map']);
  });

  it('собранный index.mjs грузится ядром: плагин активен, команда отвечает', async () => {
    const out = fresh('template');
    assert.deepEqual(problems(await buildPlugin(template, { out })), []);
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const module = ((await import(path.join(out, 'index.mjs'))) as { default: PluginModule }).default;
    const kernel = await load({ apiVersion: PLUGIN_API_VERSION, enabled: ['example'], manifests: [manifest], spawnHost: inlineHosts(async () => module) });
    try {
      assert.deepEqual(kernel.active, ['example']);
      assert.equal(await kernel.run('example.hello'), 'привет');
    } finally {
      await kernel.unload();
    }
  });
});
