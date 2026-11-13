import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { INTEGRITY_FILE } from '@cyborg-harness/core/integrity';
import { formatProblem } from '@cyborg-harness/core/plugin-check';
import { buildPlugin } from '../src/build.ts';
import { runCli } from '../src/cli.ts';
import { packPlugin } from '../src/pack.ts';
import { keygen, signPlugin, verifyPlugin } from '../src/sign.ts';
import { tarGz, untarGz } from '../src/tar.ts';
import { cleanup, fresh, plugin } from './fixture.ts';
import { runCommand } from '../../../core/test/run-command.ts';

// TR-10 (ADR-CH-0017): keygen, sign, verify и воспроизводимый pack с integrity.json. Ключи создаются на лету во временном каталоге.
after(cleanup);

const problems = (r: { problems: readonly Parameters<typeof formatProblem>[0][] }) => r.problems.map(formatProblem);

async function built(): Promise<string> {
  const out = fresh('built');
  const report = await buildPlugin(plugin(), { out });
  assert.equal(report.ok, true, problems(report).join('\n'));
  return out;
}

async function keys(): Promise<{ secret: string; pub: string; keyId: string }> {
  const prefix = fresh('key');
  const r = await keygen(prefix);
  assert.equal(r.ok, true);
  return { secret: `${prefix}.key`, pub: `${prefix}.pub`, keyId: r.keyId ?? '' };
}

describe('ST-3009/1: keygen', () => {
  it('пара ключей в файлах: закрытый 0600, существующие файлы не затираются', async () => {
    const k = await keys();
    assert.equal(fs.statSync(k.secret).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(k.pub, 'utf8'), /^ed25519:/);
    assert.match(fs.readFileSync(k.secret, 'utf8'), /^ed25519-secret:/);
    const again = await keygen(k.secret.replace(/\.key$/, ''));
    assert.equal(again.ok, false);
    assert.match(problems(again).join(), /не затирается/);
    assert.match(fs.readFileSync(k.secret, 'utf8'), /^ed25519-secret:/, 'старый ключ цел');
  });
});

describe('ST-3009/1: sign и verify', () => {
  it('подписанный каталог проходит verify; каталог и архив из него - тот же результат', async () => {
    const dir = await built();
    const k = await keys();
    const signed = await signPlugin(dir, { keyFile: k.secret, days: 30 });
    assert.deepEqual(problems(signed), []);
    assert.equal(signed.keyId, k.keyId);
    assert.ok(fs.existsSync(path.join(dir, INTEGRITY_FILE)));
    const onDisk = await verifyPlugin(dir, { keys: [k.pub] });
    assert.deepEqual(problems(onDisk), []);
    assert.equal(onDisk.id, 'acme.dep');
    const archive = path.join(fresh('arch'), 'a.tgz');
    fs.mkdirSync(path.dirname(archive));
    assert.equal((await packPlugin(dir, { out: archive })).ok, true);
    const packed = await verifyPlugin(archive, { keys: [fs.readFileSync(k.pub, 'utf8').trim()] });
    assert.deepEqual(problems(packed), []);
    assert.equal(packed.files, onDisk.files);
  });

  it('verify отказывает: изменённый байт, лишний файл, чужой ключ, истёкший срок - и в каталоге, и в архиве', async () => {
    const dir = await built();
    const k = await keys();
    const other = await keys();
    await signPlugin(dir, { keyFile: k.secret });
    const codeOf = async (target: string, key = k.pub, now?: number) => {
      const r = await verifyPlugin(target, { keys: [key], ...(now !== undefined && { now }) });
      return r.verdict?.ok === false ? r.verdict.code : r.ok ? 'ok' : `прочее: ${problems(r).join()}`;
    };
    assert.equal(await codeOf(dir, other.pub), 'unknown-key');
    assert.equal(await codeOf(dir, k.pub, Date.now() + 400 * 86_400_000), 'expired');
    // архив с подменой: подписанные файлы те же, но один байт в index.mjs другой
    const intact = untarGz(fs.readFileSync((await packTo(dir)).archive));
    const evil = new Map(intact.files);
    const index = Buffer.from(evil.get('acme.dep/index.mjs') ?? '');
    index[0] = (index[0] ?? 0) ^ 1;
    evil.set('acme.dep/index.mjs', index);
    const tampered = path.join(fresh('arch'), 't.tgz');
    fs.mkdirSync(path.dirname(tampered));
    fs.writeFileSync(tampered, tarGz([...evil].map(([name, data]) => ({ name, data }))));
    assert.equal(await codeOf(tampered), 'modified');
    evil.set('acme.dep/index.mjs', Buffer.from(intact.files.get('acme.dep/index.mjs') ?? ''));
    evil.set('acme.dep/extra.mjs', Buffer.from('export default 1'));
    const withExtra = path.join(fresh('arch'), 'e.tgz');
    fs.mkdirSync(path.dirname(withExtra));
    fs.writeFileSync(withExtra, tarGz([...evil].map(([name, data]) => ({ name, data }))));
    assert.equal(await codeOf(withExtra), 'extra');
    // каталог: правка и лишний файл после подписи
    fs.appendFileSync(path.join(dir, 'index.mjs'), '\n// правка');
    assert.equal(await codeOf(dir), 'modified');
  });

  it('verify каталога: лишний файл в каталоге - extra; без ключей и с битым ключом - отказ до проверки', async () => {
    const dir = await built();
    const k = await keys();
    await signPlugin(dir, { keyFile: k.secret });
    fs.writeFileSync(path.join(dir, 'evil.mjs'), 'export default 1');
    const extra = await verifyPlugin(dir, { keys: [k.pub] });
    assert.equal(extra.verdict?.ok === false && extra.verdict.code, 'extra');
    assert.match(problems(await verifyPlugin(dir, { keys: [] })).join(), /хотя бы один/);
    assert.match(problems(await verifyPlugin(dir, { keys: ['ed25519:AAAA'] })).join(), /32 байт/);
    assert.match(problems(await verifyPlugin(dir, { keys: [path.join(dir, 'нет.pub')] })).join(), /не прочитан/);
  });

  it('sign: не плагин, нет ключа, срок в прошлом и ссылка в каталоге - отказ с причиной, подписи не остаётся', async () => {
    const k = await keys();
    const dir = await built();
    assert.match(problems(await signPlugin(fresh('нет'), { keyFile: k.secret })).join(), /каталога нет/);
    const bare = fresh('bare');
    fs.mkdirSync(bare);
    assert.match(problems(await signPlugin(bare, { keyFile: k.secret })).join(), /manifest\.json/);
    assert.match(problems(await signPlugin(dir, { keyFile: path.join(bare, 'нет.key') })).join(), /закрытый ключ не прочитан/);
    assert.match(problems(await signPlugin(dir, { keyFile: k.pub })).join(), /закрытый ключ|ожидалась запись/, 'открытый ключ вместо закрытого');
    assert.match(problems(await signPlugin(dir, { keyFile: k.secret, expires: new Date('2020-01-01') })).join(), /уже прошёл/);
    assert.match(problems(await signPlugin(dir, { keyFile: k.secret, expires: new Date('nope') })).join(), /ожидалась дата/);
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.txt'));
    assert.match(problems(await signPlugin(dir, { keyFile: k.secret })).join(), /символическая ссылка/);
    assert.equal(fs.existsSync(path.join(dir, INTEGRITY_FILE)), false);
  });
});

async function packTo(dir: string): Promise<{ archive: string }> {
  const archive = path.join(fresh('arch'), 'p.tgz');
  fs.mkdirSync(path.dirname(archive));
  const r = await packPlugin(dir, { out: archive });
  assert.equal(r.ok, true, problems(r).join('\n'));
  return { archive };
}

describe('ST-3009/2: pack кладёт integrity.json и воспроизводим', () => {
  it('подписанный каталог: integrity.json в архиве, два pack дают тот же архив байт в байт', async () => {
    const dir = await built();
    const k = await keys();
    await signPlugin(dir, { keyFile: k.secret });
    const a = await packTo(dir);
    fs.utimesSync(path.join(dir, 'index.mjs'), new Date(2031, 1, 1), new Date(2031, 1, 1));
    const b = await packTo(dir);
    assert.deepEqual(fs.readFileSync(a.archive), fs.readFileSync(b.archive));
    const names = runCommand('tar', ['-tzf', a.archive]).trim().split('\n');
    assert.ok(names.includes(`acme.dep/${INTEGRITY_FILE}`), names.join());
    // распакованный настоящим tar каталог проходит verify
    const into = fresh('extract');
    fs.mkdirSync(into);
    runCommand('tar', ['-xzf', a.archive, '-C', into]);
    assert.deepEqual(problems(await verifyPlugin(path.join(into, 'acme.dep'), { keys: [k.pub] })), []);
  });

  it('подпись, устаревшая после правки файла, в архив не едет: pack отказывает и называет файл', async () => {
    const dir = await built();
    const k = await keys();
    await signPlugin(dir, { keyFile: k.secret });
    fs.appendFileSync(path.join(dir, 'index.mjs'), '\n// после подписи');
    const r = await packPlugin(dir, { out: path.join(fresh('arch'), 'x.tgz') });
    assert.equal(r.ok, false);
    assert.match(problems(r).join(), /подпись устарела.*index\.mjs.*cyborg-plugin sign/);
    fs.writeFileSync(path.join(dir, INTEGRITY_FILE), '{ нет');
    assert.match(problems(await packPlugin(dir, { dryRun: true })).join(), /не разобран/);
  });

  it('untarGz читает архив настоящего tar с pax-путём и отвергает небезопасные пути', () => {
    const dir = fresh('tarsrc');
    fs.mkdirSync(path.join(dir, 'r'), { recursive: true });
    const long = 'd'.repeat(90);
    fs.mkdirSync(path.join(dir, 'r', long, long), { recursive: true });
    fs.writeFileSync(path.join(dir, 'r', long, long, 'f.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'r', 'a.txt'), 'a');
    const archive = path.join(dir, 'a.tgz');
    runCommand('tar', ['--format=pax', '-czf', archive, '-C', dir, 'r']);
    const { files } = untarGz(fs.readFileSync(archive));
    // bsdtar на macOS добавляет AppleDouble-файлы `._*`: это его, а не наши записи.
    assert.deepEqual([...files.keys()].filter((name) => !path.basename(name).startsWith('._')).sort(), ['r/a.txt', `r/${long}/${long}/f.txt`].sort());
    assert.throws(() => untarGz(tarGz([{ name: '../x', data: Buffer.from('x') }])), /недопустимый путь/);
    assert.throws(() => untarGz(Buffer.from('не gzip')), /incorrect header|unknown/i);
  });
});

describe('ST-3009/1: командная строка', () => {
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('keygen, sign, verify: коды 0 и 1, слова для человека; неверный вызов - 2', async () => {
    const dir = await built();
    const prefix = fresh('cli-key');
    const gen = await cli('keygen', '--out', prefix);
    assert.equal(gen.code, 0, gen.err);
    assert.match(gen.out, /закрытый:.*секрет/);
    assert.equal((await cli('keygen', '--out', prefix)).code, 1, 'второй раз не затирает');
    assert.equal((await cli('sign', dir)).code, 2, 'нужен --key');
    const signed = await cli('sign', dir, '--key', `${prefix}.key`, '--days', '10');
    assert.equal(signed.code, 0, signed.err);
    assert.match(signed.out, /Подписано ключом [0-9a-f]{32}, файлов: \d+, действует до 20\d\d-/);
    const ok = await cli('verify', dir, '--key', `${prefix}.pub`);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Подпись верна: acme\.dep 1\.2\.3/);
    fs.appendFileSync(path.join(dir, 'index.mjs'), ' ');
    const bad = await cli('verify', dir, '--key', `${prefix}.pub`);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /изменён после подписи: index\.mjs/);
    assert.match(bad.err, /Пакет не принят \(modified\)/);
    assert.equal((await cli('verify', dir)).code, 1, 'без ключей нельзя');
    assert.equal((await cli('verify')).code, 2);
    assert.equal((await cli('keygen')).code, 2);
    assert.equal((await cli('sign', dir, '--key', `${prefix}.key`, '--days', '5', '--expires', '2099-01-01')).code, 2);
    assert.equal((await cli('sign', dir, '--key', `${prefix}.key`, '--days', 'x')).code, 2);
    const dated = await cli('sign', dir, '--key', `${prefix}.key`, '--expires', '2099-01-31');
    assert.equal(dated.code, 0, dated.err);
    assert.match(dated.out, /действует до 2099-01-31T23:59:59\.999Z/);
  });
});
