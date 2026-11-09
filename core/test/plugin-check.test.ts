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

  it('нечитаемый подкаталог - нарушение, а не падение проверки', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const dir = plugin(OK);
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked, { mode: 0o000 });
    try {
      const found = strings(await checkPlugin(dir));
      assert.equal(found.length, 1, found.join('\n'));
      assert.match(found[0] ?? '', /^locked: каталог не прочитан - /);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  describe('символические ссылки', { skip: process.platform === 'win32' }, () => {
    /** Каталог снаружи плагина (рядом с ним) с файлами: node грузит файл по реальному пути, то есть оттуда. */
    function outside(files: Record<string, string>): string {
      const dir = path.join(scratch, `out${++counter}`);
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), text);
      }
      return dir;
    }

    it('каталог-ссылка наружу: чужой модуль за ней не проходит мимо проверки', async () => {
      const out = outside({ 'evil.ts': "import fs from 'node:fs';\nexport default fs;\n" });
      const dir = plugin({ 'index.ts': "import evil from './lib/evil.ts';\nexport default evil;\n" });
      fs.symlinkSync(out, path.join(dir, 'lib'), 'dir');
      const report = await checkPlugin(dir);
      assert.equal(report.ok, false);
      const found = strings(report);
      assert.ok(found.includes("lib: ссылка ведёт за пределы каталога плагина"), found.join('\n'));
      assert.ok(found.includes("index.ts:1: './lib/evil.ts': ведёт за пределы каталога плагина (символическая ссылка)"), found.join('\n'));
    });

    it('файл-ссылка наружу: сам файл и относительный импорт в него - нарушения', async () => {
      const out = outside({ 'evil.ts': "import fs from 'node:fs';\nexport default fs;\n" });
      const dir = plugin({ 'index.ts': "import evil from './alias.ts';\nexport default evil;\n" });
      fs.symlinkSync(path.join(out, 'evil.ts'), path.join(dir, 'alias.ts'));
      const found = strings(await checkPlugin(dir));
      assert.ok(found.includes('alias.ts: ссылка ведёт за пределы каталога плагина'), found.join('\n'));
      assert.ok(found.includes("index.ts:1: './alias.ts': ведёт за пределы каталога плагина (символическая ссылка)"), found.join('\n'));
    });

    it('ссылка внутри плагина: каталог обходится один раз, цикл не вешает проверку', async () => {
      const dir = plugin({ ...OK, 'real/a.ts': "import fs from 'node:fs';\n" });
      fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'twin'), 'dir');
      fs.symlinkSync(dir, path.join(dir, 'real', 'loop'), 'dir');
      const report = await checkPlugin(dir);
      assert.deepEqual(strings(report), ["real/a.ts:1: 'node:fs': только @cyborg-harness/contracts и свои модули"]);
      assert.equal(report.files, 2);
    });

    it('ссылка на файл внутри плагина - обычный модуль', async () => {
      const dir = plugin({ ...OK, 'lib/impl.ts': 'export const x = 1;\n' });
      fs.symlinkSync(path.join(dir, 'lib', 'impl.ts'), path.join(dir, 'alias.ts'));
      fs.appendFileSync(path.join(dir, 'index.ts'), "import { x } from './alias.ts';\nexport { x };\n");
      assert.deepEqual(strings(await checkPlugin(dir)), []);
    });

    it('каталог главной части, подключённый ссылкой в ui/, проверяется как главная часть', async () => {
      const dir = plugin({ 'index.ts': "import './utils/x.ts';\n", 'utils/x.ts': "import _ from 'lodash';\nexport default _;\n", 'ui/view.ts': 'export {};\n' });
      fs.symlinkSync(path.join(dir, 'utils'), path.join(dir, 'ui', 'utils'), 'dir');
      assert.deepEqual(strings(await checkPlugin(dir)), ["ui/utils/x.ts:1: 'lodash': только @cyborg-harness/contracts и свои модули"]);
    });

    it('тестовый модуль за ссылкой остаётся тестовым', async () => {
      const dir = plugin({ 'index.ts': "import h from './lib/helper.ts';\nexport default h;\n", 'test/helper.ts': 'export default 1;\n' });
      fs.symlinkSync(path.join(dir, 'test'), path.join(dir, 'lib'), 'dir');
      assert.deepEqual(strings(await checkPlugin(dir)), ["index.ts:1: './lib/helper.ts': тестовый модуль в коде плагина"]);
    });

    it('ссылка на подкаталог каталога-ссылки не обходит файлы второй раз', async () => {
      const dir = plugin({ ...OK, 'b/c/x.ts': "import fs from 'node:fs';\n" });
      fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'), 'dir');
      fs.symlinkSync(path.join(dir, 'b', 'c'), path.join(dir, 'b', 'c', 'loop'), 'dir');
      const report = await checkPlugin(dir);
      assert.deepEqual(strings(report), ["a/c/x.ts:1: 'node:fs': только @cyborg-harness/contracts и свои модули"]);
      assert.equal(report.files, 2);
    });

    it('битая ссылка не роняет проверку', async () => {
      const dir = plugin(OK);
      fs.symlinkSync(path.join(scratch, 'no-such-target'), path.join(dir, 'gone.ts'));
      const found = strings(await checkPlugin(dir));
      assert.equal(found.length, 1, found.join('\n'));
      assert.match(found[0] ?? '', /^gone\.ts: ссылка не прочитана - /);
    });
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

describe('checkPlugin: bundled (P-06) - главную часть соберут в один файл', () => {
  const WITH_DEP = { 'index.ts': "import { shout } from 'tiny-dep';\nexport default { activate() { shout('x'); } };\n" };

  it('без bundled npm-пакет в главной части - нарушение, как раньше', async () => {
    const report = await checkPlugin(plugin(WITH_DEP));
    assert.deepEqual(strings(report), ["index.ts:1: 'tiny-dep': только @cyborg-harness/contracts и свои модули"]);
  });

  it('с bundled npm-пакет в главной части допустим', async () => {
    assert.deepEqual(strings(await checkPlugin(plugin(WITH_DEP), { bundled: true })), []);
  });

  it('с bundled node:*, electron, модуль вне каталога, тестовый модуль и вычисляемый путь - по-прежнему нарушения', async () => {
    const dir = plugin({
      'index.ts': [
        "import fs from 'node:fs';",
        "import { app } from 'electron';",
        "import other from '../other/index.ts';",
        "import t from './index.test.ts';",
        'const name = String(process.argv[2]);',
        'await import(name);',
        'export default { fs, app, other, t };',
        '',
      ].join('\n'),
      'index.test.ts': 'export default 1;\n',
    });
    assert.deepEqual(strings(await checkPlugin(dir, { bundled: true })), [
      "index.ts:1: 'node:fs': в бандле главной части нет ни node:*, ни electron",
      "index.ts:2: 'electron': в бандле главной части нет ни node:*, ни electron",
      "index.ts:3: '../other/index.ts': модуль вне каталога плагина",
      "index.ts:4: './index.test.ts': тестовый модуль в коде плагина",
      'index.ts:6: вычисляемый путь: статика не видит, какой модуль загрузится',
    ]);
  });

  it('с bundled пакет объявлений по имени по-прежнему только import type', async () => {
    const dir = plugin({ 'index.ts': "import { x } from '@acme/contracts';\nexport default { x };\n" });
    const text = strings(await checkPlugin(dir, { bundled: true, declarationPackages: ['@acme/contracts'] })).join('\n');
    assert.match(text, /пакет объявлений - только import type/);
  });
});

describe('checkPlugin: ignore (P-06) - каталог результата сборки не проверяется как исходники', () => {
  it('файлы каталога из ignore не читаются, соседи - читаются', async () => {
    const dir = plugin({ ...OK, 'dist/index.mjs': "import fs from 'node:fs';\n", 'lib/bad.ts': "import fs from 'node:fs';\n" });
    assert.match(strings(await checkPlugin(dir)).join('\n'), /dist\/index\.mjs:1/);
    const report = await checkPlugin(dir, { ignore: ['dist'] });
    assert.deepEqual(strings(report), ["lib/bad.ts:1: 'node:fs': только @cyborg-harness/contracts и свои модули"]);
  });

  it('ignore ведёт только вниз: путь за пределы каталога плагина ничего не скрывает', async () => {
    const dir = plugin({ ...OK, 'dist/index.mjs': "import fs from 'node:fs';\n" });
    const report = await checkPlugin(dir, { ignore: ['../dist', '/dist'] });
    assert.equal(report.problems.length, 1, strings(report).join('\n'));
  });
});
