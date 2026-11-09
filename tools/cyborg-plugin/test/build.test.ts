import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { forkHosts, load, PLUGIN_API_VERSION } from '@cyborg-harness/core';
import { formatProblem } from '@cyborg-harness/core/plugin-check';
import { buildPlugin } from '../src/build.ts';
import { cleanup, fresh, plugin, write } from './fixture.ts';

after(cleanup);

const problems = (r: { problems: readonly Parameters<typeof formatProblem>[0][] }) => r.problems.map(formatProblem);
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

describe('buildPlugin: bundle (P-06 п. 2)', () => {
  it('плагин с npm-зависимостью: manifest.json + index.mjs + ui/*.js + схема, зависимость внутри', async () => {
    const dir = plugin();
    const out = fresh('out');
    const report = await buildPlugin(dir, { out });
    assert.deepEqual(problems(report), []);
    assert.equal(report.ok, true);
    assert.equal(report.id, 'acme.dep');
    assert.deepEqual(report.files, ['config.schema.json', 'index.mjs', 'index.mjs.map', 'manifest.json', 'ui/ui.css', 'ui/ui.js', 'ui/ui.js.map']);
    assert.deepEqual(JSON.parse(read(out, 'manifest.json')), JSON.parse(read(dir, 'manifest.json')));
    assert.ok(!/(?:from|import|require\()\s*\(?\s*['"]tiny-dep['"]/.test(read(out, 'index.mjs')), 'зависимость осталась импортом');
    assert.match(read(out, 'index.mjs'), /toUpperCase/, 'код зависимости не попал в бандл');
    assert.match(read(out, 'ui/ui.js'), /toUpperCase/, 'код зависимости не попал в бандл вида');
    assert.match(read(out, 'index.mjs'), /sourceMappingURL=index\.mjs\.map/);
    assert.deepEqual((JSON.parse(read(out, 'index.mjs.map')) as { sources: string[] }).sources.filter((s) => s.endsWith('index.ts')).length, 1, 'карта не ведёт к index.ts');
  });

  it('собранный каталог грузится ядром в forkHosts без node_modules рядом и исполняет код зависимости', async () => {
    const built = fresh('out');
    assert.equal((await buildPlugin(plugin(), { out: built })).ok, true);
    // Копия в чистый каталог: в нём нет node_modules, найти зависимость Node не может, значит она в бандле.
    const home = fresh('home');
    fs.cpSync(built, home, { recursive: true });
    const manifest = JSON.parse(read(home, 'manifest.json')) as unknown;
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ['acme.dep'],
      manifests: [manifest],
      spawnHost: forkHosts(),
      entry: () => pathToFileURL(path.join(home, 'index.mjs')).href,
    });
    try {
      assert.equal(await kernel.run('acme.dep.shout', 'привет'), 'ПРИВЕТ!');
    } finally {
      await kernel.unload();
    }
  });

  it('исходник главной части с npm-пакетом без сборки в хосте не загрузился бы: проверка того, что тест выше ловит отсутствие бандла', async () => {
    const dir = plugin({ 'index.mjs': "import { shout } from 'tiny-dep';\nexport default { activate(ctx) { ctx.commands.register('acme.dep.shout', shout); } };\n" });
    const home = fresh('home');
    fs.cpSync(dir, home, { recursive: true, filter: (from) => !from.includes('node_modules') });
    const kernel = await load({
      apiVersion: PLUGIN_API_VERSION,
      enabled: ['acme.dep'],
      manifests: [JSON.parse(read(home, 'manifest.json')) as unknown],
      spawnHost: forkHosts(),
      entry: () => pathToFileURL(path.join(home, 'index.mjs')).href,
    });
    try {
      await assert.rejects(kernel.run('acme.dep.shout', 'x'));
    } finally {
      await kernel.unload();
    }
  });

  it('вид: ui/*.ts собирается в ESM ui/*.js, прочие файлы ui/ едут как есть, вложенные исходники в результат не попадают', async () => {
    const dir = plugin({ 'ui/lib/extra.ts': "export const extra = 'x';\n", 'ui/ui.ts': "import { extra } from './lib/extra.ts';\nexport function mount(): string { return extra; }\n", 'ui/img/logo.svg': '<svg/>' });
    const out = fresh('out');
    const report = await buildPlugin(dir, { out });
    assert.deepEqual(problems(report), []);
    assert.ok(report.files.includes('ui/img/logo.svg') && report.files.includes('ui/ui.css'));
    assert.ok(!report.files.some((f) => f.endsWith('.ts')), report.files.join(','));
    assert.match(read(out, 'ui/ui.js'), /export\s*\{[^}]*mount/);
  });

  it('второй модуль вида и экран замка (ui.overlay) собираются тоже, в том числе вне ui/', async () => {
    const dir = plugin(
      { 'ui/lock.ts': "export const lock = 1;\n", 'views/side.ts': "export const side = 2;\n" },
      { ui: { views: { main: './ui/ui.js', side: './views/side.js' }, overlay: './ui/lock.js' }, permissions: { 'ui.lock': true } },
    );
    const out = fresh('out');
    const report = await buildPlugin(dir, { out });
    assert.deepEqual(problems(report), []);
    for (const f of ['ui/lock.js', 'ui/ui.js', 'views/side.js']) assert.ok(report.files.includes(f), `нет ${f}`);
  });

  it('готовый вид на .js без исходника копируется как есть', async () => {
    const dir = plugin({ 'ui/ui.ts': null, 'ui/ui.js': "export function mount() {}\n" });
    const out = fresh('out');
    assert.deepEqual(problems(await buildPlugin(dir, { out })), []);
    assert.equal(read(out, 'ui/ui.js'), "export function mount() {}\n");
  });

  it('повторная сборка даёт те же байты и стирает лишнее от прошлой', async () => {
    const dir = plugin();
    const out = fresh('out');
    await buildPlugin(dir, { out });
    write(out, { 'stale.txt': 'старое' });
    const first = new Map((await buildPlugin(dir, { out })).files.map((f) => [f, read(out, f)]));
    assert.ok(!fs.existsSync(path.join(out, 'stale.txt')));
    await buildPlugin(dir, { out });
    for (const [f, text] of first) assert.equal(read(out, f), text, f);
  });

  it('результат по умолчанию - ./dist плагина, и check/сборка не читают его как исходники', async () => {
    const dir = plugin();
    assert.equal((await buildPlugin(dir)).ok, true);
    assert.ok(fs.existsSync(path.join(dir, 'dist', 'index.mjs')));
    const again = await buildPlugin(dir);
    assert.deepEqual(problems(again), []);
  });

  it('зависимость вида с node:*: сборка вида отказывает', async () => {
    const dir = plugin({ 'ui/ui.ts': "import fs from 'node:fs';\nexport const x = fs;\n" });
    const out = fresh('out');
    const report = await buildPlugin(dir, { out });
    assert.equal(report.ok, false);
    assert.match(problems(report).join('\n'), /ui\/ui\.ts:1: 'node:fs': только @cyborg-harness\/contracts и свои модули \(вид: без node:\* и electron\)/);
    assert.ok(!fs.existsSync(out));
  });
});

describe('buildPlugin: запрещённое и отказ до записи (P-06 п. 2, 3, 5)', () => {
  for (const spec of ['node:fs', 'fs', 'electron']) {
    it(`${spec} в исходнике главной части: отказ с файлом и строкой, результат не создан`, async () => {
      const dir = plugin({ 'index.ts': `import x from '${spec}';\nexport default { x };\n` });
      const out = fresh('out');
      const report = await buildPlugin(dir, { out });
      assert.equal(report.ok, false);
      assert.match(problems(report)[0] ?? '', new RegExp(`^index\\.ts:1: '${spec}': в бандле главной части нет ни node:\\*, ни electron$`));
      assert.ok(!fs.existsSync(out), 'результат создан при отказе');
    });
  }

  it('node:fs внутри зависимости: отказ называет файл зависимости, результат не создан', async () => {
    const dir = plugin(
      { 'index.ts': "import { read } from 'leaky';\nexport default { read };\n", 'ui/ui.ts': 'export const x = 1;\n' },
      {},
      { leaky: { 'package.json': '{"name":"leaky","main":"index.js"}', 'index.js': "const fs = require('fs');\nmodule.exports = { read: () => fs.readFileSync };\n" } },
    );
    const out = fresh('out');
    const report = await buildPlugin(dir, { out });
    assert.equal(report.ok, false);
    assert.deepEqual(problems(report), ["node_modules/leaky/index.js: 'fs' попал в бандл главной части: в нём нет ни node:*, ни electron"]);
    assert.ok(!fs.existsSync(out));
  });

  it('electron внутри зависимости: то же', async () => {
    const dir = plugin(
      { 'index.ts': "import { x } from 'greedy';\nexport default { x };\n", 'ui/ui.ts': 'export const x = 1;\n' },
      {},
      { greedy: { 'package.json': '{"name":"greedy","main":"index.js"}', 'index.js': "module.exports = { x: require('electron') };\n" } },
    );
    const report = await buildPlugin(dir, { out: fresh('out') });
    assert.deepEqual(problems(report), ["node_modules/greedy/index.js: 'electron' попал в бандл главной части: в нём нет ни node:*, ни electron"]);
  });

  it('пакета нет в node_modules: ошибка сборщика с файлом и строкой, а не падение инструмента', async () => {
    const dir = plugin({}, {}, {});
    const report = await buildPlugin(dir, { out: fresh('out') });
    assert.equal(report.ok, false);
    assert.match(problems(report)[0] ?? '', /^index\.ts:1: Could not resolve "tiny-dep"/);
  });

  it('ссылка манифеста на отсутствующий файл вида или схемы: отказ, как у check', async () => {
    const out = fresh('out');
    const noView = await buildPlugin(plugin({ 'ui/ui.ts': null }), { out });
    assert.deepEqual(problems(noView), ['manifest.json: ui.views.main: файла ./ui/ui.js нет']);
    const noSchema = await buildPlugin(plugin({ 'config.schema.json': null }), { out });
    assert.deepEqual(problems(noSchema), ['manifest.json: config.schema: файла ./config.schema.json нет']);
    assert.ok(!fs.existsSync(out));
  });

  it('engines.cyborg не принимает версию API: отказ одной причиной; --api-version переопределяет версию', async () => {
    const dir = plugin({}, { engines: { cyborg: '^2' } });
    const refused = await buildPlugin(dir, { out: fresh('out') });
    assert.deepEqual(problems(refused), [`manifest.json: engines.cyborg: нужен API Cyborg ^2, есть ${PLUGIN_API_VERSION}`]);
    assert.equal((await buildPlugin(dir, { out: fresh('out'), apiVersion: '2.0.0' })).ok, true);
  });

  it('нет точки входа: отказ', async () => {
    const report = await buildPlugin(plugin({ 'index.ts': null }), { out: fresh('out') });
    assert.match(problems(report).join('\n'), /нет точки входа главной части/);
  });

  it('каталога плагина нет', async () => {
    assert.deepEqual(problems(await buildPlugin(fresh('nothing'))), ['.: каталога нет']);
  });

  it('--out не должен совпадать с каталогом плагина или содержать его', async () => {
    const dir = plugin();
    assert.match(problems(await buildPlugin(dir, { out: dir }))[0] ?? '', /не может совпадать с каталогом плагина или содержать его/);
    assert.match(problems(await buildPlugin(dir, { out: path.dirname(dir) }))[0] ?? '', /не может совпадать/);
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'каталог плагина стёрт');
  });

  it('--out с чужими файлами (нет manifest.json) не стирается', async () => {
    const out = fresh('foreign');
    write(out, { 'notes.txt': 'мои записи' });
    const report = await buildPlugin(plugin(), { out });
    assert.match(problems(report)[0] ?? '', /каталог не пуст и не похож на результат сборки/);
    assert.equal(read(out, 'notes.txt'), 'мои записи');
  });

  it('--out на месте файла: отказ, файл не стёрт', async () => {
    const file = path.join(fresh('file'), 'notes.md');
    write(path.dirname(file), { 'notes.md': 'мои записи' });
    const report = await buildPlugin(plugin(), { out: file });
    assert.match(problems(report)[0] ?? '', /не каталог или не читается/);
    assert.equal(read(file), 'мои записи');
  });

  it('пакеты и объявления: пакет объявлений по имени - только import type, и сборка этого требует', async () => {
    const dir = plugin({ 'index.ts': "import { Kind } from '@acme/contracts';\nexport default { Kind };\n" }, {}, { '@acme/contracts': { 'package.json': '{"name":"@acme/contracts"}', 'index.js': 'exports.Kind = 1;\n' } });
    const report = await buildPlugin(dir, { out: fresh('out'), declarationPackages: ['@acme/contracts'] });
    assert.match(problems(report).join('\n'), /index\.ts:1: '@acme\/contracts': пакет объявлений - только import type/);
  });
});

describe('buildPlugin: source - стенд (P-06 п. 4)', () => {
  it('исходники копируются как есть, кроме ui/*.ts; виды собираются в ESM; проверка по запросу', async () => {
    const dir = plugin({ 'helper.ts': 'export const h = 1;\n', 'lib/deep.ts': 'export const d = 1;\n', 'ui/ui.ts': 'export const v = 1;\n', 'ui/ui.js': 'старый' });
    const out = fresh('out');
    const report = await buildPlugin(dir, { out, main: 'source', check: false });
    assert.deepEqual(problems(report), []);
    assert.deepEqual(report.files, ['config.schema.json', 'helper.ts', 'index.ts', 'lib/deep.ts', 'manifest.json', 'ui/ui.css', 'ui/ui.js', 'ui/ui.js.map']);
    assert.equal(read(out, 'index.ts'), read(dir, 'index.ts'), 'главная часть тронута');
    assert.match(read(out, 'ui/ui.js'), /export/, 'сборка вида не перекрыла готовый ui.js');
  });

  it('source без проверки не требует манифеста: сборка вида нужна и каталогу без manifest.json', async () => {
    const dir = fresh('bare');
    write(dir, { 'index.ts': 'export default {};\n', 'ui/ui.ts': 'export const v = 1;\n' });
    const report = await buildPlugin(dir, { out: fresh('out'), main: 'source', check: false });
    assert.deepEqual(report.files, ['index.ts', 'ui/ui.js', 'ui/ui.js.map']);
  });

  it('source с проверкой (check по умолчанию): запрещённый импорт останавливает сборку', async () => {
    const dir = plugin({ 'index.ts': "import fs from 'node:fs';\nexport default { fs };\n" });
    const report = await buildPlugin(dir, { out: fresh('out'), main: 'source' });
    assert.equal(report.ok, false);
    assert.match(problems(report)[0] ?? '', /index\.ts:1: 'node:fs'/);
  });

  it('source: npm-пакет в главной части - нарушение, потому что бандла не будет', async () => {
    const report = await buildPlugin(plugin(), { out: fresh('out'), main: 'source' });
    assert.deepEqual(problems(report), ["index.ts:1: 'tiny-dep': только @cyborg-harness/contracts и свои модули"]);
  });

  it('предупреждения сборщика не останавливают сборку и доходят до отчёта', async () => {
    const dir = plugin({ 'ui/ui.ts': "export const x = typeof require === 'undefined' ? 1 : 2;\nif (x === NaN) console.log(1);\n" });
    const report = await buildPlugin(dir, { out: fresh('out') });
    assert.equal(report.ok, true, problems(report).join('\n'));
    assert.ok(report.warnings.some((w) => w.startsWith('ui/ui.ts:2:')), report.warnings.join('\n'));
  });

  it('source: результат внутри каталога плагина (в том числе ./dist по умолчанию) - отказ, а не исключение', async () => {
    const dir = plugin();
    const report = await buildPlugin(dir, { main: 'source', check: false });
    assert.match(problems(report)[0] ?? '', /в режиме source результат не может лежать внутри каталога плагина/);
    assert.ok(!fs.existsSync(path.join(dir, 'dist')));
  });
});
