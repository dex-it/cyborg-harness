import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { runCli } from '../src/cli.ts';

// P-09, п. 5: `cyborg-plugin check <каталог>` - код возврата 0/1 и отчёт `файл:строка: причина`. P-06: команда переехала сюда из ядра и получила build и pack.
const bin = path.resolve(import.meta.dirname, '..', 'src', 'cli-bin.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-cli-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function plugin(index: string, manifest: Record<string, unknown> = {}): string {
  const dir = path.join(scratch, `p${++counter}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'acme.hello', version: '1.0.0', engines: { cyborg: '^1' }, ...manifest }));
  fs.writeFileSync(path.join(dir, 'index.ts'), index);
  return dir;
}

async function cli(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

describe('cyborg-plugin check', () => {
  it('чистый плагин: код 0, права словами в отчёте', async () => {
    const r = await cli('check', plugin("export default {};\n", { permissions: { notify: true, net: ['api.example.com'] } }));
    assert.equal(r.code, 0);
    assert.deepEqual(r.err, []);
    assert.ok(r.out.some((l) => l.includes('acme.hello')), r.out.join('\n'));
    assert.ok(r.out.some((l) => l.includes('показывает системные уведомления')), r.out.join('\n'));
    assert.ok(r.out.some((l) => l.includes('ходит в сеть: api.example.com')), r.out.join('\n'));
    assert.ok(r.out.some((l) => l.includes('Нарушений нет')), r.out.join('\n'));
  });

  it('нарушения: код 1, строки файл:строка: причина в err', async () => {
    const r = await cli('check', plugin("import fs from 'node:fs';\nexport default {};\n"));
    assert.equal(r.code, 1);
    assert.equal(r.err[0], "index.ts:1: 'node:fs': в бандле главной части нет ни node:*, ни electron");
    assert.match(r.err.at(-1) ?? '', /Нарушений: 1/);
  });

  it('ошибки манифеста: код 1, каждая строкой manifest.json:<строка>: причина (ST-7002/3)', async () => {
    const dir = plugin('export default {};\n');
    const manifest = { version: '1.0.0', engines: { cyborg: '^1' }, bogus: true, ui: { views: { main: './ui/none.js' } } };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const r = await cli('check', dir);
    assert.equal(r.code, 1);
    assert.match(r.err[0] ?? '', /^manifest\.json:6: bogus: незнакомое поле манифеста$/);
    assert.match(r.err[1] ?? '', /^manifest\.json:1: id: ожидается имя вида/);
    assert.match(r.err.at(-1) ?? '', /Нарушений: 2/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{\n  "id": "acme.hello",\n  "version": ,\n}\n');
    assert.match((await cli('check', dir)).err[0] ?? '', /^manifest\.json:3: не JSON - /);
  });

  it('без каталога проверяется текущий', async () => {
    const dir = plugin('export default {};\n');
    const before = process.cwd();
    process.chdir(dir);
    try {
      assert.equal((await cli('check')).code, 0);
    } finally {
      process.chdir(before);
    }
  });

  it('--declarations и --declarations-package принимаются, в том числе в форме --name=value', async () => {
    const dir = plugin("import type { A } from '@acme/contracts';\nexport default {};\n");
    assert.equal((await cli('check', dir, '--source')).code, 1);
    assert.equal((await cli('check', dir, '--source', '--declarations-package', '@acme/contracts')).code, 0);
    assert.equal((await cli('check', dir, '--source', '--declarations-package=@acme/contracts')).code, 0);
    const decl = path.join(scratch, 'decl.ts');
    fs.writeFileSync(decl, 'export const x = 1;\n');
    const r = await cli('check', dir, '--source', '--declarations-package=@acme/contracts', `--declarations=${decl}`);
    assert.equal(r.code, 1);
    assert.match(r.err[0] ?? '', /:1: в пакете объявлений только типы/);
  });

  it('неверный вызов: код 2 и подсказка', async () => {
    for (const argv of [[], ['deploy'], ['check', '--nope'], ['check', 'a', 'b'], ['check', '--declarations'], ['pack', '--source'], ['build', '--out', 'a', '--out', 'b'], ['pack', '--dry-run=1']]) {
      const r = await cli(...argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err.join('\n'), /cyborg-plugin check/);
      assert.match(r.err.join('\n'), /cyborg-plugin build/);
      assert.match(r.err.join('\n'), /cyborg-plugin pack/);
    }
  });

  it('check по умолчанию допускает npm-пакет в главной части (её соберёт build), с --source - нарушение', async () => {
    const dir = plugin("import { shout } from 'tiny-dep';\nexport default { shout };\n");
    assert.equal((await cli('check', dir)).code, 0);
    const strict = await cli('check', dir, '--source');
    assert.equal(strict.code, 1);
    assert.equal(strict.err[0], "index.ts:1: 'tiny-dep': только @cyborg-harness/contracts и свои модули");
  });

  it('check не читает результат прежней сборки как исходники: ни ./dist, ни --out', async () => {
    const dir = plugin('export default {};\n');
    for (const out of ['dist', 'build/plugin']) {
      fs.mkdirSync(path.join(dir, out), { recursive: true });
      fs.writeFileSync(path.join(dir, out, 'index.mjs'), "import fs from 'node:fs';\n");
    }
    assert.equal((await cli('check', dir)).code, 1, 'build/plugin читается как исходники');
    assert.equal((await cli('check', dir, '--out', path.join(dir, 'build', 'plugin'))).code, 1, 'dist читается как исходники');
    fs.rmSync(path.join(dir, 'build'), { recursive: true });
    assert.equal((await cli('check', dir)).code, 0);
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'index.mjs'), "import fs from 'node:fs';\n");
    assert.equal((await cli('check', dir, '--out', 'build')).code, 1, 'относительный --out считается от текущего каталога, а не плагина');
    fs.rmSync(path.join(dir, 'dist'), { recursive: true });
    assert.equal((await cli('check', dir, '--out', path.join(dir, 'build'))).code, 0);
  });

  it('--api-version: engines.cyborg сверяется с названной версией API', async () => {
    const dir = plugin('export default {};\n', { engines: { cyborg: '^2' } });
    const old = await cli('check', dir);
    assert.equal(old.code, 1);
    assert.match(old.err[0] ?? '', /engines\.cyborg: нужен API Cyborg \^2/);
    assert.equal((await cli('check', dir, '--api-version', '2.1.0')).code, 0);
    assert.equal((await cli('build', dir, '--api-version=2.1.0', '--out', path.join(scratch, 'api-out'))).code, 0);
    assert.equal((await cli('build', dir, '--out', path.join(scratch, 'api-out2'))).code, 1);
  });

  it('точка входа bin: тот же результат процессом, код возврата настоящий', async () => {
    const run = promisify(execFile);
    const ok = await run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', bin, 'check', plugin('export default {};\n')]);
    assert.match(ok.stdout, /Нарушений нет/);
    await assert.rejects(run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', bin, 'check', plugin("require('node:fs');\n")]), (e: { code: number; stderr: string }) => e.code === 1 && e.stderr.includes("index.ts:1: 'node:fs'"));
  });
});
