// Проба упакованной поставки (P-07, docs/05-verification/bundled-delivery.md): стенд упаковывается в app.asar, поставка плагинов (dist/delivery) лежит внутри,
// node-pty распакован (asarUnpack). Упаковщика в репозитории нет - сборку делает этот скрипт из готового Electron и @electron/asar; это проба, а не выпуск приложения.
// TR-07 (docs/research/trust-and-isolation): приложение собирается с фьюзами и сборкой по чек-листу electron/README.md (RunAsNode, NODE_OPTIONS, --inspect выключены; OnlyLoadAppFromAsar; ASAR integrity на macOS),
// и проба проверяет их на упакованном приложении: прочитанные из бинарника фьюзы и поведение (ELECTRON_RUN_AS_NODE, NODE_OPTIONS и --inspect не действуют, подмена app.asar и каталога app отвергнута).
// Запуск: `npm run build && node playground/scripts/pack-delivery.mjs [--no-sandbox] [--keep] [--tamper]`. Нужен дисплей (на Linux - xvfb-run). Код возврата 1, если проверка не прошла.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPackageWithOptions, getRawHeader } from '@electron/asar';
import { connect, repo, sleep, waitFor } from './cdp.mjs';
import { flipFuses, fuseFile, readFuses } from './fuses.mjs';

const args = process.argv.slice(2);
const noSandbox = args.includes('--no-sandbox');
const keep = args.includes('--keep');
// Подмена app.asar при включённой проверке целостности заканчивается намеренным падением приложения (SIGTRAP): на рабочей машине macOS показывает человеку диалог «завершило работу неожиданно».
// Поэтому проверка идёт в CI (переменная CI) или по флагу `--tamper`; локально пропускается с записью в лог.
const tamper = args.includes('--tamper') || process.env.CI !== undefined;
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
const APP_NAME = 'Cyborg Playground.app';
// Исходный Electron (с default_app.asar, всеми фьюзами по умолчанию): принимает путь к приложению первым аргументом и работает как Node; упакованный, с app.asar, этот аргумент игнорирует.
const plainExecutable = join(electronDist, darwin ? join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron');

/** Копия Electron под приложение: каталог ресурсов, исполняемый файл, файл с проводом фьюзов. */
function copyElectron(dir) {
  mkdirSync(dir);
  if (darwin) {
    const bundle = join(dir, APP_NAME);
    execFileSync('cp', ['-R', join(electronDist, 'Electron.app'), bundle]);
    return { bundle, resources: join(bundle, 'Contents', 'Resources'), executable: join(bundle, 'Contents', 'MacOS', 'Electron'), fuses: fuseFile(dir, APP_NAME) };
  }
  cpSync(electronDist, join(dir, 'electron'), { recursive: true });
  return { resources: join(dir, 'electron', 'resources'), executable: join(dir, 'electron', 'electron'), fuses: fuseFile(join(dir, 'electron')) };
}

/**
 * Фьюзы сборки по чек-листу electron/README.md. RunAsNode выключен: приложению ELECTRON_RUN_AS_NODE не нужен (хосты и pty - utilityProcess), а включённый фьюз даёт любому процессу пользователя
 * запустить подписанный бинарник как Node с личностью приложения (доступ к ключу safeStorage в Keychain). `inspect: true` оставляет --inspect: им пользуется сама проба для главного процесса, в `hardened` он выключен.
 */
const checklist = ({ inspect }) => ({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: inspect,
  OnlyLoadAppFromAsar: true,
  EnableCookieEncryption: true,
  // Проверка asar встроена в macOS и Windows; на Linux фьюз не действует, его не трогаем.
  ...(darwin && { EnableEmbeddedAsarIntegrityValidation: true }),
});

/** Хеш заголовка asar для Info.plist (ElectronAsarIntegrity): sha256 строки заголовка, как требует документация Electron. */
const headerHash = (asar) => createHash('sha256').update(getRawHeader(asar).headerString).digest('hex');

/** app.asar, фьюзы, ElectronAsarIntegrity (macOS) и подпись ad hoc (сертификата разработчика в пробе нет). Порядок важен: подпись - после любой правки пакета. */
async function assemble(app, { inspect }) {
  rmSync(join(app.resources, 'default_app.asar'), { force: true });
  await createPackageWithOptions(stage, join(app.resources, 'app.asar'), { unpack: '**/node_modules/node-pty/**' });
  flipFuses(app.fuses, checklist({ inspect }));
  if (darwin) sealMac(app);
}

function sealMac(app) {
  const plist = join(app.bundle, 'Contents', 'Info.plist');
  const buddy = (command) => execFileSync('/usr/libexec/PlistBuddy', ['-c', command, plist], { stdio: 'ignore' });
  try {
    buddy('Delete :ElectronAsarIntegrity');
  } catch {
    // ключа не было: это норма для свежей копии
  }
  buddy('Add :ElectronAsarIntegrity dict');
  buddy('Add :ElectronAsarIntegrity:Resources/app.asar dict');
  buddy('Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256');
  buddy(`Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${headerHash(join(app.resources, 'app.asar'))}`);
  // Подпись ad hoc: проверяется, что asar, распакованный модуль, фьюзы и plist не ломают подпись пакета.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app.bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app.bundle], { stdio: 'inherit' });
}

const appRoot = join(work, 'packed');
const hardenedRoot = join(work, 'hardened');
mkdirSync(appRoot);
mkdirSync(hardenedRoot);
const probeApp = copyElectron(join(appRoot, 'copy'));
const { resources, executable } = probeApp;
await assemble(probeApp, { inspect: true });
// Вторая копия - та же сборка со всеми фьюзами чек-листа, включая --inspect: на ней проверяются фьюзы (проба запускает первую с --inspect=0, чтобы читать главный процесс).
const hardened = copyElectron(join(hardenedRoot, 'copy'));
await assemble(hardened, { inspect: false });
log(`app.asar: ${readdirSync(resources).filter((n) => n.startsWith('app')).join(', ')}`);
if (darwin) log('codesign --verify --deep --strict: подпись ad hoc цела (asar, фьюзы и ElectronAsarIntegrity внутри)');

// node-pty лежит в asarUnpack: модуль грузится из asar, а нативный .node ядро берёт из app.asar.unpacked. Проверяет отдельный процесс Electron в режиме Node
// (ELECTRON_RUN_AS_NODE: asar читается, окна нет): настоящий spawn в pty. Упакованному приложению режим Node выключен фьюзом (RunAsNode), поэтому процесс - исходный Electron из node_modules
// с ресурсами упакованного: проверяется упаковка, а не бинарник. В главный процесс приложения проба `node-pty` не грузит - там его нет, pty живёт в pty-хосте.
{
  const unpackedModule = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node');
  assert.ok(existsSync(unpackedModule), `нет ${unpackedModule}`);
  const code = "const pty = require(process.argv[1]).spawn('/bin/echo', ['из-asar'], {}); let out = ''; pty.onData((d) => (out += d)); pty.onExit(() => { process.stdout.write(out); process.exit(0); });";
  const out = execFileSync(plainExecutable, ['-e', code, join(resources, 'app.asar', 'node_modules', 'node-pty')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 });
  assert.match(out, /из-asar/, 'pty из упакованного приложения не отдал вывод');
  log(`node-pty из app.asar: spawn в pty отдал «${out.trim()}», pty.node распакован: ${unpackedModule.slice(unpackedModule.indexOf('app.asar.unpacked'))}`);
}

const sockets = [];
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
    // Слушатель вместо диалога Electron «Uncaught Exception»: ошибки копятся, и проба их проверяет после сценария (диалог человеку не показывается).
    await main("globalThis.__packErrors = []; for (const e of ['uncaughtException', 'unhandledRejection']) process.on(e, (x) => globalThis.__packErrors.push(String((x && x.stack) || x))); 0");
    log(`${name}: приложение запущено`);
    await scenario({ ev, main, stderr: () => stderr });
    // Необработанное исключение главного процесса Electron показывает человеку диалог; проба не должна его вызывать ни своим кодом, ни кодом приложения.
    const thrown = JSON.parse(await main('JSON.stringify(globalThis.__packErrors)'));
    assert.deepEqual(thrown, [], `${name}: главный процесс получил необработанное исключение: ${thrown.join(' | ')}`);
  } finally {
    for (const socket of sockets.splice(0)) socket.close();
    app.kill('SIGTERM');
    await Promise.race([new Promise((r) => app.once('exit', r)), sleep(8000)]);
    if (app.exitCode === null) app.kill('SIGKILL');
    // Остатки (хосты, рендереры) с этим каталогом данных в командной строке: ни одного окна не остаётся.
    try {
      execFileSync('pkill', ['-9', '-f', userData], { stdio: 'ignore' });
    } catch {
      // pkill возвращает 1, когда убивать некого: это норма
    }
    rmSync(userData, { recursive: true, force: true });
  }
}

const expected = Object.keys(JSON.parse(readFileSync(join(dist, 'delivery', 'delivery.json'), 'utf8')).plugins).sort();
const rows = (ev) => ev(`[...document.querySelectorAll('#plugins-list [data-plugin]')].map((r) => ({ id: r.dataset.plugin, state: r.dataset.state, origin: r.dataset.origin, host: r.querySelector('.plugin-host')?.textContent ?? '' }))`);

/** Запуск упакованного приложения без инспектора пробы: ждём порт DevTools (окно поднялось) или выход, даём секунду-другую на поздний вывод, закрываем. */
async function startApp(app, { env = {}, args = [], wait = 30_000 } = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'cyborg-pack-fuses-'));
  const child = spawn(app.executable, [`--user-data-dir=${userData}`, '--remote-debugging-port=0', '--delivery', ...(noSandbox ? ['--no-sandbox'] : []), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  let exited = null;
  const done = new Promise((r) => child.once('exit', (code, signal) => r((exited = { code, signal }))));
  const deadline = Date.now() + wait;
  while (Date.now() < deadline && exited === null && !/DevTools listening/.test(stderr)) await sleep(150);
  const up = /DevTools listening/.test(stderr);
  if (up) await sleep(1500);
  const quitEarly = exited;
  child.kill('SIGTERM');
  await Promise.race([done, sleep(6000)]);
  if (exited === null) child.kill('SIGKILL');
  try {
    execFileSync('pkill', ['-9', '-f', userData], { stdio: 'ignore' });
  } catch {
    // pkill возвращает 1, когда убивать некого
  }
  rmSync(userData, { recursive: true, force: true });
  return { up, quitEarly, stderr };
}

/** Фьюзы упакованного приложения: состояние из бинарника и поведение (TR-07). Копия `hardened` разрушается по ходу (подмена asar, каталог app), поэтому проверки идут по порядку. */
async function fuseChecks() {
  const expected = (inspect) => Object.fromEntries(Object.entries(checklist({ inspect })).map(([name, on]) => [name, on ? 'on' : 'off']));
  for (const [label, app, inspect] of [['рабочая копия пробы', probeApp, true], ['копия по чек-листу', hardened, false]]) {
    const state = readFuses(app.fuses);
    for (const [name, want] of Object.entries(expected(inspect))) assert.equal(state[name], want, `${label}: фьюз ${name} - ${state[name]}, ждали ${want}`);
    log(`фьюзы (${label}): ${Object.entries(expected(inspect)).map(([name, want]) => `${name}=${want}`).join(', ')}`);
  }
  // RunAsNode: под ELECTRON_RUN_AS_NODE бинарник с включённым фьюзом становится Node, не разбирает флаги приложения (`--user-data-dir`: bad option) и окна не открывает; без фьюза переменная
  // не действует, и приложение поднимается как обычно. Исходный Electron - контроль (фьюз включён по умолчанию).
  const asNode = { ELECTRON_RUN_AS_NODE: '1' };
  const control = await startApp({ executable: plainExecutable }, { env: asNode, wait: 10_000 });
  assert.ok(!control.up, 'контроль: у исходного Electron ELECTRON_RUN_AS_NODE должен переводить его в режим Node, а не поднимать окно');
  const packed = await startApp(hardened, { env: asNode });
  assert.ok(packed.up, `RunAsNode выключен, а упакованное приложение под ELECTRON_RUN_AS_NODE не поднялось: ${packed.stderr.slice(0, 300)}`);
  log(`RunAsNode: исходный Electron под ELECTRON_RUN_AS_NODE стал Node (${control.quitEarly === null ? 'окна нет' : `выход с кодом ${String(control.quitEarly.code)}`}), упакованное приложение - поднялось как приложение`);
  // NODE_OPTIONS: --require из переменной окружения не исполняется упакованным приложением, у исходного Electron (контроль) исполняется.
  const markers = mkdtempSync(join(tmpdir(), 'cyborg-pack-markers-'));
  const marker = (name) => {
    const file = join(markers, `${name}.cjs`);
    writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(join(markers, `${name}.ran`))}, 'выполнено');\n`);
    return { env: { NODE_OPTIONS: `--require=${file}` }, ran: () => existsSync(join(markers, `${name}.ran`)) };
  };
  const nodeControl = marker('control');
  execFileSync(plainExecutable, ['-p', '1'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...nodeControl.env }, stdio: 'ignore', timeout: 20_000 });
  assert.ok(nodeControl.ran(), 'контроль: NODE_OPTIONS=--require у исходного Electron должен исполняться');
  const options = marker('options');
  const base = await startApp(hardened, { env: options.env });
  assert.ok(base.up, `упакованное приложение по чек-листу не поднялось: ${base.stderr.slice(0, 400)}`);
  assert.ok(!options.ran(), 'NODE_OPTIONS=--require исполнен упакованным приложением');
  log('EnableNodeOptionsEnvironmentVariable: NODE_OPTIONS=--require исходным Electron исполняется, упакованным приложением - нет; приложение с фьюзами поднялось и открыло DevTools');
  // --inspect: в копии по чек-листу флаг молча игнорируется, в рабочей копии пробы (фьюз включён) отладчик слушает порт.
  const closed = await startApp(hardened, { args: ['--inspect=0'] });
  const open = await startApp(probeApp, { args: ['--inspect=0'] });
  assert.ok(open.up && /Debugger listening on ws:/.test(open.stderr), `контроль: при включённом фьюзе --inspect=0 должен открыть отладчик: ${open.stderr.slice(0, 300)}`);
  assert.ok(closed.up && !/Debugger listening/.test(closed.stderr), `--inspect=0 открыл отладчик в приложении по чек-листу: ${closed.stderr.slice(0, 300)}`);
  log('EnableNodeCliInspectArguments: --inspect=0 при включённом фьюзе открывает отладчик, в приложении по чек-листу - нет');
  // Подмена кода приложения при записи в Resources (нужен доступ пользователя к каталогу приложения): isolate по ASAR integrity и OnlyLoadAppFromAsar.
  const asar = join(hardened.resources, 'app.asar');
  if (darwin && !tamper) {
    log('ASAR integrity (macOS): проверка подмены app.asar пропущена - приложение падает намеренно, и macOS показывает диалог о сбое; запуск: --tamper или CI=1');
  } else if (darwin) {
    const tampered = join(work, 'tampered');
    cpSync(stage, tampered, { recursive: true });
    writeFileSync(join(tampered, 'main.js'), `${readFileSync(join(stage, 'main.js'), 'utf8')}\n// подмена после сборки\n`);
    await createPackageWithOptions(tampered, asar, { unpack: '**/node_modules/node-pty/**' });
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', hardened.bundle], { stdio: 'ignore' });
    const result = await startApp(hardened, { wait: 15_000 });
    assert.ok(!result.up, 'приложение с подменённым app.asar поднялось: проверка целостности asar не сработала');
    log(`ASAR integrity (macOS): app.asar подменён при неизменном ElectronAsarIntegrity (подпись пакета пересобрана) - приложение не поднялось (${result.quitEarly === null ? 'не открыло DevTools' : `завершилось: код ${String(result.quitEarly?.code)}, сигнал ${String(result.quitEarly?.signal)}`})`);
  } else {
    log('ASAR integrity: на Linux Electron проверку asar не делает (macOS и Windows); защита от подмены - права на каталог приложения и OnlyLoadAppFromAsar');
  }
  rmSync(asar, { force: true });
  const loose = join(hardened.resources, 'app');
  mkdirSync(loose);
  const looseMarker = marker('loose');
  const looseCode = `require('node:fs').writeFileSync(${JSON.stringify(join(markers, 'loose.ran'))}, 'выполнено'); require('electron').app.quit();\n`;
  writeFileSync(join(loose, 'package.json'), JSON.stringify({ name: 'loose', main: 'main.js' }));
  writeFileSync(join(loose, 'main.js'), looseCode);
  const control2 = mkdtempSync(join(tmpdir(), 'cyborg-pack-loose-'));
  writeFileSync(join(control2, 'package.json'), JSON.stringify({ name: 'loose', main: 'main.js' }));
  writeFileSync(join(control2, 'main.js'), looseCode);
  const controlRun = await startApp({ executable: plainExecutable }, { args: [control2], wait: 20_000 });
  assert.ok(looseMarker.ran(), `контроль: каталог app у исходного Electron должен исполняться: ${controlRun.stderr.slice(0, 300)}`);
  rmSync(join(markers, 'loose.ran'));
  if (darwin) execFileSync('codesign', ['--force', '--deep', '--sign', '-', hardened.bundle], { stdio: 'ignore' });
  await startApp(hardened, { wait: 15_000 });
  assert.ok(!looseMarker.ran(), 'OnlyLoadAppFromAsar: приложение исполнило код из каталога app при отсутствии app.asar');
  log('OnlyLoadAppFromAsar: без app.asar каталог resources/app не исполняется (у исходного Electron исполняется)');
  rmSync(markers, { recursive: true, force: true });
  rmSync(control2, { recursive: true, force: true });
}

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
  await fuseChecks();
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
