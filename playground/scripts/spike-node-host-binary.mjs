// Спайк TR-20, пункт 3: RunAsNode против отдельного бинарника Node - размер, подпись, поведение фьюза (docs/05-verification/spike-node-host.md).
// Копия Electron из node_modules кладётся во временный каталог; фьюзы переключаются своим кодом (fuses.mjs), на macOS копия подписывается ad hoc.
// Запуск: node playground/scripts/spike-node-host-binary.mjs [--json] [--node-bin=<node>] [--keep]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fuseFile, readFuses, flipFuses } from './fuses.mjs';

const darwin = process.platform === 'darwin';
const electronDist = join(dirname(createRequire(import.meta.url).resolve('electron')), 'dist');
const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

function sizeOf(path) {
  return mb(Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split('\t')[0]) * 1024);
}

/** Запуск с ограничением по времени: вывод и признак «не вышел сам» (приложение вместо Node остаётся жить). */
function run(binary, args, env, ms = 8000) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ out: out.trim(), timedOut: true });
    }, ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ out: out.trim(), code, timedOut: false });
    });
  });
}

const signature = (path) => {
  if (!darwin) return 'не macOS: подпись бинарников Linux вне охвата';
  // codesign пишет описание подписи в stderr.
  const r = spawnSync('codesign', ['-dv', '--verbose=2', path], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
};
const pick = (text, ...keys) =>
  text
    .split('\n')
    .filter((line) => keys.some((key) => line.startsWith(key)))
    .join('; ');

export async function binaryFacts({ nodeBin = process.execPath, keep = false } = {}) {
  const facts = { platform: process.platform, arch: process.arch, electron: createRequire(import.meta.url)('electron/package.json').version };
  const executable = darwin ? join(electronDist, 'Electron.app', 'Contents', 'MacOS', 'Electron') : join(electronDist, 'electron');
  facts.sizes = {
    electronAppMb: sizeOf(darwin ? join(electronDist, 'Electron.app') : electronDist),
    electronExecutableKb: Math.round(statSync(executable).size / 1024),
    electronFuseFileMb: mb(statSync(fuseFile(electronDist)).size),
    nodeBinaryMb: mb(statSync(nodeBin).size),
    nodeBinary: nodeBin,
  };
  facts.signatures = {
    electron: pick(signature(darwin ? join(electronDist, 'Electron.app') : executable), 'Signature', 'CodeDirectory', 'Authority', 'TeamIdentifier', 'flags'),
    node: pick(signature(nodeBin), 'Signature', 'CodeDirectory', 'Authority', 'TeamIdentifier', 'Runtime'),
  };
  facts.fusesDefault = readFuses(fuseFile(electronDist));
  const env = { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' };
  facts.runAsNodeOn = await run(executable, ['-p', 'process.versions.node + " " + String(process.versions.electron)'], env);

  // Копия Electron с выключенным RunAsNode: фьюз лежит в бинарнике (macOS - во фреймворке), после правки подпись macOS недействительна и ставится заново.
  const work = mkdtempSync(join(tmpdir(), 'cyborg-spike-fuse-'));
  try {
    const copy = join(work, 'dist');
    if (darwin) execFileSync('cp', ['-R', electronDist, copy]);
    else cpSync(electronDist, copy, { recursive: true });
    flipFuses(fuseFile(copy), { RunAsNode: false });
    if (darwin) execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(copy, 'Electron.app')], { stdio: 'ignore' });
    const flipped = darwin ? join(copy, 'Electron.app', 'Contents', 'MacOS', 'Electron') : join(copy, 'electron');
    facts.fusesFlipped = readFuses(fuseFile(copy));
    // С фьюзом `--version` под ELECTRON_RUN_AS_NODE печатает версию Node, без него - версию Electron (флаг разбирает уже приложение, а не Node).
    facts.versionRunAsNodeOn = (await run(executable, ['--version'], env)).out;
    facts.versionRunAsNodeOff = (await run(flipped, ['--version'], env)).out;
    // Хост плагинов через fork на выключенном фьюзе: ELECTRON_RUN_AS_NODE не действует, `-p` не выполняется, приложение стартует как приложение.
    facts.evalRunAsNodeOff = await run(flipped, ['-p', '"выполнено как Node"'], env, 6000);
    const hostFile = join(work, 'host.mjs');
    writeFileSync(hostFile, "process.send({ node: process.versions.node, electron: process.versions.electron, processType: process.type ?? 'node', electronApi: typeof process.versions.chrome }); process.exit(0);\n");
    const { fork } = await import('node:child_process');
    facts.forkRunAsNodeOff = await new Promise((resolve) => {
      const child = fork(hostFile, [], { execPath: flipped, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('хост не ответил за 8 с (бинарник запустился как приложение, а не как Node)');
      }, 8000);
      child.once('message', (m) => {
        clearTimeout(timer);
        resolve(`ответил: ${JSON.stringify(m)}`);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(`вышел с кодом ${String(code)} без ответа`);
      });
    });
    facts.forkRunAsNodeOn = await new Promise((resolve) => {
      const child = fork(hostFile, [], { execPath: executable, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('хост не ответил за 8 с');
      }, 8000);
      child.once('message', (m) => {
        clearTimeout(timer);
        resolve(`ответил: ${JSON.stringify(m)}`);
      });
    });
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
  return facts;
}

if (process.argv[1] === import.meta.filename) {
  const argv = process.argv.slice(2);
  const facts = await binaryFacts({ nodeBin: argv.find((a) => a.startsWith('--node-bin='))?.slice('--node-bin='.length) ?? process.execPath, keep: argv.includes('--keep') });
  console.log(JSON.stringify(facts, null, 2));
}
