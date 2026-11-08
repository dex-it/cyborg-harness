import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';
import { MANIFEST_KEYS, parseManifest } from '../src/manifest.ts';
import { checkPlugin, CHECKED_KEYS, formatProblem, type CheckReport } from '../src/plugin-check.ts';

// P-09: checkPlugin(dir, options) - проверка плагина вне репозитория.
const repo = path.resolve(import.meta.dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-check-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** Каталог плагина во временном каталоге: файлы -> содержимое; `manifest` дополняет минимальный манифест. */
function plugin(files: Record<string, string>, manifest: Record<string, unknown> | null = {}): string {
  const dir = path.join(scratch, `p${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  const body = { id: 'acme.hello', version: '1.0.0', engines: { cyborg: '^1' }, ...manifest };
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(body));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const OK = { 'index.ts': "import type { PluginModule } from '@cyborg-harness/contracts';\nexport default {} as PluginModule;\n" };
const strings = (r: CheckReport) => r.problems.map(formatProblem);

describe('checkPlugin: плагины репозитория', () => {
  // Образцы, негодные намеренно: тесты загрузчика и графа. Каждый должен давать именно свою причину.
  const EXPECTED: Readonly<Record<string, RegExp>> = {
    'core/examples/plugins/broken-manifest': /^manifest\.json: version: ожидается версия x\.y\.z/m,
    'core/examples/plugins/future': /^manifest\.json: engines\.cyborg: нужен API Cyborg \^2, есть 1\.0\.0$/m,
    'core/examples/plugins/cycle-a': /нет точки входа/,
    'core/examples/plugins/cycle-b': /нет точки входа/,
  };
  const ROOTS: Readonly<Record<string, string>> = { 'core/examples/plugins': 'core/examples/contracts.ts', 'playground/plugins': 'playground/plugins/contracts.ts' };

  for (const [relRoot, relDeclarations] of Object.entries(ROOTS)) {
    it(`${relRoot}: ноль нарушений, кроме намеренно негодных образцов`, async () => {
      const root = path.join(repo, relRoot);
      const homes = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
      assert.ok(homes.length > 5, `плагинов в ${relRoot}: ${homes.length}`);
      for (const d of homes) {
        const rel = `${relRoot}/${d.name}`;
        const report = await checkPlugin(path.join(root, d.name), { declarations: [path.join(repo, relDeclarations)] });
        const want = EXPECTED[rel];
        if (want === undefined) assert.deepEqual(strings(report), [], rel);
        else {
          assert.equal(report.ok, false, rel);
          assert.match(strings(report).join('\n'), want, rel);
        }
      }
    });
  }

  it('права плагина названы словами, как в окне «Плагины Cyborg»', async () => {
    const report = await checkPlugin(path.join(repo, 'playground/plugins/pin-lock'), { declarations: [path.join(repo, 'playground/plugins/contracts.ts')] });
    assert.deepEqual(strings(report), []);
    assert.ok(report.permissions.includes('может закрыть окно Cyborg'), report.permissions.join('; '));
  });
});

describe('checkPlugin: плагин вне репозитория', () => {
  it('чистый плагин: ноль нарушений, id и права в отчёте', async () => {
    const report = await checkPlugin(plugin(OK, { permissions: { notify: true } }));
    assert.deepEqual(strings(report), []);
    assert.equal(report.ok, true);
    assert.equal(report.id, 'acme.hello');
    assert.deepEqual(report.permissions, ['показывает системные уведомления']);
  });

  it('запрещённые импорты дают файл:строка и причину', async () => {
    const dir = plugin({
      'index.ts': ["import fs from 'node:fs';", "import { app } from 'electron';", "import other from '../other/index.ts';", "import x from 'lodash';", 'export default await import(name);'].join('\n'),
      'lib/util.ts': "const m = require('node:child_process');\n",
    });
    const report = await checkPlugin(dir);
    assert.equal(report.ok, false);
    assert.deepEqual(strings(report), [
      "index.ts:1: 'node:fs': только @cyborg-harness/contracts и свои модули",
      "index.ts:2: 'electron': только @cyborg-harness/contracts и свои модули",
      "index.ts:3: '../other/index.ts': модуль вне каталога плагина",
      "index.ts:4: 'lodash': только @cyborg-harness/contracts и свои модули",
      'index.ts:5: вычисляемый путь: статика не видит, какой модуль загрузится',
      "lib/util.ts:1: 'node:child_process': только @cyborg-harness/contracts и свои модули",
    ]);
  });

  it('вид: npm-пакеты можно, node:* и electron нельзя', async () => {
    const dir = plugin(
      { ...OK, 'ui/ui.ts': ["import { Terminal } from '@xterm/xterm';", "import fs from 'node:fs';", "import { ipcRenderer } from 'electron';"].join('\n') },
      { ui: { views: { main: './ui/ui.js' } } },
    );
    assert.deepEqual(strings(await checkPlugin(dir)), ["ui/ui.ts:2: 'node:fs': только @cyborg-harness/contracts и свои модули (вид: без node:* и electron)", "ui/ui.ts:3: 'electron': только @cyborg-harness/contracts и свои модули (вид: без node:* и electron)"]);
  });

  it('пакет объявлений по имени: только import type', async () => {
    const dir = plugin({ 'index.ts': ["import type { Clock } from '@acme/contracts';", "import { value } from '@acme/contracts';"].join('\n') });
    assert.deepEqual(strings(await checkPlugin(dir)), ["index.ts:1: '@acme/contracts': только @cyborg-harness/contracts и свои модули", "index.ts:2: '@acme/contracts': только @cyborg-harness/contracts и свои модули"]);
    assert.deepEqual(strings(await checkPlugin(dir, { declarationPackages: ['@acme/contracts'] })), ["index.ts:2: '@acme/contracts': пакет объявлений - только import type"]);
  });

  it('пакет объявлений файлом: из него только import type, а сам он без кода', async () => {
    const decl = path.join(scratch, 'acme-contracts.ts');
    fs.writeFileSync(decl, "export interface Clock { now(): number }\nexport const x = 1;\n");
    const dir = plugin({ 'index.ts': "import type { Clock } from '../acme-contracts.ts';\nimport { x } from '../acme-contracts.ts';\n" });
    // Файл лежит рядом с каталогом плагина (scratch), как `../contracts.ts` в репозитории.
    const report = await checkPlugin(dir, { declarations: [decl] });
    assert.deepEqual(strings(report), ['index.ts:2: \'../acme-contracts.ts\': пакет объявлений - только import type', '../acme-contracts.ts:2: в пакете объявлений только типы и declare module \'@cyborg-harness/contracts\'']);
  });

  it('тесты и node_modules не проверяются, но импорт тестового модуля из кода плагина - нарушение', async () => {
    const dir = plugin({
      ...OK,
      'index.test.ts': "import test from 'node:test';\n",
      'test/helper.ts': "import fs from 'node:fs';\n",
      'node_modules/dep/index.js': "require('node:fs');\n",
      '.hidden/x.js': "require('node:fs');\n",
    });
    assert.deepEqual(strings(await checkPlugin(dir)), []);
    fs.appendFileSync(path.join(dir, 'index.ts'), "import { help } from './test/helper.ts';\n");
    assert.deepEqual(strings(await checkPlugin(dir)), ["index.ts:3: './test/helper.ts': тестовый модуль в коде плагина"]);
  });

  it('точка входа обязательна: index.mjs, index.js или index.ts', async () => {
    assert.match(strings(await checkPlugin(plugin({})))[0] ?? '', /нет точки входа/);
    assert.deepEqual(strings(await checkPlugin(plugin({ 'index.mjs': 'export default {};\n' }))), []);
  });
});

describe('checkPlugin: манифест и файлы из него', () => {
  it('ссылка на отсутствующий модуль вида, экран замка и схемы - нарушение у каждой', async () => {
    const dir = plugin(OK, {
      permissions: { 'ui.lock': true },
      ui: { views: { main: './ui/ui.js' }, overlay: './ui/lock.js' },
      config: { version: 1, schema: './config.schema.json' },
      state: { version: 1, schema: './schemas/state.json' },
    });
    assert.deepEqual(strings(await checkPlugin(dir)), [
      'manifest.json: ui.views.main: файла ./ui/ui.js нет',
      'manifest.json: ui.overlay: файла ./ui/lock.js нет',
      'manifest.json: config.schema: файла ./config.schema.json нет',
      'manifest.json: state.schema: файла ./schemas/state.json нет',
    ]);
  });

  it('модуль вида до сборки лежит как .ts: .js нет, но исходник есть', async () => {
    const dir = plugin({ ...OK, 'ui/ui.ts': 'export {};\n', 'config.schema.json': '{}' }, { ui: { views: { main: './ui/ui.js' } }, config: { version: 1, schema: './config.schema.json' } });
    assert.deepEqual(strings(await checkPlugin(dir)), []);
  });

  it('схема по ссылке наружу каталога - нарушение', async () => {
    const outside = path.join(scratch, 'outside.json');
    fs.writeFileSync(outside, '{}');
    const dir = plugin(OK, { config: { version: 1, schema: './link.json' } });
    fs.symlinkSync(outside, path.join(dir, 'link.json'));
    assert.deepEqual(strings(await checkPlugin(dir)), ['manifest.json: config.schema: ./link.json ведёт за пределы каталога плагина']);
  });

  it('все ошибки манифеста сразу, а не первая', async () => {
    const dir = plugin(OK, { id: 'Bad Id', version: 'x', commands: 5, bogus: 1, ui: { views: { main: '../out.js' } } });
    const found = strings(await checkPlugin(dir));
    assert.ok(found.length >= 5, found.join('\n'));
    for (const part of ['id:', 'version:', 'commands:', 'bogus: незнакомое поле', 'ui.views.main:']) assert.ok(found.some((l) => l.startsWith(`manifest.json: ${part}`)), `${part}\n${found.join('\n')}`);
  });

  it('engines.cyborg под другой API: одна причина о версии, остальные ошибки не отвлекают', async () => {
    const dir = plugin(OK, { engines: { cyborg: '^2' }, bogus: 1, version: 'x', brandNew: { form: 'of API 2' } });
    assert.deepEqual(strings(await checkPlugin(dir)), ['manifest.json: engines.cyborg: нужен API Cyborg ^2, есть 1.0.0']);
    // То же на parseManifest: так отвечает и загрузчик.
    assert.deepEqual(parseManifest({ id: 'a', version: 'x', engines: { cyborg: '^2' }, bogus: 1 }, PLUGIN_API_VERSION), { ok: false, id: 'a', errors: ['engines.cyborg: нужен API Cyborg ^2, есть 1.0.0'] });
  });

  it('верный манифест под другой API отвергается тоже; версию API задаёт вызывающий', async () => {
    const dir = plugin(OK, { engines: { cyborg: '^2' } });
    assert.deepEqual(strings(await checkPlugin(dir)), ['manifest.json: engines.cyborg: нужен API Cyborg ^2, есть 1.0.0']);
    assert.deepEqual(strings(await checkPlugin(dir, { apiVersion: '2.1.0' })), []);
  });

  it('неразбираемый диапазон engines.cyborg идёт вместе с остальными ошибками', async () => {
    const found = strings(await checkPlugin(plugin(OK, { engines: { cyborg: 'abc' }, bogus: 1 })));
    assert.equal(found.length, 2, found.join('\n'));
    assert.ok(found.some((l) => l.includes('engines.cyborg: ожидается диапазон')));
  });

  it('нет манифеста, битый JSON и нет каталога', async () => {
    assert.deepEqual(strings(await checkPlugin(plugin(OK, null))), ['manifest.json: файла нет']);
    const broken = plugin(OK, null);
    fs.writeFileSync(path.join(broken, 'manifest.json'), '{ "id": ');
    assert.match(strings(await checkPlugin(broken))[0] ?? '', /^manifest\.json: не JSON - /);
    const missing = await checkPlugin(path.join(scratch, 'нет-такого'));
    assert.deepEqual(strings(missing), ['.: каталога нет']);
    assert.equal(missing.ok, false);
  });

  it('при ошибках манифеста импорты всё равно проверены', async () => {
    const dir = plugin({ 'index.ts': "import fs from 'node:fs';\n" }, { bogus: 1 });
    assert.deepEqual(strings(await checkPlugin(dir)), ['manifest.json: bogus: незнакомое поле манифеста', "index.ts:1: 'node:fs': только @cyborg-harness/contracts и свои модули"]);
  });
});

describe('checkPlugin: новые ключи манифеста', () => {
  // Ключ, который parseManifest знает, а проверка файлов - нет, молча пропустил бы ссылку на отсутствующий файл. Тест падает, пока автор ключа не решит, ссылается ли он на файлы.
  it('каждый ключ верхнего уровня манифеста сведён в CHECKED_KEYS', () => {
    assert.deepEqual([...Object.keys(CHECKED_KEYS)].sort(), [...MANIFEST_KEYS].sort());
  });

  it('ключи с файлами возвращают ссылки: ui, config, state', () => {
    const parsed = parseManifest({ id: 'a', version: '1.0.0', engines: { cyborg: '^1' }, permissions: { 'ui.lock': true }, ui: { views: { v: './v.js' }, overlay: './o.js' }, config: { version: 1, schema: './c.json' }, state: { version: 1, schema: './s.json' } });
    assert.ok(parsed.ok);
    const refs = Object.values(CHECKED_KEYS).flatMap((f) => f(parsed.manifest));
    assert.deepEqual(refs.map((r) => `${r.field} ${r.file}`).sort(), ['config.schema ./c.json', 'state.schema ./s.json', 'ui.overlay ./o.js', 'ui.views.v ./v.js']);
  });
});
