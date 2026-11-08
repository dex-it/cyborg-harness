import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { runCli } from '../src/plugin-cli.ts';

// P-09, п. 5: `cyborg-plugin check <каталог>` - код возврата 0/1 и отчёт `файл:строка: причина`.
const bin = path.resolve(import.meta.dirname, '..', 'src', 'plugin-cli-bin.ts');
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
    assert.equal(r.err[0], "index.ts:1: 'node:fs': только @cyborg-harness/contracts и свои модули");
    assert.match(r.err.at(-1) ?? '', /Нарушений: 1/);
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
    assert.equal((await cli('check', dir)).code, 1);
    assert.equal((await cli('check', dir, '--declarations-package', '@acme/contracts')).code, 0);
    assert.equal((await cli('check', dir, '--declarations-package=@acme/contracts')).code, 0);
    const decl = path.join(scratch, 'decl.ts');
    fs.writeFileSync(decl, 'export const x = 1;\n');
    const r = await cli('check', dir, '--declarations-package=@acme/contracts', `--declarations=${decl}`);
    assert.equal(r.code, 1);
    assert.match(r.err[0] ?? '', /:1: в пакете объявлений только типы/);
  });

  it('неверный вызов: код 2 и подсказка', async () => {
    for (const argv of [[], ['build'], ['check', '--nope'], ['check', 'a', 'b'], ['check', '--declarations']]) {
      const r = await cli(...argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err.join('\n'), /cyborg-plugin check/);
    }
  });

  it('точка входа bin: тот же результат процессом, код возврата настоящий', async () => {
    const run = promisify(execFile);
    const ok = await run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', bin, 'check', plugin('export default {};\n')]);
    assert.match(ok.stdout, /Нарушений нет/);
    await assert.rejects(run(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', bin, 'check', plugin("require('node:fs');\n")]), (e: { code: number; stderr: string }) => e.code === 1 && e.stderr.includes("index.ts:1: 'node:fs'"));
  });
});
