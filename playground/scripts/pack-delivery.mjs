// Проба упакованной поставки (P-07, docs/05-verification/bundled-delivery.md): стенд упаковывается в app.asar, поставка плагинов (dist/delivery) лежит внутри,
// node-pty распакован (asarUnpack). Упаковщика в репозитории нет - сборку делает этот скрипт из готового Electron и @electron/asar; это проба, а не выпуск приложения.
// Запуск: `npm run build && node playground/scripts/pack-delivery.mjs [--no-sandbox] [--keep]`. Нужен дисплей (на Linux - xvfb-run). Код возврата 1, если проверка не прошла.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackageWithOptions } from '@electron/asar';
import { connect, repo, sleep, waitFor } from './cdp.mjs';

const args = process.argv.slice(2);
const noSandbox = args.includes('--no-sandbox');
const keep = args.includes('--keep');
const dist = join(repo, 'playground', 'dist');
const log = (text) => console.log(`pack-delivery: ${text}`);
assert.ok(existsSync(join(dist, 'delivery', 'delivery.json')), 'нет playground/dist/delivery: сначала npm run build');

const work = mkdtempSync(join(tmpdir(), 'cyborg-pack-'));
const stage = join(work, 'app');
mkdirSync(join(stage, 'node_modules'), { recursive: true });
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'cyborg-playground-packed', version: '0.0.0', main: 'main.js' }));
for (const name of ['main.js', 'plugin-host.mjs', 'pty-host.js', 'preload.js']) cpSync(join(dist, name), join(stage, name));
cpSync(join(dist, 'renderer'), join(stage, 'renderer'), { recursive: true });
cpSync(join(dist, 'delivery'), join(stage, 'delivery'), { recursive: true });
// Нативный модуль не читается из asar: node-pty едет рядом, в app.asar.unpacked (asarUnpack).
cpSync(join(repo, 'node_modules', 'node-pty'), join(stage, 'node_modules', 'node-pty'), { recursive: true });
rmSync(join(stage, 'node_modules', 'node-pty', 'deps'), { recursive: true, force: true });
rmSync(join(stage, 'node_modules', 'node-pty', 'build', 'Release', 'obj.target'), { recursive: true, force: true });

const darwin = process.platform === 'darwin';
const electronDist = join(repo, 'node_modules', 'electron', 'dist');
const appRoot = join(work, 'packed');
mkdirSync(appRoot);
let resources;
let executable;
if (darwin) {
  const bundle = join(appRoot, 'Cyborg Playground.app');
  execFileSync('cp', ['-R', join(electronDist, 'Electron.app'), bundle]);
  resources = join(bundle, 'Contents', 'Resources');
  executable = join(bundle, 'Contents', 'MacOS', 'Electron');
} else {
  cpSync(electronDist, join(appRoot, 'electron'), { recursive: true });
  resources = join(appRoot, 'electron', 'resources');
  executable = join(appRoot, 'electron', 'electron');
}
rmSync(join(resources, 'default_app.asar'), { force: true });
await createPackageWithOptions(stage, join(resources, 'app.asar'), { unpack: '**/node_modules/node-pty/**' });
log(`app.asar: ${readdirSync(resources).filter((n) => n.startsWith('app')).join(', ')}`);
if (darwin) {
  // Подпись ad hoc: сертификата разработчика (Developer ID) в пробе нет; проверяется, что asar и распакованный модуль не ломают подпись пакета.
  const bundle = join(appRoot, 'Cyborg Playground.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  log('codesign --verify --deep --strict: подпись ad hoc цела');
}

const sockets = [];
// Исходный Electron (с default_app.asar) принимает путь к приложению первым аргументом; упакованный, с app.asar, этот аргумент игнорирует.
const plainExecutable = join(electronDist, darwin ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron');
async function run(name, { plugins = {}, app: appDir, scenario }) {
  const userData = mkdtempSync(join(tmpdir(), 'cyborg-pack-data-'));
  for (const [id, files] of Object.entries(plugins)) {
    mkdirSync(join(userData, 'plugins', id), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(userData, 'plugins', id, file), text);
  }
  const flags = [...(appDir === undefined ? [] : [appDir]), '--inspect=0', `--user-data-dir=${userData}`, '--remote-debugging-port=0', '--delivery', '--user-plugins', ...(noSandbox ? ['--no-sandbox'] : [])];
  const app = spawn(appDir === undefined ? executable : plainExecutable, flags, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  app.stderr.on('data', (d) => (stderr += d));
  try {
    const port = await waitFor('порт DevTools', () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1], 40_000);
    const page = await waitFor('окно', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'));
    const ev = await connect(page.webSocketDebuggerUrl, sockets);
    const main = await connect(await waitFor('инспектор главного процесса', () => /Debugger listening on (ws:\/\/\S+)/.exec(stderr)?.[1]), sockets);
    log(`${name}: приложение запущено`);
    await scenario({ ev, main, stderr: () => stderr });
  } finally {
    for (const socket of sockets.splice(0)) socket.close();
    app.kill('SIGTERM');
    await Promise.race([new Promise((r) => app.once('exit', r)), sleep(8000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
    rmSync(userData, { recursive: true, force: true });
  }
}

const expected = Object.keys(JSON.parse(readFileSync(join(dist, 'delivery', 'delivery.json'), 'utf8')).plugins).sort();
const rows = (ev) => ev(`[...document.querySelectorAll('#plugins-list [data-plugin]')].map((r) => ({ id: r.dataset.plugin, state: r.dataset.state, origin: r.dataset.origin, host: r.querySelector('.plugin-host')?.textContent ?? '' }))`);

let failed = false;
try {
  await run('поставка в asar', {
    scenario: async ({ ev, main }) => {
      const where = await main('JSON.stringify({ main: process.mainModule.filename, resources: process.resourcesPath, packed: process.mainModule.filename.includes("app.asar") })');
      log(`главный процесс: ${where}`);
      assert.ok(JSON.parse(where).packed, 'приложение запущено не из asar');
      // Ожидаемое состояние стенда (smoke.mjs): ленивый «later» ждёт первого обращения, демо «flaky» всегда падает при запуске (его причина - код плагина, а значит код исполнен из asar).
      const wanted = (x) => (x.id === 'flaky' ? x.state === 'stopped' : x.id === 'later' ? x.state === 'waiting' || x.state === 'active' : x.state === 'active');
      const list = await waitFor('все плагины поставки в ожидаемом состоянии', async () => {
        const r = await rows(ev);
        return r.length === expected.length && r.every(wanted) ? r : null;
      }, 40_000);
      const reason = await ev("document.querySelector('#plugins-list [data-plugin=flaky] .plugin-reason')?.textContent ?? ''");
      assert.match(reason, /всегда падает/, 'причина flaky не из кода плагина');
      assert.deepEqual(list.map((r) => r.id).sort(), expected, 'каталог поставки и строки окна различаются');
      assert.ok(list.every((r) => r.origin === 'bundled'), 'не все плагины помечены встроенными');
      for (const r of list) log(`  ${r.id}: ${r.state} ${r.host}`);
      const problems = await ev("document.getElementById('plugins-problems').textContent");
      assert.equal(problems, '', `«Не дошло до ядра» не пусто: ${problems}`);
    },
  });
  await run('подмена встроенного из каталога пользователя', {
    plugins: { echo: { 'manifest.json': JSON.stringify({ id: 'echo', version: '9.9.9', engines: { cyborg: '^1' } }), 'index.mjs': 'export default { activate(ctx) { ctx.log("ПОДМЕНА выполнена"); } };\n' } },
    scenario: async ({ ev, stderr }) => {
      const list = await waitFor('echo получил состояние', async () => (await rows(ev)).find((r) => r.id === 'echo' && r.state === 'active'), 40_000);
      assert.equal(list.origin, 'bundled', 'echo не встроенный');
      const problems = await waitFor('жалоба на повтор id', async () => /повтор id echo/.test(await ev("document.getElementById('plugins-problems').textContent")), 10_000);
      assert.ok(problems);
      assert.ok(!stderr().includes('ПОДМЕНА выполнена'), 'код подмены выполнен');
      log('  echo: bundled, active; подмена отвергнута, её код не выполнялся');
    },
  });
  // Изменённый файл поставки: asar не дописать, поэтому поставка из той же подготовленной папки приложения, не упакованной (запуск исходным Electron: упакованный путь к приложению не принимает); сборка не отказывает, расхождение видно в окне.
  writeFileSync(join(stage, 'delivery', 'echo', 'index.mjs'), `${readFileSync(join(stage, 'delivery', 'echo', 'index.mjs'), 'utf8')}\n// изменено после сборки поставки\n`);
  await run('изменён файл поставки (папка приложения без asar)', {
    app: stage,
    scenario: async ({ ev }) => {
      await waitFor('echo активен', async () => (await rows(ev)).some((r) => r.id === 'echo' && r.state === 'active'), 40_000);
      const text = await waitFor('жалоба на сумму', async () => {
        const t = await ev("document.getElementById('plugins-problems').textContent");
        return /контрольная сумма поставки: echo\/index\.mjs/.test(t) ? t : null;
      }, 10_000);
      log(`  «Не дошло до ядра»: ${text.replaceAll('\n', ' | ')}`);
    },
  });
  log('ПРОЙДЕНО');
} catch (error) {
  failed = true;
  console.error(`pack-delivery: ПРОВАЛ: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  if (keep) log(`собранное оставлено: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
