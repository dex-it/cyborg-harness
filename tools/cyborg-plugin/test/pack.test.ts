import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { formatProblem } from '@cyborg-harness/core/plugin-check';
import { buildPlugin } from '../src/build.ts';
import { packPlugin } from '../src/pack.ts';
import { runCli } from '../src/cli.ts';
import { splitName, tarGz } from '../src/tar.ts';
import { cleanup, fresh, plugin, write } from './fixture.ts';

after(cleanup);

const problems = (r: { problems: readonly Parameters<typeof formatProblem>[0][] }) => r.problems.map(formatProblem);

async function built(files: Record<string, string | null> = {}, manifest: Record<string, unknown> = {}): Promise<string> {
  const out = fresh('built');
  const report = await buildPlugin(plugin(files, manifest), { out });
  assert.equal(report.ok, true, problems(report).join('\n'));
  return out;
}

describe('packPlugin (P-06 п. 2): упаковка собранного каталога', () => {
  it('архив читается обычным tar: корень - id плагина, состав - файлы каталога, байты те же', async () => {
    const dir = await built();
    const archive = path.join(fresh('arch'), 'acme.dep.tgz');
    fs.mkdirSync(path.dirname(archive));
    const report = await packPlugin(dir, { out: archive });
    assert.deepEqual(problems(report), []);
    assert.equal(report.archive, archive);
    assert.equal(report.bytes, fs.statSync(archive).size);
    assert.deepEqual(report.files.map((f) => f.path), ['config.schema.json', 'index.mjs', 'index.mjs.map', 'manifest.json', 'ui/ui.css', 'ui/ui.js', 'ui/ui.js.map']);
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(names, report.files.map((f) => `acme.dep/${f.path}`));
    const into = fresh('extract');
    fs.mkdirSync(into);
    execFileSync('tar', ['-xzf', archive, '-C', into]);
    for (const f of report.files) assert.deepEqual(fs.readFileSync(path.join(into, 'acme.dep', f.path)), fs.readFileSync(path.join(dir, f.path)), f.path);
  });

  it('воспроизводим: те же файлы - тот же архив, байт в байт', async () => {
    const dir = await built();
    const a = path.join(fresh('arch'), 'a.tgz');
    const b = path.join(fresh('arch'), 'b.tgz');
    fs.mkdirSync(path.dirname(a));
    fs.mkdirSync(path.dirname(b));
    await packPlugin(dir, { out: a });
    fs.utimesSync(path.join(dir, 'index.mjs'), new Date(2030, 1, 1), new Date(2030, 1, 1));
    await packPlugin(dir, { out: b });
    assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b));
  });

  it('--dry-run перечисляет состав и размер, архив не пишет', async () => {
    const dir = await built();
    const archive = path.join(fresh('arch'), 'x.tgz');
    const report = await packPlugin(dir, { out: archive, dryRun: true });
    assert.equal(report.ok, true);
    assert.equal(report.archive, undefined);
    assert.ok(report.bytes > 0);
    assert.ok(!fs.existsSync(archive));
  });

  it('имя архива по умолчанию - <id>-<версия>.tgz в текущем каталоге', async () => {
    const dir = await built();
    const cwd = fresh('cwd');
    fs.mkdirSync(cwd);
    const before = process.cwd();
    process.chdir(cwd);
    try {
      const report = await packPlugin(dir);
      assert.equal(path.basename(report.archive ?? ''), 'acme.dep-1.2.3.tgz');
      assert.ok(fs.existsSync(path.join(cwd, 'acme.dep-1.2.3.tgz')));
    } finally {
      process.chdir(before);
    }
  });

  it('исходный каталог вместо собранного: отказ по каждому .ts и по отсутствию index.mjs, архива нет', async () => {
    const dir = plugin();
    const archive = path.join(fresh('arch'), 'x.tgz');
    const report = await packPlugin(dir, { out: archive });
    assert.equal(report.ok, false);
    const text = problems(report).join('\n');
    assert.match(text, /index\.ts: исходник \.ts в поставке: сначала `cyborg-plugin build`/);
    assert.match(text, /ui\/ui\.ts: исходник \.ts в поставке/);
    assert.match(text, /index\.mjs: в поставке главная часть - index\.mjs/);
    assert.match(text, /manifest\.json: ui\.views\.main: в поставке нет \.\/ui\/ui\.js/);
    assert.ok(!fs.existsSync(archive));
  });

  it('запрещённый импорт в собранной главной части: отказ (проверка идёт на результате)', async () => {
    const dir = await built();
    fs.appendFileSync(path.join(dir, 'index.mjs'), "\nimport fsx from 'node:fs';\n");
    const report = await packPlugin(dir, { out: path.join(fresh('arch'), 'x.tgz') });
    assert.equal(report.ok, false);
    assert.match(problems(report)[0] ?? '', /^index\.mjs:\d+: 'node:fs': только @cyborg-harness\/contracts и свои модули$/);
  });

  it('engines.cyborg проверяется и при упаковке', async () => {
    const dir = await built();
    const report = await packPlugin(dir, { out: path.join(fresh('arch'), 'x.tgz'), apiVersion: '2.0.0' });
    assert.match(problems(report).join('\n'), /engines\.cyborg: нужен API Cyborg \^1, есть 2\.0\.0/);
  });

  it('тесты и скрытые каталоги в поставку не идут', async () => {
    const dir = await built();
    write(dir, { 'test/a.test.js': 'x', '.git/config': 'x', 'node_modules/p/index.js': 'x' });
    const report = await packPlugin(dir, { dryRun: true });
    assert.deepEqual(report.files.map((f) => f.path).filter((f) => /test|\.git|node_modules/.test(f)), []);
  });

  it('архив не может лежать внутри упаковываемого каталога', async () => {
    const dir = await built();
    const report = await packPlugin(dir, { out: path.join(dir, 'x.tgz') });
    assert.match(problems(report)[0] ?? '', /архив не может лежать внутри упаковываемого каталога/);
  });

  it('каталога без манифеста нет: отказ причиной манифеста', async () => {
    const report = await packPlugin(fresh('empty'));
    assert.equal(report.ok, false);
    assert.equal(problems(report)[0], '.: каталога нет');
  });

  it('путь файла длиннее 100 байт делится на каталог и имя; не делящийся - отказ упаковки', async () => {
    const deep = `ui/${'d'.repeat(60)}/${'f'.repeat(60)}.css`;
    const dir = await built({ [deep]: 'x' });
    const ok = await packPlugin(dir, { out: path.join(fresh('arch'), 'x.tgz'), dryRun: true });
    assert.equal(ok.ok, true, problems(ok).join('\n'));
    const archive = path.join(fresh('arch'), 'long.tgz');
    fs.mkdirSync(path.dirname(archive));
    await packPlugin(dir, { out: archive });
    assert.ok(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).includes(`acme.dep/${deep}`));
    const long = await built({ [`ui/${'x'.repeat(120)}.css`]: 'x' });
    const refused = await packPlugin(long, { out: path.join(fresh('arch'), 'y.tgz') });
    assert.equal(refused.ok, false);
    assert.match(problems(refused)[0] ?? '', /имя не помещается в tar/);
  });
});

describe('tar: ustar', () => {
  it('splitName: короткое имя целиком, длинное - по границе /, неделимое - undefined', () => {
    assert.deepEqual(splitName('a/b.txt'), { prefix: '', name: 'a/b.txt' });
    const long = `${'a'.repeat(90)}/${'b'.repeat(90)}`;
    assert.deepEqual(splitName(long), { prefix: 'a'.repeat(90), name: 'b'.repeat(90) });
    assert.equal(splitName('x'.repeat(101)), undefined);
    assert.equal(splitName(`${'a'.repeat(200)}/b`), undefined);
  });

  it('заголовок gzip не зависит от ОС: время 0, байт ОС 255', () => {
    const gz = tarGz([{ name: 'r/a', data: Buffer.from('a') }]);
    assert.deepEqual([...gz.subarray(4, 8)], [0, 0, 0, 0]);
    assert.equal(gz[9], 255);
  });

  it('пустой набор записей - корректный пустой архив', () => {
    const archive = path.join(fresh('arch'), 'empty.tgz');
    fs.mkdirSync(path.dirname(archive));
    fs.writeFileSync(archive, tarGz([]));
    assert.equal(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }), '');
  });

  it('размер, кратный блоку, и пустой файл читаются без искажений', () => {
    const archive = path.join(fresh('arch'), 'blocks.tgz');
    fs.mkdirSync(path.dirname(archive));
    fs.writeFileSync(archive, tarGz([{ name: 'r/block', data: new Uint8Array(512).fill(7) }, { name: 'r/empty', data: new Uint8Array(0) }, { name: 'r/кириллица.txt', data: Buffer.from('да') }]));
    const into = fresh('extract');
    fs.mkdirSync(into);
    execFileSync('tar', ['-xzf', archive, '-C', into]);
    assert.equal(fs.readFileSync(path.join(into, 'r', 'block')).length, 512);
    assert.equal(fs.readFileSync(path.join(into, 'r', 'empty')).length, 0);
    assert.equal(fs.readFileSync(path.join(into, 'r', 'кириллица.txt'), 'utf8'), 'да');
  });
});

describe('cyborg-plugin build и pack: командная строка', () => {
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  };

  it('build: код 0 и перечень файлов; запрещённый импорт - код 1 и файл:строка', async () => {
    const out = fresh('cli');
    const ok = await run('build', plugin(), '--out', out);
    assert.equal(ok.code, 0, ok.err.join('\n'));
    assert.ok(ok.out.some((l) => l.trim() === 'index.mjs'));
    const bad = await run('build', plugin({ 'index.ts': "import fs from 'node:fs';\nexport default { fs };\n" }), '--out', fresh('cli'));
    assert.equal(bad.code, 1);
    assert.equal(bad.err[0], "index.ts:1: 'node:fs': в бандле главной части нет ни node:*, ни electron");
  });

  it('pack: код 0 и архив; по умолчанию упаковывает ./dist; --dry-run не пишет', async () => {
    const dir = plugin();
    assert.equal((await run('build', dir)).code, 0);
    const archive = path.join(fresh('cli'), 'x.tgz');
    fs.mkdirSync(path.dirname(archive));
    const before = process.cwd();
    process.chdir(dir);
    try {
      const dry = await run('pack', '--dry-run', '--out', archive);
      assert.equal(dry.code, 0, dry.err.join('\n'));
      assert.ok(!fs.existsSync(archive));
      const real = await run('pack', '--out', archive);
      assert.equal(real.code, 0);
      assert.ok(fs.existsSync(archive));
    } finally {
      process.chdir(before);
    }
    const src = await run('pack', dir);
    assert.equal(src.code, 1);
    assert.match(src.err.join('\n'), /исходник \.ts в поставке/);
  });
});

describe('packPlugin: символические ссылки (ревью P-06: fsx.ts:30)', () => {
  it('ссылка в собранном каталоге: отказ с путём, архив не создан (а не молчаливый пропуск)', async () => {
    const dir = await built();
    fs.symlinkSync('ui.css', path.join(dir, 'ui', 'alias.css'));
    const archive = path.join(fresh('arch'), 'x.tgz');
    fs.mkdirSync(path.dirname(archive));
    const report = await packPlugin(dir, { out: archive });
    assert.equal(report.ok, false);
    assert.match(problems(report)[0] ?? '', /^ui\/alias\.css: символическая ссылка/);
    assert.ok(!fs.existsSync(archive));
  });
});
