// TR-22b (ADR-CH-0019, п. 6): запускатель Linux `cyborg-confine` на настоящем ядре, без хоста плагинов: Node под запускателем пробует то, что слои закрывают.
// Не идёт на macOS и без собранного запускателя (`npm run build:confiner`); в CI собирается на Ubuntu 22.04 и 24.04, версия ABI Landlock и ядро печатаются в начале.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir, release } from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { landlockConfiner, parseProbe, type LandlockProbe } from '../src/confiner-landlock.ts';

const binary = fileURLToPath(new URL(`../native/build/${process.platform}-${process.arch}/cyborg-confine`, import.meta.url));
const skip = process.platform !== 'linux' ? 'только Linux' : !existsSync(binary) ? 'запускатель не собран (npm run build:confiner)' : false;
const NODE = realpathSync(process.execPath);

/** Что код пробует внутри запущенного под запускателем Node; каждый ответ - код ошибки или «выполнено». */
const SCRIPT = `
import fs from 'node:fs'; import net from 'node:net'; import dgram from 'node:dgram'; import cp from 'node:child_process'; import { Worker } from 'node:worker_threads';
const t = (f) => { try { f(); return 'выполнено'; } catch (e) { return e.code ?? e.name; } };
const listen = (open) => new Promise((resolve) => { const timer = setTimeout(() => resolve('таймаут'), 2000); open((r) => { clearTimeout(timer); resolve(r); }); });
const tcpListen = () => listen((done) => { const s = net.createServer(); s.once('error', (e) => done(e.code)); s.listen(0, '127.0.0.1', () => { s.close(); done('выполнено'); }); });
const udpBind = () => listen((done) => { const s = dgram.createSocket('udp4'); s.once('error', (e) => done(e.code)); s.bind(0, '127.0.0.1', () => { s.close(); done('выполнено'); }); });
const unixConnect = () => listen((done) => { const s = net.connect('/run/dbus/system_bus_socket'); s.once('error', (e) => done(e.code)); s.once('connect', () => { s.destroy(); done('выполнено'); }); });
const status = fs.readFileSync('/proc/self/status', 'utf8');
const own = process.argv[2];
const worker = await listen((done) => { const w = new Worker('0', { eval: true }); w.once('exit', () => done('выполнено')); w.once('error', (e) => done(e.code ?? e.name)); });
console.log(JSON.stringify({
  ownRead: t(() => fs.readFileSync(own + '/data.txt')),
  readOutside: t(() => fs.readFileSync('/etc/passwd')),
  listRoot: t(() => fs.readdirSync('/')),
  write: t(() => fs.writeFileSync('/tmp/cyborg-confine-write', 'x')),
  writeOwn: t(() => fs.writeFileSync(own + '/new.txt', 'x')),
  spawn: t(() => { const r = cp.spawnSync('/bin/echo', ['x']); if (r.error) throw r.error; }),
  tcp: await tcpListen(), udp: await udpBind(), unix: await unixConnect(), worker,
  noNewPrivs: /NoNewPrivs:\\s+1/.test(status), seccomp: /Seccomp:\\s+2/.test(status),
}));
`;

interface Outcome {
  ownRead: string;
  readOutside: string;
  listRoot: string;
  write: string;
  writeOwn: string;
  spawn: string;
  tcp: string;
  udp: string;
  unix: string;
  worker: string;
  noNewPrivs: boolean;
  seccomp: boolean;
}

describe('ST-3010/7: TR-22b: cyborg-confine на настоящем ядре Linux', { skip }, () => {
  let probe: LandlockProbe;
  let dir: string;
  before(() => {
    const parsed = parseProbe(execFileSync(binary, ['--probe'], { encoding: 'utf8' }));
    assert.ok(parsed, '--probe отвечает JSON нужной формы');
    probe = parsed;
    // Версия ядра и ABI Landlock - в вывод прогона: «проверено на ядре X, ABI N» должно быть видно из лога CI.
    process.stderr.write(`# uname -r: ${release()}; Landlock ABI ${String(probe.abi)}; seccomp ${String(probe.seccomp)}; ${probe.arch}\n`);
    dir = mkdtempSync(path.join(tmpdir(), 'cyborg-confine-'));
    writeFileSync(path.join(dir, 'data.txt'), 'свой файл');
    writeFileSync(path.join(dir, 'probe.mjs'), SCRIPT);
  });

  /** Скрипт под запускателем; `extra` - флаги запускателя (например, `--no-seccomp`). */
  const run = (extra: readonly string[] = []): Outcome => {
    const { command, args } = landlockConfiner(binary).wrap({ command: NODE, args: [path.join(dir, 'probe.mjs'), dir] }, { read: [dir], exec: [NODE] });
    const split = args.indexOf('--');
    const result = spawnSync(command, [...args.slice(0, split), ...extra, ...args.slice(split)], { encoding: 'utf8', env: {}, timeout: 30_000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout) as Outcome;
  };

  test('--probe: ABI Landlock, seccomp, архитектура и ядро', () => {
    assert.equal(typeof probe.abi, 'number');
    assert.equal(probe.seccomp, true);
    assert.equal(probe.kernel, release());
    assert.match(probe.arch, /^(x86_64|aarch64)$/);
  });

  test('no_new_privs и seccomp наложены; сокеты не создаются (TCP, UDP, unix-сокет по пути), fork закрыт, потоки работают', () => {
    const o = run();
    assert.equal(o.noNewPrivs, true);
    assert.equal(o.seccomp, true);
    assert.deepEqual([o.tcp, o.udp, o.unix], ['EPERM', 'EPERM', 'EPERM'], 'сеть и сокеты по пути закрыты seccomp на любом ядре');
    assert.equal(o.spawn, 'EPERM', 'fork отказан');
    assert.equal(o.worker, 'выполнено', 'clone с CLONE_THREAD разрешён: потоки V8 и libuv живы');
  });

  test('Landlock: свой каталог читается; вне названного читать, листать и писать нельзя; свой каталог тоже не пишется', (t) => {
    if (probe.abi < 1) {
      t.skip(`ядро ${probe.kernel} без Landlock (ABI 0): файлы держат только запреты Node, запускатель честно об этом говорит в --probe`);
      return;
    }
    const o = run();
    assert.equal(o.ownRead, 'выполнено');
    assert.deepEqual([o.readOutside, o.listRoot, o.write, o.writeOwn], ['EACCES', 'EACCES', 'EACCES', 'EACCES']);
  });

  test('Landlock сам (без seccomp): исполнение чужой программы отказано; TCP закрыт с ABI 4 (ядро 6.7), до него открыт - поэтому сеть держит seccomp', (t) => {
    if (probe.abi < 1) {
      t.skip('нет Landlock');
      return;
    }
    const o = run(['--no-seccomp']);
    assert.equal(o.spawn, 'EACCES', 'EXECUTE разрешён только Node и системным библиотекам; fork без seccomp возможен, а запуск /bin/echo - нет');
    assert.equal(o.udp, 'выполнено', 'UDP Landlock не видит ни в одном ABI: его закрывает только seccomp');
    if (probe.abi >= 4) assert.equal(o.tcp, 'EACCES', `ABI ${String(probe.abi)}: bind TCP отказан Landlock`);
    else assert.equal(o.tcp, 'выполнено', `ABI ${String(probe.abi)} (< 4): правил TCP нет, без seccomp сеть открыта`);
  });

  test('--require-landlock на ядре без Landlock отказывает кодом 4, а не запускает без файловой защиты', (t) => {
    if (probe.abi >= 1) {
      t.skip(`ядро ${probe.kernel} с Landlock: отказ проверить нельзя`);
      return;
    }
    const r = spawnSync(binary, ['--require-landlock', '--', '/bin/true'], { encoding: 'utf8' });
    assert.equal(r.status, 4);
  });

  test('неверные аргументы и отсутствующая команда: код 2 и 127, сообщение словами', () => {
    assert.equal(spawnSync(binary, ['--нет-такого', '--', '/bin/true'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(binary, ['--read=/tmp'], { encoding: 'utf8' }).status, 2);
    const r = spawnSync(binary, ['--', '/нет/такой/программы'], { encoding: 'utf8' });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /cyborg-confine: \/нет\/такой\/программы/);
  });
});
